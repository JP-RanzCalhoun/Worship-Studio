"""Second-pass split of a guitar stem into separate performances. Experimental.

Tries two signal-processing cues that do not need a trained "lead vs rhythm" model:
  1. Stereo position (pan). If players were panned apart in the mix, a time-frequency
     pan mask can pull them apart (azimuth discrimination).
  2. Register. A capoed part and a lead line often sit higher than open-position strumming.

It prints a pan histogram so a human can see whether distinct pan positions exist at all,
then writes candidate parts to spikes/out/guitar_split/. Listening decides; numbers only hint.
"""

import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import find_peaks, istft, stft

src = Path(sys.argv[1])
out = Path(__file__).parent / "out" / "guitar_split"
out.mkdir(parents=True, exist_ok=True)

y, sr = sf.read(str(src), dtype="float32", always_2d=True)
L, R = y[:, 0], y[:, 1]
print(f"stereo correlation L/R: {np.corrcoef(L, R)[0, 1]:.3f}  (1.0 = mono, lower = wider)")

n_fft, hop = 4096, 1024
_, _, SL = stft(L, sr, nperseg=n_fft, noverlap=n_fft - hop)
_, _, SR = stft(R, sr, nperseg=n_fft, noverlap=n_fft - hop)
mL, mR = np.abs(SL), np.abs(SR)
energy = mL**2 + mR**2
pan = (mR - mL) / (mR + mL + 1e-9)  # -1 = hard left, +1 = hard right

# Energy-weighted pan histogram.
bins = np.linspace(-1, 1, 81)
hist, _ = np.histogram(pan.ravel(), bins=bins, weights=energy.ravel())
hist = hist / hist.sum()
centers = (bins[:-1] + bins[1:]) / 2
smooth = np.convolve(hist, np.ones(3) / 3, mode="same")
peaks, props = find_peaks(smooth, height=0.01, distance=6, prominence=0.005)
print("\npan histogram (energy share per pan position):")
for c, h in zip(centers[::4], [hist[i : i + 4].sum() for i in range(0, 80, 4)]):
    print(f"  {c:+.2f} {'#' * int(h * 200)} {h * 100:.1f}%")
print("\npan peaks found:", [(round(float(centers[p]), 2), round(float(smooth[p] * 100), 1)) for p in peaks])

# Pan-mask split: one soft mask per peak region.
if len(peaks) >= 2:
    edges = [-1.0] + [float((centers[a] + centers[b]) / 2) for a, b in zip(peaks[:-1], peaks[1:])] + [1.0]
    for i, (lo, hi) in enumerate(zip(edges[:-1], edges[1:])):
        mask = ((pan >= lo) & (pan < hi)).astype(np.float32)
        _, l = istft(SL * mask, sr, nperseg=n_fft, noverlap=n_fft - hop)
        _, r = istft(SR * mask, sr, nperseg=n_fft, noverlap=n_fft - hop)
        part = np.stack([l, r], axis=1)[: len(y)]
        share = float((energy * mask).sum() / energy.sum())
        name = f"pan_{i}_{centers[peaks[i]]:+.2f}.wav"
        sf.write(str(out / name), part, sr, subtype="PCM_16")
        print(f"wrote {name}: {share * 100:.1f}% of guitar energy, pan range [{lo:+.2f}, {hi:+.2f})")
else:
    print("only one pan position: pan-based split is not possible for this recording")

# Register split around the strummed-chord body vs higher capo/lead register.
freqs = np.fft.rfftfreq(n_fft, 1 / sr)
for name, (lo, hi) in {"register_low_below_400Hz": (0, 400), "register_high_above_400Hz": (400, sr / 2)}.items():
    mask = ((freqs >= lo) & (freqs < hi)).astype(np.float32)[:, None]
    _, l = istft(SL * mask, sr, nperseg=n_fft, noverlap=n_fft - hop)
    _, r = istft(SR * mask, sr, nperseg=n_fft, noverlap=n_fft - hop)
    sf.write(str(out / f"{name}.wav"), np.stack([l, r], axis=1)[: len(y)], sr, subtype="PCM_16")
print("wrote register split (low/high) for listening")
