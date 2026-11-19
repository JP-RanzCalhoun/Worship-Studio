# Dependency and model license inventory

No license has been chosen for this project yet. That decision is the owner's.

| Component | Version | License | Impact |
|---|---|---|---|
| JUCE | 9.0.3 | **AGPLv3** or commercial JUCE licence | A public release using free JUCE must be AGPLv3 (source must be offered, including to network users). A paid JUCE licence removes this. **Biggest licensing decision.** |
| JUCE webview-interop (protocol only, re-implemented in `ui/src/bridge.ts`) | — | AGPLv3 / JUCE | Same as JUCE |
| Microsoft WebView2 SDK | 1.0.3485.44 | BSD-3-Clause-style (Microsoft) | Redistributable; keep notice |
| Signalsmith Stretch / Linear | 1.4.0 / 0.6.4 | MIT | OK |
| React, Vite, TypeScript, Vitest | see ui/package-lock.json | MIT | OK |
| python-audio-separator | 0.47.0 | MIT | OK |
| Demucs code | 4.1.0 (maintained at adefossez/demucs; facebookresearch repo archived) | MIT | OK |
| Demucs `htdemucs_6s` weights | — | **Not MIT.** Maintainer (demucs issue #327): "provided only for scientific purposes"; README: licence "not clear" | **Not cleared** for church or public use, nor for distribution. Personal experiments only until replaced or cleared in writing (decision: JP). Checked 2026-11-17. |
| beat_this (code + weights) | 1.1.0 | MIT | OK (some training audio copyrighted; weights released MIT) |
| BS-Roformer-SW weights | — | **Unverified** (community) | Optional preset only. Do not bundle or redistribute until verified. |
| librosa, numpy, scipy, soundfile, psutil | see requirements.txt | ISC / BSD / BSD / BSD / BSD | OK |
| PyTorch | 2.11 | BSD-style | OK |
| onnxruntime-gpu (pulled in by audio-separator) | 1.30 | MIT | OK; runs the Basic Pitch model |
| Basic Pitch (code + `nmp.onnx` model, Spotify) | 0.4.0 | Apache-2.0 | OK; keep the notice. Installed with `--no-deps` (no TensorFlow) |
| mir_eval, pretty_midi, mido, importlib_resources (Basic Pitch needs) | see requirements.txt | MIT / MIT / MIT / Apache-2.0 | OK |
| Windows SAPI voices | OS component | Windows license | Cues rendered locally; voices are not redistributed |

Never committed or redistributed: songs, stems, recordings, model weights, VST3 plug-ins, API keys.
FFmpeg is not bundled.

Recommendation (for the owner to decide later): with free JUCE, AGPLv3 is the only compatible open-source choice. Every other dependency above is compatible with AGPLv3.
