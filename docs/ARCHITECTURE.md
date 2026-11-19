# Architecture

```
 ┌────────────── Worship Studio.exe (JUCE 9, C++) ───────────────┐
 │  WebView2  ── React UI (ui/dist) ── bridge.ts                  │
 │     ▲ native functions / events (MainComponent.cpp)            │
 │  Engine  (audio thread, WASAPI)                                │
 │    tracks (memory-mapped WAV) → gain/mute/solo → Signalsmith   │
 │    stretch (tempo/pitch) → resample → + click bus + cue bus    │
 │    tuner input → FIFO → YIN pitch (message thread)             │
 │  Library (project folders)   Exporter (offline WAV render)     │
 │  Jobs ── spawns ──► analysis/.venv python run_wsa.py           │
 └────────────────────────────────────────────────────────────────┘
          Python sidecar (separate process, JSON lines on stdout)
          separate.py  (audio-separator: Demucs / RoFormer, guitar pan split)
          rhythm.py    (beat_this or librosa)   harmony.py (key, chords)
          structure.py (sections)               tts.py (Windows SAPI cues)
```

Key rules
- Heavy AI never runs in the app process. Cancel = kill the sidecar. Partial output goes to `.work/` and is moved in only when complete.
- `song.json` = user data (chart edits, cues, mixer, capo...). Only the UI writes it. `analysis.json` = machine output. Re-analysis never touches user edits.
- Click and spoken cues are scheduled on the song timeline *after* time-stretch, so they are never pitch-shifted, and they are excluded from exports by default.
- Count-in = engine pre-roll: clicks/cues play on the grid before the start point while song audio stays silent.
- All tracks of a song share one sample rate; the engine resamples to the device rate.
- Original files are never modified. Stems + residual sum back to the mix.

Folders: `app/` C++ host · `ui/` React · `analysis/` Python · `spikes/` feasibility scripts + reports · `docs/`.
