# Design rationale

## Who and when
A guitarist preparing for Sunday, often holding the guitar. Sessions are evening, often dim → dark theme default, light theme available.
Baseline window: 1366×768 laptop at 100–125% scaling. No horizontal scrolling in normal work.

## Look: Stage light (2026-11-19)
Chosen by JP from two mockups (`.taste-skill/mockups/a-stage-light.html`; B "Console" was the dense alternative).
- Dark: warm near-black ground `#0e0d0c`, cards are lighter steps (`#181716`, `#211f1d`, `#2a2826`), no borders or shadows.
  Light: warm paper `#f4f2ee`, white cards, ink text.
- One stage-light amber only on live data: the chord now playing, the playhead, meters (`#f2b33d` dark, `#a86a12` light).
  Nashville numbers, diagrams and sections are ink and grey.
- Primary and "on" controls are inverted pills (white on dark, black on light). Record is the one red.
- Inter (bundled, works offline). Top menu bar with five text links. Session: song 2/3 beside the camera 1/3 (both 16:9),
  take under the camera, chords → timeline → mix → your inputs under the song.
- Everything lives in `ui/src/styles/stage.css` as tokens; screens follow the UX check in
  `.claude/skills/modern-web-guidance/SKILL.md`.

## Principles
1. **One task per workspace.** Each screen answers one question: *Which song? What do I play? Let me practice. Let me record. Let me finish.*
2. **Transport lives in one place** — a persistent bottom bar. Never duplicated inside panels.
3. **Estimates look like estimates.** Every machine result carries a confidence badge (text + dot shape, never color alone). Confirmed user data looks solid; unconfirmed looks dashed.
4. **Three chord layers, three type styles.** Sounding chord = large, bold (amber while it plays). Nashville = grey, medium. Shape to play = small, with capo, plus diagram.
5. **Progressive disclosure.** Rehearse shows groups (Vocals, Guitars, Keys…). Guitar L/C/R parts open on demand. Technical details sit behind "Details".
6. **Honest unavailability.** Unbuilt workspaces show a "Planned" page with what will come. No dead controls.
7. **Hands-free first.** Space, arrows, [ ], L, M, K work everywhere outside text fields; R records, G / V monitor in Session; bindings are configurable. Large targets (≥ 36 px) on the transport.

## Task flow
```
Import ─► Analyze ─► Review (key, chords, sections, stems) ─► Prepare (capo, tuning, mute parts, cues)
      ─► Rehearse (play, loop, click, cues) ─► Record* ─► Studio*        (* planned, M2–M4)
```
The song header shows this flow as steps with done / current / todo state.

## Navigation map
```
Left rail (always)          Song workspaces (when a song is open)        Tools
─────────────────           ────────────────────────────────────         ─────
Library                     Prepare  ▸ Chart | Sections & cues | Stems   Tuner
  songs, import,            Rehearse                                     Settings
  setlists (planned)        Record   (planned – M2)                        audio, analysis,
                            Studio   (planned – M3/M4)                     shortcuts, theme, data
Bottom transport bar: play · position · section · now chord · loop · count-in · click · cues · mute guitars
```

## Screen inventory
| Screen | Purpose | State coverage |
|---|---|---|
| Library | find/import songs, analysis state | empty, importing %, error |
| Prepare › Chart | key, transpose, capo, tuning, chord chart edit, shape compare (open + CAGED) | not analyzed, low confidence, edited |
| Prepare › Sections & cues | section names/times, click settings, spoken cues | rendering voice, failed render |
| Prepare › Stems | stem list, levels, guitar split notes, analysis details, re-analyze | analyzing (progress/cancel), no stems |
| Rehearse | big now/next chord, timeline, grouped mixer, tempo/key | playing, count-in, loop |
| Record / Studio | planned pages | planned |
| Tuner | input pick, needle, strings | off, listening, no signal, virtual device warning |
| Settings | output device, analysis tools, shortcuts, theme, data folder | tools missing, device error |

## Tokens (see ui/src/styles/tokens.css)
- Spacing: 4 px grid (`--s1` 4 … `--s8` 48).
- Type: 12 / 13 / 15 / 18 / 24 / 40 / 64 px; Segoe UI Variable; tabular numbers for time.
- Radius: 6 / 10. Elevation via surface steps, not shadows.
- Color: neutral surfaces + one accent (blue). Status colors always paired with text/icon.
- Track roles (same everywhere): vocals = rose, guitar = amber, keys = violet, bass = green, drums = cyan, other/residual = grey, click = slate, cues = teal.

## Components
Button (primary / secondary / quiet / danger), IconButton with label, Segmented, Field, ConfidenceBadge, Meter (segmented, CLIP text), TrackStrip, TrackGroup, ChordCard, ChordDiagram, ShapePicker, Timeline, TransportBar, FlowSteps, Banner (info/warn/error), Toast, EmptyState, ProgressCard, PlannedPage, Dialog (confirm).
