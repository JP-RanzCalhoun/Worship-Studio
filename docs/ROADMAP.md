# Worship Studio — Roadmap & checklist

The single source of truth for what is done, in progress, and next.
Legend: `[x]` done and verified · `[~]` built, not fully verified · `[ ]` to do · `[!]` blocked (needs JP)

Quality rule for every milestone: independent review (live UI, code, sound engineer) → fix all P0/P1 → re-check →
weighted scorecard ≥ 4/5 in every area (see `CLAUDE_BUILD_PROMPT.md`, "Independent critique, UI QA, and fix gate").

---

## M0 — Feasibility spikes  ✅
- [x] Toolchain (VS 2022 Build Tools, CMake, JUCE 9.0.3, WebView2, Python venv with CUDA PyTorch)
- [x] Stem separation spike on the benchmark (`spikes/REPORT-separation.md`)
- [x] Guitar left/centre/right split (estimate; listening test pending, see "Waiting for JP")
- [x] Device probe (`spikes/REPORT-devices.md`)

## M1 — Rehearse (song prep + practice)  🟡 review round 4 pending
- [x] Library, import, analysis (stems, key, chords, beats, sections) with progress/cancel
- [x] Prepare: chart (sounding / Nashville / shape), capo ideas, CAGED + open shapes, tunings, edit + undo, print/PDF
- [x] Click & spoken cues, count-in, nudge, tap tempo
- [x] Rehearse: now/next chord, timeline, grouped mixer, mute reference guitars, loop, tempo/key, master + safety limiter
- [x] Tuner, Settings (output, theme, shortcuts)
- [x] UX redesign per design brief (`docs/DESIGN.md`)
- [x] Review rounds 1–3: all P0/P1 fixed and re-checked
- [~] Review round 4 (final gate) — scores: usability 3, visual 4, a11y 3, audio routing 4, playback 4, click timing 4,
      recording alignment 1 (before fixes). Fixed since: Browser view hidden (P0), takes lined up from a stale clock (P0),
      armed input without device (P1), transposed takes (P1), plus 9 P2/P3.
- [x] Independent re-check: all P0/P1 verified (Browser UX 4, Record UX 4, recording alignment 4.5). No P0/P1 open.
- [ ] Re-score usability and accessibility (were 3 before the fixes) to close the gate
- Known P3 (left): tempo/key/solo are not locked during a take (only checked at Record)
- [x] Window fits the screen at any display scaling

## M2a — Built-in browser + capture  🟡 built and self-tested, independent review pending
- [x] Browser page: YouTube inside the app (search, back/forward/reload); page stays loaded when hidden
- [x] "Record what plays here": Windows process-loopback capture of the browser only → 48 kHz WAV
      (tested: 12 s and 24 s captures; the app's own playback is NOT captured: −90 dB)
- [x] Recording keeps running when you leave the page; left menu shows "REC m:ss"; state restored on return
- [x] Video set to 100% volume on Record (the capture follows the video's volume slider)
- [x] "Save as song & analyze": imports, opens the song, analysis starts automatically (tested end to end)
- [x] Songs remember their source video; "▶ Reference video" button opens it in the Browser page
- [x] Code review round 1 (correctness 3, reliability 2–3): 3 P1 + 6 P2 + 7 P3 found
- [x] Fixed: click on pause/seek (P1), failed Save deleted the take (P1), wrong title/link after YouTube page change (P1),
      silent stall / disk full / slow start / close while recording (P2), click headroom (P2), 6 of 7 P3
- [x] Self-tested: page change followed, quiet-tone take (−50 dB in = −50 dB out), close while recording asks first,
      take + name survive a restart, Save → song with the right link, output-stage checks (`LimiterTest`)
- [x] Re-check by an independent reviewer: 13/15 fixed; new findings fixed (crash-left take repaired, volume script
      after failure/page load, Discard during Save, shutdown keeps the take name)
- [x] Live UI review (round 4): YouTube view was hidden under the app (P0) → fixed and verified on screen
- Known P3 (left): tempo/key change during a mid-song count-in skips the rest of the count-in;
  a take is named after the video open at Stop (autoplay can switch it); a removed USB/Temp drive mid-take is not reported

## M2b — Record yourself (audio + video)  🟡 in progress
- [x] Spike: two USB inputs at once, drift (`spikes/REPORT-dualinput.md`). Stand-ins PD200X + EMEET: 0.14 ppm, gaps found
- [!] Same test with the real pair E2 Gen2 + PD200X (E2 must be plugged in)
- [x] Recorder engine `InputRecorder`: own WASAPI stream per device, 24-bit WAV, timing per packet, lost samples filled
- [x] Drift + offset correction after the take (`alignTake`), tested on synthetic audio
- [x] Record page: Guitar + Vocal inputs (E2/PD200X guessed), live meters (nothing stored), Record/Stop with count-in,
      takes in `<song>/takes/take-NNN/` (raw + lined up + take.json), takes list
- [x] Loopback test (virtual cable, silent, no mic): takes repeat within about ±4 ms (cable buffer), no drift inside a take;
      start-up skips (first 0.25 s of every stream) are filled but no longer reported as lost sound
- [x] Takes with count-in and takes started while playing line up (4/4, 160–165 ms constant cable delay, no jumps)
- [x] Recording blocked at a changed key or tempo; armed input without a device blocks Record with a clear message
- [x] Inputs ask Windows for the raw stream (no effects); accepted on this PC
- [x] ~~Latency calibration~~ — built as play-along calibration, then removed (JP: not accurate). Takes line up from the device
      timestamps; a per-take manual nudge is the planned replacement
- [ ] Warn when Windows audio effects are active on an input (Windows 11 effects API)
- [x] Play a take with the song: "Play with the song" on the Record page; it shows as "Your takes" in the mixer
      (tested: a take played back and recorded again lands at exactly twice the path delay)
- [ ] Delete takes, more than one take at once, takes in the rehearsal-mix export
- [x] Monitoring (changed 2026-11-17): software monitoring of guitar and vocal into the output device (PD200X), per-input level;
      shared low latency ≈ 35 ms (default), exclusive ≈ 26 ms; drift buffer with snap-back. JP: clean
- [x] Engine timing fix: music was ~2 ms behind the click (resampler delay); pause tail replayed the right channel; song-end cue cut
- [x] Camera probe (`spikes/REPORT-camera.md`): EMEET 1080p60/30 NV12 is the default choice
- [x] Camera capture in the app (browser MediaRecorder, MP4 H.264, 1080p60 or 4K30, full frame) — [~] not yet recorded in a real take
- [ ] A/V sync calibration, picture-in-picture, chord/section overlay
- [ ] Export a share-ready video (decide codec/licensing → [!] JP, critical)

## Audit 2026-11-17 plan (ChatGPT + Muse audit, reconciled in `docs/AUDIT-2026-11-17.md`; order approved by JP)
- [x] Gate: first reviewed git commit + tag `v0.1.0-baseline`
- [x] Phase A — stop losing work, stop hangs, accessibility foundations (independent review: P1 watchdog + 5 P2 fixed)
      - [x] Bridge: per-call timeouts, safe JSON, re-hook · [x] chart merge keeps added/split chords, per-section merge, one undo step
      - [x] Reset / new estimates clear "Ready" · [x] F#/C#m keys spelled with sharps · [x] unique stem folders + path check
      - [x] Cancel kills the whole sidecar tree (tested: no process or work folder left) · [x] 20-min watchdog (on a timer; the first version never ran) · [x] Cancel right after Start kills the real Python too · [x] job-exit race
      - [x] Quiet stems (−30 to −45 dB) kept, muted at first · [x] model files + SHA-256 in analysis.json · [x] beat-this==1.1.0
      - [x] Export: one sample rate, live output stage (music −1.5 dBFS, click floor), less memory (audit's left-channel claim was wrong)
      - [x] Browser capture: dropouts filled with silence; video volume/mute restored after recording (tested)
      - [x] Takes: disk check first, unfinished takes listed, tempo-scaled jump test · [x] tuner start/stop never leaves song muted
      - [x] Engine-sync failures shown; only changed mixer parts sent · [x] npm test script (24 tests then; 38 on 2026-11-17 evening)
      - [x] A11y: dialog focus trap + focus return (tested), Library rows are buttons, page zoom allowed (Browser view follows it)
      - [x] Unverified model needs an explicit opt-in · [x] LICENSES/MODELS/SETUP corrected
      - audio-separator stays pinned at 0.47.0 (the 0.48 re-pin in the audit plan is not done: it needs a fresh-install test)
      - Left for Phase D: 38 lint warnings (hook dependency patterns), wide layouts scroll at high zoom instead of reflowing
- [~] Session screen (OBS-style, approved by JP 2026-11-17; mockup `docs/mockups/session.html`) — built, code-reviewed,
      review fixes applied, committed 8bb5b06. Replaces Browser, Rehearse and Record pages; 72 px icon rail.
      - [x] Get this song (record the video once → stems, chords, sections, cues), supervised at app level, ends at video end
      - [x] Left scene: muted YouTube video follows the player (tested ±0.1 s); ±0.1 s sync nudge
      - [x] Right scene: camera preview (EMEET 1080p30 tested); take records camera video to <take>/video.webm (tested, canvas)
      - [x] Live chord band (chord, Nashville, shape, beats, next 3, section); mix strips; input strips; take panel
      - [x] Projector window (chords / camera) on any display; main page stays loaded when minimised
      - [ ] Live checks with JP: Get this song with a real video, projector on a 2nd display, real E2 + PD200X + camera take
- [~] Learning (approved 2026-11-17): [x] learn-while-playing switch · [x] prepare-ahead queue · [x] skip-ahead cancels · [x] live test (ads, save, analyse)
      · [x] autoplay paused after learning · [x] stall warning · [x] freeze nudge + YouTube player-API seek + mid-song jump cancels [ ] retest these
      · [ ] live rough chords on first play · [ ] quiet learning (route the browser to VB-Cable; pageListen exists)
- [x] Chart-first chords: band, waveform, transport and projector show only imported/checked chords; "Show guesses" switch
- [x] Smoke-test fixes: key spelling (Eb), hidden title characters, Undo import, wording
- [~] Session additions 2026-11-17 (JP):
      - [x] Live monitoring guitar + vocal (see M2b) · [x] output modes · [x] YouTube through the app in exclusive mode (automatic)
      - [~] Solo recording (Library › Record solo → new song: mixdown + dry tracks + camera) — not yet recorded with the E2
      - [~] Ambient pad (made in code: root/5th/octave, Warm/Shimmer, song key) — not yet heard by JP
      - [x] OBS-style layout: draggable lines (width/height, remembered), camera Pop out window (on top, mirrored)
      - [x] YouTube: Browse mode (Go/Browse = full page, Done/Learn returns), Video only (letterboxed player)
      - [x] Camera: letterboxed preview, focus auto/fixed, quality 1080p60/4K30, looks (GPU LUTs, .cube import),
            auto colour fix, in-camera white balance/exposure/tone
- [~] Charts (approved 2026-11-17): [x] ChordPro/SongSelect + paste import, aligned (capo-aware) · [x] lyrics in chord band + projector · [x] chord-sheet search window · [ ] repeated sections · [ ] live test
- [ ] Phase B — trustworthy recording (device IDs, setup wizard, effects check, calibration, take recovery, real E2 test)
- [ ] Phase C — "Sunday mode" (setlist, arrangement, lyrics + chords stage view, pedals, rehearsal pack, preflight)
- [ ] Phase D — UX polish + 15-minute north-star test
- M3 (VST3) and video come after Phase D.

## M3 — Live VST3 + Studio  ⬜
- [ ] VST3 scan (out of process), per-track chains, delay compensation, state saved per song
- [ ] Noise check (hum/buzz), reversible cleanup
- [ ] Mix and master workflow

## M4 — Setlists & rehearsal packs  ⬜
- [ ] Setlists, transitions, offline rehearsal pack export
- [ ] MIDI / Bluetooth foot pedal

---

## Waiting for JP (critical or needs your ears/hands)
- [!] Turn OFF "AI noise cancellation" / sound enhancements (Maono Link, "intelliGo" effects) for the PD200X, the E2 Gen2
      and VB-Cable in Windows Sound settings: on this PC they pass only speech (guitar and click came out as silence),
      even when the app asks Windows for raw input. Dry guitar takes need this off.
- [!] Listen to `spikes/out/guitar_pan3/*.wav`: which part is strumming / capo / lead?
- [!] Plug in the E2 Gen2 (tuner, solo take, recording tests); listen to the pads; retest Learn this song
- [!] Delete the two broken test songs from 2026-11-17 ("Still - Wood Room Sessions" 31 s, "Goodness of God" 32 s)
- [!] Delete "WE PLAY YOU SING" zips yourself if you want the 107 GB back (I may not permanently delete files)
- [!] Licensing before any public release (JUCE AGPL vs paid; YouTube capture is for personal study)
- [!] Demucs weights are uncleared for non-scientific use (demucs #327): benchmark clearly licensed models, or get written permission, before the church relies on it

## Decision log (made without JP, non-critical)
- 2026-10-03 — Browser capture records the browser's sound (process loopback) instead of downloading: no extra download tools, works like recording the speakers.
- 2026-10-03 — Browser uses the same WebView2 profile as the app screens (one browser process tree to capture; YouTube sign-in persists).
- 2026-10-03 — Captures are 48 kHz / 16-bit WAV, kept private in the song folder; songs store the source URL.
- 2026-10-03 — Recording sets the video to 100% volume (a 2% video volume gave a −36 dB recording); room loudness = Windows volume.
- 2026-10-03 — Browser page keeps YouTube loaded when hidden (JUCE unloaded it by default, which stopped the music).
- 2026-10-03 — Recording uses its own WASAPI streams (not JUCE inputs): JUCE hid a 10 ms jump; the own path detects and fills gaps.
- 2026-10-03 — Drift/offset is corrected after the take (resample to the playback clock), not live. Monitor through the device (zero latency).
- 2026-10-03 — Camera default: EMEET 1920×1080, 30 fps, NV12 (60 fps optional). 4K is not the default (30 fps only, heavy).
- 2026-10-03 — Click stays audible: the click is turned down at most 6 dB; if more room is needed, the music dips briefly (typ. ≤ 2 dB).
- 2026-10-03 — Takes are recorded only at tempo 100% (a take must match the song's real speed).
- 2026-10-03 — Takes keep the raw files next to the lined-up files, so the line-up can be redone (reversible).
- 2026-10-03 — Minimum window width 1100 px (below that the transport and right column were cut off).
- 2026-10-03 — Short takes (< 20 s) keep the song-clock speed at exactly 1 (fit offset only): the slope is mostly jitter there.
- 2026-11-17 — (JP) Roadmap reordered after the ChatGPT + Muse audit: commit → Phases A–D (thin M4 "Sunday mode") before M3 VST3 and video.
- 2026-11-17 — (JP) One OBS-style "Session" screen replaces the Browser and Record pages; it takes in Phase B and comes before Phase C.
- 2026-11-17 — (JP) Left navigation becomes a narrow icon bar (72 px) so the Session screen and the live chord display get the room.
- 2026-11-17 — (JP) Learning: prepare ahead automatically with a queue, plus learn-while-playing (no download tools).
- 2026-11-17 — (JP) Charts: SongSelect/ChordPro import + search window + paste-to-import; no automatic copying from chord sites (their terms, lyrics copyright).
- 2026-11-17 — Camera video is WebM VP8 (royalty-free, light CPU); clock pairs in video.json for later A/V alignment.
- 2026-11-17 — Handoff for the next session: `docs/HANDOFF.md`; dev test helpers in `tools/dev/`.
- 2026-11-17 — (JP) Live monitoring in software: guitar (E2) and vocal (PD200X) heard in the PD200X headphones (replaces "hardware only").
- 2026-11-17 — (JP) Play-along latency calibration removed (not accurate); takes rely on device timestamps; a manual nudge comes instead.
- 2026-11-17 — (JP) Exclusive output mode kept for recording (≈ 26 ms, 3 ms blocks; 5 ms blocks gave no gain); shared low latency is the default so YouTube stays audible.
- 2026-11-17 — Automatic exclusive↔shared switching while YouTube plays was tried and dropped: each switch restarts the device and YouTube stalls.
- 2026-11-17 — In exclusive mode the app plays the YouTube page's sound itself (process loopback, listen-only): no Windows setting needed.
- 2026-11-17 — (JP) Detected chords are hidden by default (often wrong); imported or checked chords only, "Show guesses" to see them.
- 2026-11-17 — (JP) Camera video is MP4 H.264 (1080p60 default, 4K30 option), replacing WebM VP8; for distribution check H.264 terms later.
- 2026-11-17 — (JP) Camera looks are baked into the recording (GPU 3D LUT, .cube import); auto colour fix uses grey-world on mid-tones.
- 2026-11-17 — (JP) Solo takes become new songs (mixdown imported; dry tracks and video kept in the take folder).
- 2026-11-17 — (JP) Ambient pads are synthesised (no samples, no licence): root, fifth, octave; fits major and minor.
- 2026-11-17 — Chord guesses are named from Basic Pitch notes (Apache-2.0, ONNX, no TensorFlow): 70 % notes + 30 % spectrum per beat. Notes that ring under every chord are removed first (each pitch loses 80 % of its 32-beat median); without that, a ringing Eb kept "Mighty To Save" on Eb for 80 s. If Basic Pitch is missing or fails, the old spectrum-only chords are used with a warning.
