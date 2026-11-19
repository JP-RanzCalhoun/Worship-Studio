# Models

| Use | Model | Source | Size / speed (RTX 3050 Ti) | License |
|---|---|---|---|---|
| Stems (default) | Demucs `htdemucs_6s` | Meta via audio-separator | ~66 s per 5.7 min song, 1.1 GB VRAM | Code MIT; weights research-only (see LICENSES.md) |
| Stems (optional "Detailed") | `BS-Roformer-SW.ckpt` | jarredou via audio-separator | ~466 s, 2.4 GB VRAM | unverified |
| Beats / downbeats | beat_this `final0` | CPJKU (cloud.cp.jku.at) | seconds | MIT |
| Beats fallback | librosa beat tracker | built in | seconds | ISC |
| Notes for chords | Basic Pitch `nmp.onnx` (ICASSP 2022) | Spotify, inside the `basic-pitch` package; SHA-256 recorded in analysis.json `notes` | ~5-13 s per song (CPU) | Apache-2.0 |
| Key / chords / sections | own template + Viterbi / novelty code (`analysis/wsa`); chords from 70 % notes (held drone notes removed) + 30 % spectrum | this repo | seconds | project |
| Guitar left/centre/right | own stereo pan mask (`separate.py`) | this repo | seconds | project |
| Spoken cues | Windows SAPI | OS | instant | OS |

Adding a model: add a `Preset` in `analysis/wsa/separate.py`. Run `spikes/separation_spike.py` first and record results in `spikes/REPORT-separation.md`.
