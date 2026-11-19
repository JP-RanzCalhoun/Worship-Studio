"""Stem separation presets and the experimental guitar pan split.

Models run through python-audio-separator (MIT). Model weights are downloaded on first use
into <repo>/models (git-ignored). See docs/MODELS.md for sources and licenses.
"""

from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import soundfile as sf

MODELS_DIR = Path(__file__).resolve().parents[2] / "models"


@dataclass
class Preset:
    label: str
    model: str
    note: str
    license: str
    stems: list[str] = field(default_factory=list)
    # Measured on the benchmark song (5.5 min) on an RTX 3050 Ti laptop, see spikes/REPORT-separation.md.
    gpu_seconds_per_minute: float = 12.0
    cpu_seconds_per_minute: float = 120.0


PRESETS: dict[str, Preset] = {
    "fast": Preset(
        label="Standard (Demucs 6-stem)",
        model="htdemucs_6s.yaml",
        note="About 1 minute for a 5-minute song on a laptop NVIDIA GPU (measured on an RTX 3050 Ti). CPU works but is much slower.",
        license="Code MIT. Weights: research use only per the maintainer (demucs issue #327), not cleared for distribution",
        stems=["vocals", "drums", "bass", "guitar", "piano", "other"],
        gpu_seconds_per_minute=12.1,
        cpu_seconds_per_minute=150.0,
    ),
    "best": Preset(
        label="Detailed (BS-RoFormer SW)",
        model="BS-Roformer-SW.ckpt",
        note="About 7x slower than Standard. On the benchmark song it gave a near-identical guitar stem. Weights license not verified.",
        license="UNVERIFIED community weights - do not redistribute",
        stems=["vocals", "drums", "bass", "guitar", "piano", "other"],
        gpu_seconds_per_minute=85.0,
        cpu_seconds_per_minute=900.0,
    ),
}

STEM_NAMES = {
    "vocals": "Vocals",
    "drums": "Drums",
    "bass": "Bass",
    "guitar": "Guitars (all)",
    "piano": "Piano / keys",
    "other": "Other",
}


def _stem_id(filename: str) -> str | None:
    m = re.search(r"_\(([^)]+)\)_", filename)
    return m.group(1).lower() if m else None


HEADROOM_DB = 6.0  # the mix is fed 6 dB quieter, so the separator never has a reason to rescale its outputs


def model_files(preset: Preset) -> list[dict]:
    """The model files a preset uses, with size and SHA-256, so every analysis records exactly which weights made it.

    A Demucs .yaml lists checkpoint signatures (e.g. '5c90dfd2'); the weights are the .th files starting with them.
    Hashes are cached by (name, size, mtime) in models/hashes.json, so large files are hashed once.
    """
    import hashlib
    import json

    main = MODELS_DIR / preset.model
    files = [main]
    if main.suffix == ".yaml" and main.exists():
        for sig in re.findall(r"\b([0-9a-f]{8})\b", main.read_text(encoding="utf-8", errors="ignore")):
            files += sorted(MODELS_DIR.glob(f"{sig}*.th"))
    cache_path = MODELS_DIR / "hashes.json"
    try:
        cache = json.loads(cache_path.read_text(encoding="utf-8"))
    except Exception:
        cache = {}
    out = []
    for f in files:
        if not f.is_file():
            continue
        st = f.stat()
        key = f"{f.name}|{st.st_size}|{int(st.st_mtime)}"
        if key not in cache:
            h = hashlib.sha256()
            with open(f, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    h.update(chunk)
            cache[key] = h.hexdigest()
        out.append({"file": f.name, "bytes": st.st_size, "sha256": cache[key]})
    try:
        cache_path.write_text(json.dumps(cache, indent=1), encoding="utf-8")
    except OSError:
        pass
    return out


def separate(source: Path, out_dir: Path, preset_key: str, device: str, duration_s: float, on_progress) -> list[dict]:
    """Run one preset. Returns [{id, name, path}] with files renamed to <id>.wav, at the mix's level.

    audio-separator peak-normalises any stem above `normalization_threshold`. That silently scaled the
    benchmark's vocals by 0.886 and left a 'ghost' of every muted part in the residual. We feed a copy
    6 dB down with the threshold at 1.0, then restore the gain exactly.
    """
    preset = PRESETS.get(preset_key) or PRESETS["fast"]
    from audio_separator.separator import Separator

    import torch

    on_gpu = device != "cpu" and torch.cuda.is_available()
    est = duration_s / 60 * (preset.gpu_seconds_per_minute if on_gpu else preset.cpu_seconds_per_minute)

    # audio-separator has no progress callback; report an honest time-based estimate.
    stop = threading.Event()

    def heartbeat():
        t0 = time.perf_counter()
        while not stop.wait(1.0):
            el = time.perf_counter() - t0
            on_progress("separating", 5 + 55 * min(el / max(est, 1), 0.98), f"Separating stems on {'GPU' if on_gpu else 'CPU'} - {int(el)} s elapsed, about {int(max(est - el, 0))} s left (estimate)")

    hb = threading.Thread(target=heartbeat, daemon=True)
    hb.start()
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        y, sr = sf.read(str(source), dtype="float32", always_2d=True)
        quiet = out_dir.parent / "mix_minus6.wav"
        g = 10 ** (-HEADROOM_DB / 20)
        sf.write(str(quiet), y * g, sr, subtype="FLOAT")
        sep = Separator(
            output_dir=str(out_dir),
            model_file_dir=str(MODELS_DIR),
            output_format="WAV",
            log_level=40,
            normalization_threshold=1.0,
            output_bitrate=None,
        )
        sep.load_model(model_filename=preset.model)
        files = sep.separate(str(quiet))
        quiet.unlink(missing_ok=True)
    finally:
        stop.set()
        hb.join()

    stems = []
    for f in files:
        p = out_dir / Path(f).name
        sid = _stem_id(p.name)
        if sid is None:
            continue
        dst = out_dir / f"{sid}.wav"
        s_y, s_sr = sf.read(str(p), dtype="float32", always_2d=True)
        sf.write(str(dst), s_y / g, s_sr, subtype="FLOAT")  # back to the mix's level
        if p != dst:
            p.unlink(missing_ok=True)
        stems.append({"id": sid, "name": STEM_NAMES.get(sid, sid.title()), "path": str(dst)})
    order = {k: i for i, k in enumerate(preset.stems)}
    stems.sort(key=lambda s: order.get(s["id"], 99))
    return stems


def match_rate(stems: list[dict], target_sr: int):
    """Resample stems in place to the mix rate so every track shares one sample rate."""
    import librosa

    for s in stems:
        y, sr = sf.read(s["path"], dtype="float32", always_2d=True)
        if sr != target_sr:
            y = librosa.resample(y.T, orig_sr=sr, target_sr=target_sr).T
            sf.write(s["path"], y, target_sr, subtype="FLOAT")


def write_residual(mix_path: Path, stems: list[dict], out_path: Path) -> float:
    # stems with path None (silent, deleted) are skipped: their sound stays in the residual
    """Residual = mix - sum(stems). Keeps 'all tracks on' equal to the original. Returns its level in dB vs the mix."""
    mix, sr = sf.read(str(mix_path), dtype="float32", always_2d=True)
    total = np.zeros_like(mix)
    for s in stems:
        if not s.get("path"):
            continue
        y, _ = sf.read(s["path"], dtype="float32", always_2d=True)
        n = min(len(y), len(total))
        if y.shape[1] == 1:
            y = np.repeat(y, mix.shape[1], axis=1)
        total[:n] += y[:n, : mix.shape[1]]
    res = mix - total
    sf.write(str(out_path), res, sr, subtype="FLOAT")
    return float(10 * np.log10((res**2).sum() / max((mix**2).sum(), 1e-12)))


def compact(stems: list[dict]):
    """Store playable stems as 16-bit PCM (plenty for rehearsal playback) and delete silent ones.

    Call BEFORE write_residual: the residual is then computed from exactly what is stored and kept,
    so stems + residual = mix (a null test passes to float precision).
    """
    for s in stems:
        p = Path(s["path"])
        if s.get("silent"):
            p.unlink(missing_ok=True)
            s["path"] = None
            continue
        y, sr = sf.read(str(p), dtype="float32", always_2d=True)
        peak = float(np.abs(y).max())
        sf.write(str(p), y, sr, subtype="PCM_16" if peak < 0.999 else "FLOAT")


def stem_level_db(path: str) -> float:
    y, _ = sf.read(path, dtype="float32", always_2d=True)
    return float(20 * np.log10(np.sqrt((y**2).mean()) + 1e-12))


def guitar_pan_split(guitar_path: Path, out_dir: Path, edges=(-0.2, 0.2)) -> list[dict] | None:
    """Experimental: split a stereo guitar stem into left / centre / right parts by pan position.

    The three soft masks sum to 1, so the parts add back up exactly to the guitar stem.
    Only offered when the stem is clearly stereo; a mono or narrow stem cannot be split this way.
    """
    from scipy.signal import istft, stft

    y, sr = sf.read(str(guitar_path), dtype="float32", always_2d=True)
    if y.shape[1] < 2:
        return None
    width = float(np.corrcoef(y[:, 0], y[:, 1])[0, 1])
    if width > 0.8:
        return None

    n_fft, hop = 4096, 1024
    f, _, SL = stft(y[:, 0], sr, nperseg=n_fft, noverlap=n_fft - hop)
    _, _, SR = stft(y[:, 1], sr, nperseg=n_fft, noverlap=n_fft - hop)
    mL, mR = np.abs(SL), np.abs(SR)
    pan = (mR - mL) / (mR + mL + 1e-9)
    # Smooth the pan estimate over time (5 frames, energy-weighted) so bins do not flicker between
    # parts; flicker is what makes mask-separated audio sound "watery".
    import scipy.ndimage

    e = mL**2 + mR**2
    pan = scipy.ndimage.uniform_filter1d(pan * e, 5, axis=1) / (scipy.ndimage.uniform_filter1d(e, 5, axis=1) + 1e-12)
    total_e = e.sum()

    w = 0.25  # wider crossfade between parts

    def ramp(x):  # 0..1 raised cosine
        return 0.5 - 0.5 * np.cos(np.pi * np.clip(x, 0, 1))

    lo, hi = edges
    left = 1 - ramp((pan - (lo - w / 2)) / w)
    right = ramp((pan - (hi - w / 2)) / w)
    centre = 1 - left - right

    parts = []
    for pid, label, m in (("guitar_l", "Guitar - left", left), ("guitar_c", "Guitar - centre", centre), ("guitar_r", "Guitar - right", right)):
        PL, PR = SL * m, SR * m
        _, l = istft(PL, sr, nperseg=n_fft, noverlap=n_fft - hop)
        _, r = istft(PR, sr, nperseg=n_fft, noverlap=n_fft - hop)
        out = out_dir / f"{pid}.wav"
        sf.write(str(out), np.stack([l, r], 1)[: len(y)], sr, subtype="FLOAT")
        E = np.abs(PL) ** 2 + np.abs(PR) ** 2
        parts.append(
            {
                "id": pid,
                "name": label,
                "path": str(out),
                "experimental": True,
                "energy_share": round(float(E.sum() / total_e), 3),
                "brightness_hz": round(float((f[:, None] * E).sum() / (E.sum() + 1e-12))),
            }
        )
    # Role hints only: brightest part may be the capoed/high part, the busiest may be the strummer.
    brightest = max(parts, key=lambda p: p["brightness_hz"])
    brightest["hint"] = "brightest - may be the capoed or high part"
    loudest = max(parts, key=lambda p: p["energy_share"])
    if loudest is not brightest:
        loudest["hint"] = "loudest - may be the main strumming part"
    for p in parts:
        p["stereo_correlation_of_source"] = round(width, 2)
    return parts
