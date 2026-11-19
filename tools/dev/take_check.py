"""Checks a loopback take: the aligned file must match the song mix at song time `startSec` (lag ~ 0 ms)."""
import json
import sys

import numpy as np
import soundfile as sf
from scipy.signal import correlate, resample_poly

song_dir, take_id = sys.argv[1], sys.argv[2]
take_dir = f"{song_dir}/takes/{take_id}"
info = json.load(open(f"{take_dir}/take.json", encoding="utf-8"))
print(json.dumps({k: v for k, v in info.items() if k != "tracks"}, indent=1))
for t in info.get("tracks", []):
    print("track:", json.dumps(t))

t0 = info["startSec"]
track = info["tracks"][0]
x, sr = sf.read(f"{take_dir}/{track['file']}", always_2d=True)
x = x.mean(axis=1)
m, msr = sf.read(f"{song_dir}/mix.wav", always_2d=True)
m = m.mean(axis=1)
if msr != sr:
    m = resample_poly(m, sr, msr)

# Song time of the take's sample k is t0 + k / sr. Compare a 6 s window that starts 3 s into the music.
music_start = max(0.0, t0)
k0 = int(round((music_start + 3.0 - t0) * sr))
n = int(6 * sr)
seg_take = x[k0 : k0 + n]
s0 = int(round((music_start + 3.0) * sr))
max_lag = int(0.05 * sr)  # +-50 ms
seg_mix = m[s0 - max_lag : s0 + n + max_lag]
c = correlate(seg_mix, seg_take, mode="valid")
# take[k] holds mix[s + k + d]; a late take holds older sound, so d < 0. Report lag = -d (>0 = late).
lag = -(int(np.argmax(np.abs(c))) - max_lag)
norm = np.abs(c).max() / (np.linalg.norm(seg_take) * np.linalg.norm(seg_mix[max_lag : max_lag + n]) + 1e-12)
print(f"take level {20*np.log10(np.abs(seg_take).max()+1e-12):.1f} dBFS, correlation {norm:.3f}")
print(f"lag {lag} samples = {1000*lag/sr:+.2f} ms ({'take late' if lag > 0 else 'take early' if lag < 0 else 'exact'})")
# Drift check: the same lag near the end of the take?
k1 = len(x) - n - int(2 * sr)
if k1 > k0 + 5 * sr:
    s1 = int(round((t0 + k1 / sr) * sr))
    c2 = correlate(m[s1 - max_lag : s1 + n + max_lag], x[k1 : k1 + n], mode="valid")
    lag2 = -(int(np.argmax(np.abs(c2))) - max_lag)
    print(f"lag near the end {lag2} samples = {1000*lag2/sr:+.2f} ms (change = drift)")
