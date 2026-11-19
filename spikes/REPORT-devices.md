# Device probe (read-only) — 2026-10-02

Source: Windows MMDevices registry (shared-mode default capture format). Nothing was recorded.

| Device (Windows name) | Channels | Rate | Bits | Notes |
|---|---|---|---|---|
| Microphone (PD200X Podcast Microphone) | 1 | 48 kHz | 24 | Intended vocal track. Matches spec. |
| Headset Microphone (Maonocaster E2 Gen2) | 2 | 48 kHz | 16 | Intended guitar track. This is the E2 **master mix** output. |
| Microphone (Maono AI Microphone) | 2 | 48 kHz | 16 | **Virtual** device (Maono AI noise software, `ROOT\MEDIA`). Must not be used as the dry guitar input. |
| Microphone (EMEET SmartCam C60E 4K Dual) | 1 | 48 kHz | 16 | Webcam mic. Useful only as tuner fallback / video scratch audio. |
| Microphone (Iriun Webcam) | 2 | 48 kHz | 16 | Phone via Iriun (virtual). |
| Stereo Mix, CABLE Output, Steam, EMEET Virtual | – | – | – | Loopback/virtual. Exclude from the guitar/vocal pickers by default. |

## What this means for Milestone 2
- Both real devices run at 48 kHz, but each has its **own USB clock**. Same rate does not mean in sync. Drift must be measured and corrected.
- No ASIO driver was found for either device. Plan: WASAPI (shared first, exclusive as an option).
- The E2 USB output is a mix. If E2 loopback, its mic input, or playback return is turned on, the "guitar" track will contain that audio. The setup screen must check this (play a test tone, look for it in the E2 input).
- Open question for M2: does the E2 put the guitar on one channel or both? Test with the guitar connected.
