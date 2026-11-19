"""Beats, downbeats, tempo, and time signature."""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import numpy as np

MODELS_DIR = Path(__file__).resolve().parents[2] / "models"


def _beat_this(path: str, device: str):
    import torch
    from beat_this.inference import File2Beats

    # Prefer a local checkpoint (offline use); otherwise beat_this downloads it once.
    local = MODELS_DIR / "beat_this-final0.ckpt"
    cached = Path(torch.hub.get_dir()) / "checkpoints" / "beat_this-final0.ckpt"
    ckpt = str(local) if local.exists() else (str(cached) if cached.exists() else "final0")
    f2b = File2Beats(checkpoint_path=ckpt, device=device, dbn=False)
    return f2b(path)


def track_beats(path: str, device: str = "cpu", attack_paths=None) -> dict:
    """Beat + downbeat tracking.

    Uses beat_this (CPJKU, MIT code and weights) when its weights are available.
    Falls back to librosa (beats only); downbeats are then estimated later from chord changes.
    """
    note = None
    try:
        beats, downbeats = _beat_this(path, device)
        method = "beat_this"
    except Exception as e:  # missing package, offline weights server, GPU issue...
        import librosa

        y, sr = librosa.load(path, sr=22050, mono=True)
        _, frames = librosa.beat.beat_track(y=y, sr=sr, units="frames")
        beats = librosa.frames_to_time(frames, sr=sr)
        downbeats = np.array([])
        method = "librosa"
        note = "The better beat finder could not be loaded (its model file is not downloaded), so a simpler one was used. Bar starts are estimated."
    beats = np.asarray(beats, dtype=float)
    downbeats = np.asarray(downbeats, dtype=float)
    beats, shift_ms = refine_to_onsets(attack_paths or path, beats)
    if len(downbeats):
        downbeats = downbeats + shift_ms / 1000.0  # bar starts move with the beats
    half = None
    if method == "librosa":
        half = half_time_check(path, beats, attack_paths)
        if half["likely"]:
            out_fast = beats  # the pipeline picks the final half-time phase from chord changes
            beats = half["beats"]
            note = (note or "") + f" The beat finder counted about {half['fast_bpm']:.0f} BPM; the pulse repeats every second beat, so the click uses half time (~{half['slow_bpm']:.0f} BPM). If the click now feels too slow, set Feel to Double."
    out = summarize(beats, downbeats, method)
    out["onset_shift_ms"] = shift_ms
    if half and half["likely"]:
        out["beats_fast"] = [round(float(b), 3) for b in out_fast]
    if half:
        out["half_time"] = {k: v for k, v in half.items() if k != "beats"}
    if note:
        out["note"] = note.strip()
    return out


def _onset_env(path: str, hop: int = 128):
    import librosa

    y, sr = librosa.load(path, sr=22050, mono=True)
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    return env, sr / hop


def _attack_env(path, sr: int = 22050, hop_s: float = 0.002):
    """Rate of rise of 2-8 kHz energy, 2 ms steps. Peaks AT a strum or pick attack, not after it.

    (librosa's onset_strength uses 93 ms centred frames and peaked ~32 ms late on the benchmark.)
    """
    import librosa
    from scipy.signal import butter, sosfiltfilt

    # `path` may be one file or several (summed). Use instrument stems when possible:
    # on the full mix, vocal consonants dominate 2-8 kHz and land ~100 ms after the beat.
    paths = [path] if isinstance(path, (str, bytes)) or hasattr(path, "__fspath__") else list(path)
    ys = [librosa.load(str(p), sr=sr, mono=True)[0] for p in paths]
    n_min = min(len(v) for v in ys)
    y = np.sum([v[:n_min] for v in ys], axis=0)
    sos = butter(4, [2000, 8000], btype="bandpass", fs=sr, output="sos")
    band = np.abs(sosfiltfilt(sos, y))
    hop = int(sr * hop_s)
    n = len(band) // hop
    env = band[: n * hop].reshape(n, hop).mean(axis=1)
    env = np.convolve(env, np.ones(3) / 3, mode="same")  # 6 ms smoothing
    rise = np.maximum(np.diff(env, prepend=env[0]), 0)
    return rise, sr / hop  # true frame rate (22050/44 = 501.1/s); using 1/hop_s drifted 0.7 s over 5 minutes


def refine_to_onsets(path, beats: np.ndarray, window_s: float = 0.06) -> tuple[np.ndarray, float]:
    """Shift the WHOLE grid by the median distance from each beat to its nearest guitar attack.

    One uniform shift fixes the beat finder's systematic lateness without adding jitter
    (snapping each beat separately doubled the grid jitter on the benchmark).
    Returns (beats, shift in ms).
    """
    if len(beats) == 0:
        return beats, 0.0
    rise, fps = _attack_env(path)
    w = int(window_s * fps)
    # Average the attack signal around every beat and take where that average peaks. A per-beat
    # median was pulled toward 0 by small attacks that sit right on the late grid; the average
    # follows the strong strums (measured on the benchmark: -46 ms, matching an independent flux reference).
    rows = [rise[int(round(b * fps)) - w : int(round(b * fps)) + w + 1] for b in beats if w <= int(round(b * fps)) < len(rise) - w - 1]
    if len(rows) < 8:
        return beats, 0.0
    prof = np.mean(rows, axis=0)
    k = int(np.argmax(prof))
    if prof[k] < 1.5 * float(np.mean(prof)):
        return beats, 0.0  # no clear common attack: leave the grid alone
    shift = (k - w) / fps
    return beats + shift, round(shift * 1000, 1)


def half_time_check(path: str, beats: np.ndarray, attack_paths=None) -> dict:
    """Is the detected tempo double the felt pulse? Compares onset autocorrelation at T and 2T."""
    env, fps = _onset_env(path, hop=512)
    env = env - env.mean()
    ac = np.correlate(env, env, mode="full")[len(env) - 1 :]
    ac = ac / (ac[0] + 1e-12)
    T = float(np.median(np.diff(beats))) if len(beats) > 2 else 0.5
    lag = lambda t: float(ac[min(len(ac) - 1, int(round(t * fps)))])
    at_t, at_2t = lag(T), lag(2 * T)
    likely = 60 / T > 100 and at_2t > at_t
    # Keep the half of the beats that carries more onset energy (the stronger pulse).
    if likely:
        # Keep the beat phase where the guitar attacks are stronger (the strums on the pulse).
        rise, fpsr = _attack_env(attack_paths or path)
        def strength_at(b):
            c = int(round(b * fpsr))
            return float(rise[max(0, c - 5) : c + 6].max()) if c < len(rise) else 0.0
        strength = [sum(strength_at(b) for b in beats[p::2]) for p in (0, 1)]
        slow = beats[int(np.argmax(strength))::2]
    else:
        slow = beats
    return {"likely": bool(likely), "ac_T": round(at_t, 3), "ac_2T": round(at_2t, 3), "fast_bpm": round(60 / T, 1), "slow_bpm": round(30 / T, 1), "beats": slow}


def summarize(beats: np.ndarray, downbeats: np.ndarray, method: str) -> dict:
    out: dict = {"method": method, "beats": [round(float(b), 3) for b in beats]}
    if len(beats) < 4:
        out.update(bpm=None, bpm_confidence=0.0, time_signature=None, downbeats=[])
        return out

    ibi = np.diff(beats)
    med = float(np.median(ibi))
    spread = float(np.median(np.abs(ibi - med)) / med)
    out["bpm"] = round(60.0 / med, 1)
    out["bpm_confidence"] = round(float(np.clip(1 - spread * 10, 0, 1)), 2)
    out["tempo_steady"] = spread < 0.03

    if len(downbeats) >= 2:
        idx = np.searchsorted(beats, downbeats - 0.05)
        counts = Counter(int(c) for c in np.diff(idx) if c > 0)
        beats_per_bar, hits = counts.most_common(1)[0]
        out["time_signature"] = f"{beats_per_bar}/4"
        out["time_signature_confidence"] = round(hits / max(sum(counts.values()), 1), 2)
        out["downbeats"] = [round(float(d), 3) for d in downbeats]
        out["downbeats_estimated"] = False
    else:
        out["time_signature"] = None
        out["time_signature_confidence"] = 0.0
        out["downbeats"] = []
    return out


def downbeats_from_chords(beats: np.ndarray, chord_starts: list[float], beats_per_bar: int = 4) -> tuple[np.ndarray, float]:
    """Guess bar starts: chords usually change on the first beat of a bar.

    Picks the beat phase (0..beats_per_bar-1) that lines up with the most chord changes.
    Returns (downbeat times, confidence 0-1).
    """
    if len(beats) < beats_per_bar * 2 or not chord_starts:
        return beats[::beats_per_bar], 0.0
    change_idx = [int(np.argmin(np.abs(beats - t))) for t in chord_starts[1:]]
    votes = np.bincount([i % beats_per_bar for i in change_idx], minlength=beats_per_bar)
    phase = int(np.argmax(votes))
    conf = float(votes[phase] / max(votes.sum(), 1))
    return beats[phase::beats_per_bar], round(conf, 2)
