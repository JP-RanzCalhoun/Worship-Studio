# Two inputs at once + clock drift (M2b spike)

Run on 2026-10-03 at night. **No audio was stored** (privacy): the tools keep only counts, timing and level.
The E2 Gen2 was not plugged in, so the test used **PD200X + the EMEET webcam mic** as stand-ins.

## Tools
- `spikes/dualinput/DualInputSpike.cpp` (target `DualInputSpike`): opens two inputs through JUCE, counts samples.
- `app/src/InputRecorder.*` + `spikes/recorder/RecorderTest.cpp` (target `RecorderTest`): the real recorder
  in dry-run mode. It uses its own WASAPI streams and reads every packet's device position and QPC time.

## Results

| Test | PD200X | EMEET mic | A vs B |
|---|---|---|---|
| JUCE path, 300 s | −47.6 ppm | −14.3 ppm | −33 ppm, but this is **one 10 ms jump at 130 s**, not drift |
| Own recorder, first-packet timing, 120 s | −31 ppm | −310 ppm | wrong: the first packet's time is unreliable |
| **Own recorder, line fit + device position, 60 s** | **−32.8 ppm** | **−32.9 ppm** | **+0.14 ppm (0.04 ms after 5 min)** |

ppm = parts per million against the PC clock. 33 ppm = 10 ms after 5 minutes.

## What this means
1. These two USB devices run from the same USB clock. Between them there is **no real drift**.
2. The real problem is **lost samples**. The webcam mic lost 34 ms in 2 places in 60 s.
   The JUCE input path hides this; the timeline would slip without a warning.
   The own recorder sees each gap (device position jumps), writes silence in its place, and counts it.
3. A start-time difference of ~30 ms between devices is normal. The QPC line fit measures it, and `alignTake` removes it.
4. The E2 Gen2 may have its own clock (asynchronous USB). Then real drift is possible. The design handles it anyway:
   `alignTake` resamples each take to the playback rate (tested on a synthetic 100 ppm take:
   exact length, start within one sample, error under 2 µs).

## Decision
- Record with the own WASAPI recorder (`InputRecorder`), not the JUCE input path:
  it gives per-packet timing, gap detection and gap filling.
- Correct drift and offset after the take (`alignTake`), not live. Live monitoring uses the device's
  hardware monitoring (zero latency); this is the standard choice for USB mics.

## Still to test (needs JP)
- [ ] The real pair: E2 Gen2 (guitar) + PD200X (vocal), 5 minutes.
- [ ] One real take, to confirm the recorded sound (needs JP awake and playing).
