# Worship Studio

A Windows desktop app for a worship guitarist's week: learn a song from YouTube, split it into parts, read the
chords, practise with click and spoken cues, hear your guitar and vocal live in headphones, and record takes
(with the camera) lined up with the song.

**Status:** personal and church use, in active development. Not a release: there is no installer, and no licence
has been chosen yet (see [`docs/LICENSES.md`](docs/LICENSES.md)). This repository is shared so reviewers can read
the code.

## For reviewers: start here

1. [`docs/HANDOFF.md`](docs/HANDOFF.md): what the app does today, what was built and verified, known issues, next steps.
2. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): how the C++ host, the React UI and the Python analysis fit together.
3. [`docs/DESIGN.md`](docs/DESIGN.md): who it is for, the design principles and the "Stage light" look.
4. [`docs/ROADMAP.md`](docs/ROADMAP.md): the checklist and the decision log.
5. [`docs/AUDIT-2026-11-17.md`](docs/AUDIT-2026-11-17.md): the last outside review and what was done about each finding.

The app runs only on Windows with its audio devices, so reviews are of the code, the docs and screenshots.

## What is where

| Folder | What |
|---|---|
| `app/src` | C++ host (JUCE): audio engine, live monitoring, input capture and takes, buzz cleanup, pads, YouTube capture, camera projector |
| `ui/src` | React + TypeScript UI in WebView2. `views/` screens, `session/` the Session pieces, `styles/stage.css` the look |
| `analysis/` | Python sidecar: stem separation, beats, chords, sections, spoken cues |
| `docs/` | Handoff, architecture, design, roadmap, audits, licences, setup |
| `.taste-skill/mockups/` | The design mockups the current look was chosen from |
| `.claude/skills/` | Google Chrome's modern-web-guidance (Apache-2.0), used as the UI and UX reference |
| `spikes/`, `tools/dev/` | Feasibility tests and developer helpers |

Not in the repository: songs, recordings, AI model weights and build output.

## Build

See [`docs/SETUP.md`](docs/SETUP.md). In short:

```
cd ui && npm install && npm run build && npm test
cmake --build app/build --config Release --target WorshipStudio
```
