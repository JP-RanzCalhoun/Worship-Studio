"""Full analysis pipeline: stems -> beats -> chords/key -> sections."""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import soundfile as sf

from . import __version__
from .harmony import estimate_chords, estimate_key, refine_key_with_chords
from .notes import frame_normalise, note_chroma, remove_drone
from .rhythm import downbeats_from_chords, track_beats
from .separate import PRESETS, compact, guitar_pan_split, match_rate, separate, stem_level_db, write_residual, model_files
from .structure import segment

SILENT_REL_DB = -45.0  # below this a stem is bleed/silence: deleted (its sound stays in "Leftover")
QUIET_REL_DB = -30.0  # between the two: kept as a quiet part, muted by default and left out of analysis
# (benchmark 'piano' was -35 dB vs mix: a soft pad or bleed, the user decides by listening)


def _usable(s: dict) -> bool:
    """Loud enough to use for beat/chord/structure analysis."""
    return not s.get("silent") and not s.get("quiet")


def _device(requested: str) -> str:
    if requested == "cpu":
        return "cpu"
    try:
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    except ImportError:
        return "cpu"


def _load_mono(path: Path, sr: int = 22050) -> np.ndarray:
    import librosa

    y, _ = librosa.load(str(path), sr=sr, mono=True)
    return y


def analyze(source: Path, work: Path, quality: str, device: str, skip_separation: bool, on_progress) -> dict:
    import librosa

    if device == "cpu":
        os.environ["CUDA_VISIBLE_DEVICES"] = ""  # must happen before torch initialises CUDA
    dev = _device(device)
    info = sf.info(str(source))
    duration = info.frames / info.samplerate
    result: dict = {
        "version": 1,
        "tool": f"wsa {__version__}",
        "device": dev,
        "duration": round(duration, 3),
        "sampleRate": info.samplerate,
        "warnings": [],
        "createdAt": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
    }

    # ---- 1. stems
    stems: list[dict] = []
    if not skip_separation:
        preset = PRESETS.get(quality) or PRESETS["fast"]
        on_progress("separating", 2, f"Loading {preset.label}")
        stem_dir = work / "stems"
        stems = separate(source, stem_dir, quality, dev, duration, on_progress)
        match_rate(stems, info.samplerate)
        mix_db = stem_level_db(str(source))
        for s in stems:
            s["level_db"] = round(stem_level_db(s["path"]) - mix_db, 1)  # dB vs the mix
            s["silent"] = s["level_db"] < SILENT_REL_DB
            s["quiet"] = not s["silent"] and s["level_db"] < QUIET_REL_DB
        guitar = next((s for s in stems if s["id"] == "guitar"), None)
        if guitar and _usable(guitar):
            on_progress("guitar-split", 65, "Trying the experimental guitar pan split")
            parts = guitar_pan_split(Path(guitar["path"]), stem_dir)
            if parts:
                # Play the three parts instead of the combined stem (they sum to it exactly).
                for p in parts:
                    p["group"] = "guitar"
                    p["level_db"] = round(stem_level_db(p["path"]) - mix_db, 1)
                    p["silent"] = p["level_db"] < SILENT_REL_DB
                    p["quiet"] = not p["silent"] and p["level_db"] < QUIET_REL_DB
                i = stems.index(guitar)
                stems[i : i + 1] = parts
                result["guitarSplit"] = {
                    "method": "stereo pan mask (left / centre / right)",
                    "combinedStem": guitar["path"],
                    "note": "Experimental. Parts are separated by stereo position only. Expect leakage between parts. Listen before relying on it.",
                }
            else:
                result["warnings"].append("Guitar stem is close to mono, so the pan split was skipped.")
        on_progress("separating", 67, "Saving stems and measuring what they missed")
        compact(stems)
        if "guitarSplit" in result:
            Path(result["guitarSplit"]["combinedStem"]).unlink(missing_ok=True)  # parts sum to it exactly
            result["guitarSplit"]["combinedStem"] = None
        res_path = stem_dir / "residual.wav"
        res_db = write_residual(source, stems, res_path)
        result["separation"] = {
            "preset": quality,
            "model": preset.model,
            "modelFiles": model_files(preset),  # name, size, SHA-256 of the exact weights used
            "license": preset.license,
            "residual_db": round(res_db, 1),
            "headroom_db": 6.0,
        }
        result["silentStems"] = [s["id"] for s in stems if not s["path"]]
        result["quietStems"] = [s["id"] for s in stems if s["path"] and s.get("quiet")]
        stems = [s for s in stems if s["path"]]
        stems.append({"id": "residual", "name": "Leftover (not in any stem)", "path": str(res_path), "level_db": round(res_db, 1), "silent": False})
        result["stems"] = stems

    # ---- 2. beats
    on_progress("beats", 70, "Finding beats and downbeats")
    # Beat timing is refined on the instrument stems (no vocals, no leftover) when they exist.
    attack = [s["path"] for s in stems if s["id"] not in ("vocals", "residual") and _usable(s)]
    rhythm = track_beats(str(source), device=dev, attack_paths=attack or None)
    result["rhythm"] = rhythm
    if rhythm.get("note"):
        result["warnings"].append(rhythm["note"])
    beats = np.array(rhythm["beats"])

    # ---- 3. harmony from the pitched stems (no drums, no vocals) when available
    on_progress("chords", 80, "Estimating key and chords")
    harmonic_ids = {"guitar", "guitar_l", "guitar_c", "guitar_r", "piano", "other", "bass"}
    harm_paths = [Path(s["path"]) for s in stems if s["id"] in harmonic_ids and _usable(s)]
    sr = 22050
    if harm_paths:
        ys = [_load_mono(p, sr) for p in harm_paths]
        n = min(len(y) for y in ys)
        y_harm = np.sum([y[:n] for y in ys], axis=0)
        result["chordSource"] = "pitched stems (vocals and drums removed)"
    else:
        y_full = _load_mono(source, sr)
        y_harm = librosa.effects.harmonic(y_full)
        result["chordSource"] = "full mix (harmonic part)"
    hop = 512
    chroma = librosa.feature.chroma_cqt(y=y_harm, sr=sr, hop_length=hop)
    # Chords are named from the NOTES Basic Pitch hears in the pitched stems (70 %) plus the spectral chroma (30 %):
    # the notes follow chord changes the spectral chroma smears together (notes that ring under every chord are
    # removed per beat first, see notes.remove_drone). Only with stems (vocal melody notes would
    # pull the chords); without Basic Pitch, or if it fails, the spectral chroma alone is used as before.
    nc = None
    if harm_paths:
        try:
            nc, note_info = note_chroma(y_harm, sr, chroma.shape[1], hop, work)
            result["notes"] = note_info
            result["chordSource"] += " + notes heard by Basic Pitch"
        except Exception as e:  # noqa: BLE001 - any failure: keep the old method, say so
            result["warnings"].append(f"Note transcription (Basic Pitch) was not used: {e}. Chords come from the spectrum only.")

    bass_stem = next((s for s in stems if s["id"] == "bass" and _usable(s)), None)
    if bass_stem:
        y_bass = _load_mono(Path(bass_stem["path"]), sr)
    else:
        y_bass = y_harm
    bass_chroma = librosa.feature.chroma_cqt(y=y_bass, sr=sr, hop_length=hop, fmin=librosa.note_to_hz("C1"), n_octaves=3)

    # Half time: estimate chords on the fine (fast) grid, then keep the beat phase where most chords change
    # (chords usually change on beat 1). Onset strength alone could not tell the two phases apart.
    fast = np.array(rhythm.get("beats_fast") or [])
    if len(fast) >= 8:
        beats = fast
    if len(beats) >= 4:
        # Chords change at most once per beat: aggregate chroma per beat.
        edges = np.concatenate([[0.0], beats, [duration]])
        frames = librosa.time_to_frames(edges, sr=sr, hop_length=hop)
        frames = np.clip(frames, 0, chroma.shape[1])
        frames = np.unique(frames)
        c_sync = librosa.util.sync(chroma, frames, aggregate=np.median)
        if nc is not None:
            # notes per beat (mean: a short note still counts), held drone notes removed, then 70 % notes + 30 % spectrum
            n_sync = remove_drone(librosa.util.sync(nc, frames, aggregate=np.mean))
            c_sync = 0.7 * frame_normalise(n_sync) + 0.3 * c_sync
        b_sync = librosa.util.sync(bass_chroma, frames, aggregate=np.median)
        t_edges = librosa.frames_to_time(frames, sr=sr, hop_length=hop)
        t_edges[-1] = duration
        k = min(c_sync.shape[1], len(t_edges) - 1)
        segments = estimate_chords(c_sync[:, :k], t_edges[: k + 1], b_sync[:, :k])
    else:
        result["warnings"].append("Too few beats were found; chords were not estimated.")
        segments = []
    if len(fast) >= 8 and segments:
        idx = [int(np.argmin(np.abs(fast - c["start"]))) for c in segments[1:]]
        votes = [sum(1 for i in idx if i % 2 == p) for p in (0, 1)]
        if sum(votes) >= 8 and max(votes) > min(votes):  # too few changes: keep the attack-based phase
            phase = int(np.argmax(votes))
            beats = fast[phase::2]
            rhythm["beats"] = [round(float(b), 3) for b in beats]
            rhythm["bpm"] = round(60.0 / float(np.median(np.diff(beats))), 1)
            rhythm["half_time"]["phase_from"] = f"chord changes ({max(votes)} of {sum(votes)} on the kept beats)"
    key = refine_key_with_chords(estimate_key(chroma.sum(axis=1)), segments)
    result["key"] = key
    result["chords"] = segments

    # ---- 4. sections, bar-synchronous
    on_progress("sections", 90, "Suggesting song sections")
    downbeats = np.array(rhythm.get("downbeats") or [])
    if len(downbeats) < 4 and len(beats) >= 8:
        downbeats, conf = downbeats_from_chords(beats, [c["start"] for c in segments])
        rhythm["downbeats"] = [round(float(d), 3) for d in downbeats]
        rhythm["downbeats_estimated"] = True
        rhythm["time_signature"] = "4/4"
        rhythm["time_signature_confidence"] = 0.0
        rhythm["downbeat_confidence"] = conf
        result["warnings"].append("Time signature assumed 4/4. Bar starts were guessed from chord changes; check the grid.")
    if len(downbeats) >= 8:
        y_full = _load_mono(source, sr)
        mfcc = librosa.feature.mfcc(y=y_full, sr=sr, hop_length=hop, n_mfcc=13)
        bar_edges = np.concatenate([[0.0], downbeats, [duration]])
        bframes = np.unique(np.clip(librosa.time_to_frames(bar_edges, sr=sr, hop_length=hop), 0, chroma.shape[1]))
        cs = librosa.util.sync(chroma, bframes, aggregate=np.mean)
        ms = librosa.util.sync(mfcc[:, : chroma.shape[1]], bframes, aggregate=np.mean)
        bt = librosa.frames_to_time(bframes, sr=sr, hop_length=hop)
        bt[-1] = duration
        vocal = next((s for s in stems if s["id"] == "vocals" and _usable(s)), None)
        v_sync = None
        if vocal:
            yv = _load_mono(Path(vocal["path"]), sr)
            rms = librosa.feature.rms(y=yv, hop_length=hop)[:, : chroma.shape[1]]
            v_sync = librosa.util.sync(rms, bframes, aggregate=np.mean)[0]
        n_bars = min(cs.shape[1], len(bt) - 1)
        result["sections"] = segment(cs[:, :n_bars], ms[:, :n_bars], bt[: n_bars + 1], None if v_sync is None else v_sync[:n_bars])
    else:
        result["sections"] = []
        result["warnings"].append("Too few bars were found; sections were not suggested.")

    on_progress("done", 100, "Analysis complete")
    return result
