"""Spoken cue rendering with the Windows built-in speech engine (SAPI via System.Speech).

Fully offline. Each text becomes one short WAV so the app can place every word on an exact beat.
"""

from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path


def cue_filename(text: str, rate: int, voice: str | None) -> str:
    # v2 = level-matched; bump when the rendering changes so old cached words are made again.
    h = hashlib.sha1(f"v2|{text}|{rate}|{voice}".encode()).hexdigest()[:12]
    return f"cue_{h}.wav"


def render(texts: list[str], out_dir: Path, rate: int = 1, voice: str | None = None) -> dict[str, str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    todo = {}
    result = {}
    for t in dict.fromkeys(texts):  # unique, keep order
        path = out_dir / cue_filename(t, rate, voice)
        result[t] = str(path)
        if not path.exists():
            todo[t] = path
    if not todo:
        return result

    def ps_quote(s: str) -> str:
        return "'" + s.replace("'", "''") + "'"

    lines = [
        "Add-Type -AssemblyName System.Speech",
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
        f"$s.Rate = {int(rate)}",
        # 48 kHz mono 16-bit so the app does not need to resample.
        "$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)",
    ]
    if voice:
        lines.append(f"$s.SelectVoice({ps_quote(voice)})")
    for t, p in todo.items():
        tmp = p.with_suffix(".part.wav")
        lines += [f"$s.SetOutputToWaveFile({ps_quote(str(tmp))}, $fmt)", f"$s.Speak({ps_quote(t)})"]
    lines.append("$s.SetOutputToNull()")
    lines.append("$s.Dispose()")
    subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", "; ".join(lines)],
        check=True,
        capture_output=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    # Trim, level-match, then move each finished file into place (never a half-written cache file).
    for p in todo.values():
        tmp = p.with_suffix(".part.wav")
        _trim_silence([tmp])
        _level_match(tmp)
        tmp.replace(p)
    return result


def leads(files: dict[str, str]) -> dict[str, float]:
    """Seconds from file start to where the word is heard (envelope reaches -6 dB of its max).

    The app starts each cue this much early so "1 2 3 4" lands on the beats.
    """
    import numpy as np
    import soundfile as sf

    out = {}
    for text, path in files.items():
        y, sr = sf.read(path, dtype="float32")
        if y.ndim > 1:
            y = y.mean(axis=1)
        n = int(0.01 * sr)
        env = np.sqrt(np.convolve(y**2, np.ones(n) / n, mode="same"))
        idx = np.flatnonzero(env >= 0.5 * env.max())
        out[text] = round(float(idx[0] / sr), 3) if len(idx) else 0.0
    return out


def _level_match(path: Path, target_dbfs: float = -16.0):
    """Every cue word at the same loudness (RMS of its voiced part), so no count is quieter than another."""
    import numpy as np
    import soundfile as sf

    y, sr = sf.read(str(path), dtype="float32")
    voiced = y[np.abs(y) > 0.02 * np.abs(y).max()] if len(y) else y
    rms = float(np.sqrt(np.mean(voiced**2))) if len(voiced) else 0.0
    if rms > 0:
        y = y * (10 ** (target_dbfs / 20) / rms)
        peak = float(np.abs(y).max())
        if peak > 0.89:
            y *= 0.89 / peak
    sf.write(str(path), y, sr, subtype="PCM_16")


def _trim_silence(paths: list[Path], threshold: float = 0.01):
    """SAPI adds leading silence; trim it so a cue starts on its beat."""
    import numpy as np
    import soundfile as sf

    for p in paths:
        y, sr = sf.read(str(p), dtype="float32")
        idx = np.flatnonzero(np.abs(y) > threshold)
        if len(idx):
            start = max(int(idx[0]) - int(0.005 * sr), 0)
            end = min(int(idx[-1]) + int(0.05 * sr), len(y))
            sf.write(str(p), y[start:end], sr, subtype="PCM_16")
