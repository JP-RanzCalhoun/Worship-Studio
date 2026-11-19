"""Note transcription for chord estimation: Spotify Basic Pitch (Apache-2.0, code and model).

Basic Pitch hears the individual notes of the guitars and keys (polyphonic audio-to-MIDI). Their pitch classes,
weighted by loudness and length, give a "note chroma" that is much cleaner than a spectral chroma: strummed
chords, ringing open strings and the room no longer smear into one long chord (2026-11-17 test, "Mighty To Save":
the spectral chroma held Eb for 111 s; the notes followed the real Eb-Bb-Cm-Ab changes).

Runs the ONNX model shipped inside the package (saved_models/icassp_2022/nmp.onnx) through onnxruntime: no
TensorFlow (basic-pitch 0.4.0 asks for tensorflow<2.15.1, which has no Python 3.12 build; install it with
--no-deps, see requirements.txt). About 2 s per 2 minutes of audio on the CPU.
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import logging
from pathlib import Path

import numpy as np
import soundfile as sf

BP_VERSION = "0.4.0"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def note_chroma(y: np.ndarray, sr: int, n_frames: int, hop: int, work: Path) -> tuple[np.ndarray, dict]:
    """Basic Pitch notes of `y` as a 12 x n_frames chroma on the analysis frame grid (hop at sr).

    Each note adds its amplitude to its pitch class over the frames it sounds. Raises if Basic Pitch is not
    installed or fails; the caller then keeps the spectral chroma.
    """
    # Basic Pitch logs warnings about the backends it does not use (TensorFlow, TFLite, CoreML): keep them out.
    logging.getLogger().setLevel(logging.ERROR)
    with contextlib.redirect_stdout(io.StringIO()):
        from basic_pitch import ICASSP_2022_MODEL_PATH
        from basic_pitch.inference import predict

    model = Path(ICASSP_2022_MODEL_PATH)
    if model.suffix != ".onnx":
        raise RuntimeError(f"Basic Pitch picked a non-ONNX model ({model.name}); onnxruntime is needed")
    tmp = work / "basic_pitch_input.wav"
    peak = float(np.max(np.abs(y))) or 1.0
    sf.write(str(tmp), (y / peak * 0.9).astype(np.float32), sr)
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            _, _, notes = predict(str(tmp), model)
    finally:
        tmp.unlink(missing_ok=True)

    chroma = np.zeros((12, n_frames), dtype=np.float32)
    for start, end, pitch, amp, _bends in notes:
        f0 = int(start * sr / hop)
        f1 = max(f0 + 1, int(end * sr / hop))
        if f0 >= n_frames:
            continue
        chroma[int(pitch) % 12, f0 : min(f1, n_frames)] += float(amp)
    info = {
        "tool": f"basic-pitch {BP_VERSION} (Spotify)",
        "license": "Apache-2.0 (code and model)",
        "model": model.name,
        "sha256": _sha256(model),
        "notes": len(notes),
    }
    return chroma, info


def remove_drone(beat_notes: np.ndarray, window: int = 32, amount: float = 0.8) -> np.ndarray:
    """Take out notes that ring under every chord (an open string, a pad, a pedal note).

    A held note is in all the chords around it, so it pulls every beat toward one chord: in "Mighty To Save" a
    ringing Eb kept the whole first 80 s on Eb. Each pitch class loses `amount` of its median over `window` beats,
    so what is left is what changes. (2026-11-17 test: Mighty then follows Cm-Bb-Ab-Eb; Tanging Kailangan gains its
    G-C-D-Am moves.)
    """
    from scipy.ndimage import median_filter

    if beat_notes.shape[1] < 2:
        return beat_notes
    slow = median_filter(beat_notes, size=(1, min(window, beat_notes.shape[1])), mode="nearest")
    return np.maximum(0.0, beat_notes - amount * slow)


def frame_normalise(m: np.ndarray) -> np.ndarray:
    """Each frame scaled to max 1, like librosa's chroma (norm=inf); silent frames stay 0."""
    top = m.max(axis=0, keepdims=True)
    return np.where(top > 1e-9, m / np.maximum(top, 1e-9), 0.0)
