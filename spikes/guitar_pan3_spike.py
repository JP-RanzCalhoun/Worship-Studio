"""3-region pan split of a guitar stem, with simple role hints per region. Experimental.

Role hints (never presented as fact):
  - activity: share of time the part is clearly playing (a lead line is often intermittent)
  - centroid: brightness; a capoed part usually sounds brighter than open strumming
  - onset density: notes per second; strumming has many broadband onsets
  - crosstalk: correlation of each part's envelope with the others (high = same player leaking)
"""

import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import istft, stft

src = Path(sys.argv[1])
edges = [float(x) for x in (sys.argv[2:] or ["-1", "-0.2", "0.2", "1"])]
out = Path(__file__).parent / "out" / "guitar_pan3"
out.mkdir(parents=True, exist_ok=True)

y, sr = sf.read(str(src), dtype="float32", always_2d=True)
n_fft, hop = 4096, 1024
f, _, SL = stft(y[:, 0], sr, nperseg=n_fft, noverlap=n_fft - hop)
_, _, SR = stft(y[:, 1], sr, nperseg=n_fft, noverlap=n_fft - hop)
mL, mR = np.abs(SL), np.abs(SR)
energy = mL**2 + mR**2
pan = (mR - mL) / (mR + mL + 1e-9)

# Soft masks (raised-cosine crossfade of width 0.1 at each edge) to reduce musical-noise artefacts.
def soft_mask(lo, hi, w=0.1):
    m = np.clip((pan - (lo - w / 2)) / w, 0, 1) * np.clip(((hi + w / 2) - pan) / w, 0, 1)
    return 0.5 - 0.5 * np.cos(np.pi * m)

envs = []
for i, (lo, hi) in enumerate(zip(edges[:-1], edges[1:])):
    m = soft_mask(lo if i else -2, hi if i < len(edges) - 2 else 2)
    PL, PR = SL * m, SR * m
    _, l = istft(PL, sr, nperseg=n_fft, noverlap=n_fft - hop)
    _, r = istft(PR, sr, nperseg=n_fft, noverlap=n_fft - hop)
    sf.write(str(out / f"part{i + 1}_pan_{lo:+.1f}_to_{hi:+.1f}.wav"), np.stack([l, r], 1)[: len(y)], sr, subtype="PCM_16")

    E = np.abs(PL) ** 2 + np.abs(PR) ** 2
    frame_e = E.sum(axis=0)
    env_db = 10 * np.log10(frame_e + 1e-12)
    active = env_db > (np.percentile(env_db, 95) - 20)
    centroid = float((f[:, None] * E).sum() / (E.sum() + 1e-12))
    flux = np.maximum(np.diff(np.sqrt(E), axis=1), 0).sum(axis=0)
    onsets = int(((flux[1:-1] > flux[:-2]) & (flux[1:-1] > flux[2:]) & (flux[1:-1] > np.percentile(flux, 90))).sum())
    dur = len(y) / sr
    envs.append(np.sqrt(frame_e))
    print(
        f"part {i + 1} pan [{lo:+.1f},{hi:+.1f}): energy {E.sum() / energy.sum() * 100:5.1f}%  "
        f"active {active.mean() * 100:4.0f}%  centroid {centroid:6.0f} Hz  onsets/s {onsets / dur:4.1f}"
    )

c = np.corrcoef(np.array(envs))
print("\nenvelope correlation between parts (high = likely the same player leaking across regions):")
for i in range(len(envs)):
    print("  " + "  ".join(f"{c[i, j]:.2f}" for j in range(len(envs))))
