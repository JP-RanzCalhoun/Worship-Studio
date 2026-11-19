"""Re-check stem residuals with time alignment, and compare the two models' guitar stems.

MP3 decoders disagree on the encoder delay (often ~1100 samples), which inflates a naive
mix-minus-stems residual. This finds the best lag first.
"""

import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import correlate

out = Path(__file__).parent / "out"
mix_path = Path(sys.argv[1])


def load_mono(p):
    y, sr = sf.read(str(p), dtype="float32", always_2d=True)
    return y, y.mean(axis=1), sr


def best_lag(a, b, max_lag=4000, seconds=30, sr=44100):
    a = a[sr * 20 : sr * (20 + seconds)]
    b = b[sr * 20 : sr * (20 + seconds)]
    c = correlate(a, b, mode="full", method="fft")
    mid = len(b) - 1
    win = c[mid - max_lag : mid + max_lag + 1]
    return int(np.argmax(win)) - max_lag


mix, mixm, sr = load_mono(mix_path)
for model in ["htdemucs_6s", "BS-Roformer-SW"]:
    stems = sorted((out / model).glob("*.wav"))
    total = None
    for s in stems:
        y, _, s_sr = load_mono(s)
        assert s_sr == sr, (s_sr, sr)
        total = y if total is None else total[: len(y)] + y[: len(total)]
    lag = best_lag(mixm, total.mean(axis=1), sr=sr)
    if lag >= 0:
        a, b = mix[lag:], total
    else:
        a, b = mix, total[-lag:]
    n = min(len(a), len(b))
    err = a[:n] - b[:n]
    res = 10 * np.log10((err**2).sum() / (a[:n] ** 2).sum())
    print(f"{model}: lag={lag} samples, aligned residual={res:.1f} dB")

g1, g1m, _ = load_mono(next((out / "htdemucs_6s").glob("*(Guitar)*")))
g2, g2m, _ = load_mono(next((out / "BS-Roformer-SW").glob("*(guitar)*")))
n = min(len(g1m), len(g2m))
corr = np.corrcoef(g1m[:n], g2m[:n])[0, 1]
print(f"guitar stems correlation (demucs vs roformer): {corr:.3f}")

# Vocal leakage proxy: how much the guitar stem correlates with the vocal stem of the same model.
for model, gname, vname in [("htdemucs_6s", "Guitar", "Vocals"), ("BS-Roformer-SW", "guitar", "vocals")]:
    _, g, _ = load_mono(next((out / model).glob(f"*({gname})*")))
    _, v, _ = load_mono(next((out / model).glob(f"*({vname})*")))
    n = min(len(g), len(v))
    print(f"{model}: guitar-vs-vocal stem correlation {np.corrcoef(g[:n], v[:n])[0, 1]:.3f} (0 = no shared signal)")
