# Separation feasibility report — benchmark song

Song: *Tanging Kailangan (Acoustic)* — Victory Worship (local MP3, 5:43, 44.1 kHz stereo). Not committed.
PC: Ryzen 7 5700U, RTX 3050 Ti Laptop 4 GB, 23 GB RAM. Date: 2026-10-02.
Scripts: `separation_spike.py`, `residual_check.py`, `guitar_split_spike.py`, `guitar_pan3_spike.py`. Outputs in `spikes/out/` (git-ignored).

## 1. Full-band models

| Model | Time (GPU) | Peak VRAM | Peak RAM | Stems with real content | Mix − stems residual |
|---|---|---|---|---|---|
| Demucs `htdemucs_6s` (MIT) | 66 s | 1.1 GB | 4.0 GB | vocals −17 dB, guitar −21 dB, piano −51 dB | −18.8 dB (artefact, see correction; true ≈ −26 dB) |
| `BS-Roformer-SW` (license unverified) | 466 s | 2.4 GB | 3.2 GB | vocals −17 dB, guitar −21 dB | −17.6 dB |

- Drums, bass, "other" are near-silent (−58 to −106 dB). The arrangement is vocals + acoustic guitars.
- The two models' guitar stems correlate at **0.984**: on this song the slow model adds almost nothing.
- Guitar-vs-vocal stem correlation: 0.04 (Demucs), 0.02 (RoFormer) → little shared signal between them.
- **Correction (sound-engineer review, 2026-10-02):** the −18 dB "residual" above was mostly an artefact. audio-separator peak-normalised each stem (vocals ×0.886, guitars ×0.901) because the mix peaks above its 0.9 threshold, so ghosts of every stem leaked into the residual. Fix: feed the separator the mix at −6 dB with the threshold at 1.0 and restore the gain. Re-measured in the app: residual **−26.1 dB**, residual-vs-vocal correlation 0.03, and mix − (all stems + leftover) = **−152 dB** (exact null).
- The app keeps the remaining loss as a "Leftover" track so "everything on" = original.
- CPU timing for Demucs not measured yet (expected several minutes).

**Decision:** default preset = Demucs `htdemucs_6s`. RoFormer stays as an optional "Detailed" preset, flagged as unverified license.

## 2. Three acoustic guitars — what can and cannot be separated

No available model separates "rhythm vs lead vs capo" acoustic guitars. Both models output **one** guitar stem.

Second pass tried on the guitar stem:

- **Stereo position (pan) split — promising, experimental.** The guitar stem is wide (L/R correlation 0.21). Energy by pan position shows a centre bump, a strong right bump (+0.46) and a left shoulder. A left / centre / right mask split gives:

| Part | Energy | Brightness | Active | Role hint (not proven) |
|---|---|---|---|---|
| Left | 25% | 759 Hz | 79% | brightest → maybe capo / high part |
| Centre | 29% | 477 Hz | 75% | ? |
| Right | 44% | 425 Hz | 88% | loudest, most active → maybe strumming |

  Envelope correlation between parts ≈ 0.41–0.44 → clear **leakage**. Parts are not clean isolations.
  A second measurement method (sound-engineer review) found coherent leakage L↔C −17 dB, C↔R −18 dB, L↔R −36 dB, and ~22% of the centre part's energy in rapidly switching bins (risk of a "watery" sound). The app now smooths the pan mask over 5 frames and uses a wider crossfade. Listening test still required.
  The three masks sum to 1, so the parts always add back to the exact guitar stem (safe to mute all three).
- **Register split (low/high at 400 Hz):** written for listening only. Not used in the app: one guitar spans both bands, so this splits sound, not players.

**Verdict:** we can give three synchronized, independently controllable guitar *regions* labelled by position, with honest hints. We cannot claim three isolated performances. JP must listen to `spikes/out/guitar_pan3/*.wav` and say which part matches which player.

## 3. What would improve it
- Separately supplied multitracks (best and only reliable way).
- A future trained "lead vs rhythm guitar" model can plug into `analysis/wsa/separate.py` as a new preset.
- Per-section pan/role tracking (players may move between parts).
