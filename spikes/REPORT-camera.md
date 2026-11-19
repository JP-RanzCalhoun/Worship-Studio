# Camera probe (M2b spike)

Tool: `spikes/camprobe/CamProbe.cpp` (build target `CamProbe`). Read-only: it lists the formats and never starts a stream.
No picture was captured or stored. Run on 2026-10-03, at night, with the cameras idle.

## Result

| Camera | Best for recording | Notes |
|---|---|---|
| EMEET SmartCam C60E 4K | **1920×1080 @ 60 or 30 fps, MJPG or NV12** | 4K is 30 fps only. NV12 1080p60 is available, so no JPEG decoding is necessary. |
| Iriun Webcam (phone) | 1920×1080 @ 60 or 29.97 fps | Gives RGB24/YUY2 only, so the data is large (1080p60 RGB24 ≈ 370 MB/s before encoding). Quality depends on Wi-Fi. |
| HD User Facing (laptop) | 1280×720 @ 30 fps | Fallback only. |

## What this means for the build

- Default: **EMEET, 1920×1080, 30 fps, NV12**. 30 fps is enough for a playing video and halves the CPU load
  compared with 60 fps on the Ryzen 7 5700U. 60 fps is an option in Settings.
- 4K: not the default (30 fps only, high CPU load for encoding, large files).
- Iriun: supported as a second angle. The app must say that it depends on Wi-Fi and can drop frames.
- Capture path: Media Foundation source reader (built into Windows, no extra licence).
- The encoder (H.264 through Media Foundation, or something else) is a licensing decision. It is in "Waiting for JP".

## Not yet tested (needs JP awake)
- A real stream: frame timing, dropped frames, and the A/V offset against the USB audio. These need the camera on.
