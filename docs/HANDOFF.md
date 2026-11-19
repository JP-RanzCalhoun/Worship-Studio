# Handoff — Worship Studio (for the next Claude session)

Updated 2026-11-19 (late) by the Claude session that did the smoke test, monitoring, solo, pads, camera looks, the
guitar buzz cleanup, the Stage light UI/UX revamp, the public GitHub copy and the PD200X vocal work (§3b, §3c).
Read this first, then §4b (outside repo reviews and the agreed next order), `docs/ROADMAP.md` (checklist and decision
log) and `docs/AUDIT-2026-11-17.md`.

---

## 1. Who and what

- **Owner: JP** — worship acoustic guitarist (Ibanez AAM50CE). Gear: Maonocaster **E2 Gen2** (USB, guitar input,
  "Headset Microphone (Maonocaster E2 Gen2)"), Maono **PD200X** (USB, vocal mic; its headphone jack is JP's monitor,
  "Speakers (PD200X Podcast Microphone)"), **EMEET C60E 4K** webcam. Laptop: Ryzen 7 5700U, RTX 3050 Ti 4 GB,
  23 GB RAM, Windows 11, one display at 1280×720 CSS px (300 % scaling).
- **App: Worship Studio** — Windows desktop app for Sunday prep and recording: AI stems, chords, click + cues, tuner,
  built-in YouTube with "learn this song", live monitoring, guitar + vocal takes lined up with the song (or solo),
  camera recording with looks, ambient pads. Personal + church use now; maybe public later.
- Original brief: `Documents\ChatGPT\Stem Separator software\CLAUDE_BUILD_PROMPT.md` in JP's user folder (not in the repo).
- This repo lives on JP's PC (the Claude session that worked on it
  today ran from another folder; open the next session in the repo folder instead).

### How JP wants to work (important)
- **Push back.** JP wants expert recommendations, not agreement. At most 2 options, the context, and your pick.
- **Commit only when JP says "commit".** Repo is local only. Trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Never permanently delete** user files (Recycle Bin only); never delete JP's library songs.
- **Audio safety:** nothing loud, no stored mic audio unless JP is present and agrees; test silently through
  VB-Cable when possible and put JP's output device back afterwards.
- JP judges sound by ear: build, measure what you can (`monitorStatus`, levels), then ask him to listen.
- Reply style: short and plain.
- **Slack:** private channel `#claude-chatgpt` for Claude/ChatGPT/Muse audits (find it with Slack channel search); prefix `[Claude]`.

---

## 2. Architecture (current)

```
Worship Studio.exe (JUCE 9.0.3, C++) — app/src
├─ WebView2 #1: React UI (ui/dist) ⇄ bridge.ts ⇄ native functions/events (MainComponent.cpp)
├─ WebView2 #2: SiteBrowser (YouTube), placed over a placeholder in Session (useSiteView, polls every 200 ms);
│    "Video only" CSS on watch pages (videoOnlyScript); siteVideo uses YouTube's player API (seekTo/playVideo)
├─ ProjectorWindow: 3rd WebView2 — full screen on a display, or windowed (index −1: the camera "Pop out", on top)
├─ Engine (audio thread): song (stems → stretch → resample → limiters) via processBlock(), then addMonitor():
│    live monitor taps (stereo) + PadSynth, soft ceiling −1 dBFS. Output modes: shared / shared low latency /
│    exclusive (Engine::setOutputMode; exclusive 3 ms blocks ≈ 26 ms monitor, shared ≈ 35 ms)
├─ MonitorTap: SPSC ring between an input clock and the output clock, adaptive resampler (±0.3 %), margin grows
│    1 ms per dropout after a 3 s start-up grace, snaps back when > 40 ms behind
├─ InputTrack/InputRecorder: own WASAPI stream per USB input (raw, QPC timestamps, gap fill); monitor streams ask
│    IAudioClient3 for the smallest period (E2/PD200X drivers refuse: 10 ms packets)
├─ RecordSession: takes lined up with the song clock (stop) or with each other (stopSolo); per-input calibration
│    parameter exists but nothing sets it (calibration UI was removed)
├─ BrowserCapture: process loopback of the WebView. Learn = to a WAV; pageListen = listen-only into a MonitorTap
│    (YouTube through the app in exclusive mode)
├─ InputCleanup (header-only): per input, hum notches (60/50 Hz + 7 harmonics, Q 40) and a no-delay noise gate
│    (0.5 ms open, 80 ms hold, 150 ms close, −40 dB floor), then optional **Vocal polish**: 90 Hz low cut, auto-leveler
│    ("distance lift", up to `lift` dB, moves only while singing above gate threshold + 6 dB), 3:1 compressor at
│    −18 dB (+2 dB make-up), 6 kHz de-esser (up to −8 dB), +2.5 dB at 4 kHz, soft ceiling −1 dBFS. No look-ahead.
│    Live on the monitor copy and on the lined-up take; the raw file stays dry. Native `inputCleanup(label, {hum,
│    humHz, gate, thresholdDb, vocal, lift})`, `inputCleanupPeak(label)` (dB). Offline check: `CleanupRender` (§6)
├─ Clean vocal: sidecar `clean-vocal` (htdemucs_6s, keeps the vocal stem) → `takes/<take>/Vocal.clean.wav`; native
│    `cleanVocal(song, take)` (≈ 70 s for 4.5 min on the GPU) and `useCleanVocal(song, take, on)` switch the take's
│    Vocal track (`file` / `fileOriginal` / `cleanVocal` in take.json). Vocal.wav and raw/ are never changed.
│    Library::tracks: a **solo** song (take.json `"solo": true`) with an activeTake plays its take tracks only (the
│    take is the song), so the cleaned vocal is what is heard and exported
├─ PadSynth (header-only): root+5th+octave drone, wavetable, breathing low-pass, juce::Reverb, key crossfade
├─ Library (Documents\WorshipStudio\Songs), Exporter, Jobs (Python sidecar)
└─ analysis/ (Python 3.12): audio-separator + Demucs, beat_this, own chords (templates + Viterbi), sections, cues
```
UI key files: `views/Session.tsx` (main screen: SourceBar, scenes, chord band, mix, "Your inputs" cards, take panel,
solo panel), `session/` (MonitorControls = `useMonitorControls` hook: `row(label)` for each input card + `output`
settings, PadStrip, SceneSplit, CameraLookPanel, cameraLook.ts, useCamera, useGetSong, useLearning, useShowGuesses,
ImportChart, ChordBand), `views/Projector.tsx`, `chart.ts` (shownChords), `engine.ts` (every native call),
`components/ui.tsx` (Button, `Modal` = native `<dialog>` + showModal + closedby="any", `Popover` = popover="auto" +
anchor positioning, ConfirmHost), `shortcuts.ts` (actions; Session-owned ones go out as a `ws-action` event).
**Look:** `styles/stage.css` (Stage light, loaded last over tokens/components/layout; dark and light tokens, Inter
from `@fontsource-variable/inter`). Mockups and design notes: `.taste-skill/mockups/` (A = the chosen look).

---

## 3. State of the work (commits on 2026-11-17)

| Commit | What |
|---|---|
| `7256001` | Learning (learn while playing, queue), chart import (ChordPro, aligned), smoke-test fixes, first monitoring + calibration, chart-first chords |
| `995d87d` | Monitoring sweet spot (snap-back, start-up grace), timing calibration removed |
| `964d06d` | Solo recording, ambient pads, OBS-style layout (splitters, camera pop-out), Browse mode, Video only, camera 1080p60/4K30 MP4 + focus |
| `9dfcb6d` | YouTube sound through the app in exclusive mode (automatic) |
| `ef67c0d` | Camera looks: GPU 3D LUTs, built-in looks, .cube import, auto colour fix, in-camera settings |

### 3b. 2026-11-17 night → 2026-11-19

| Commit | What |
|---|---|
| `05cfdb1` | Muse re-critique fixes: device IDs, learning volume, timing note |
| `0b465f3` | Pads behind the guitar, four worship pad sounds, ducking, PadRender |
| `e5be519` · `c8ad2b8` | Solo-take recovery, video-sync notice, tonal chord knowledge; Basic Pitch chord guesses |
| `1159c49` · `f85cf39` | **Guitar buzz cleanup** (hum filter, gate, Learn noise) and the monitor panel tidy |
| `c2c22bd` · `32da28d` | Google's **modern-web-guidance** as a project skill (`.claude/skills/`, local guides, no npx; WebView2 = no fallbacks; UX check for a live player) |
| `e23b009` | **Revamp 1:** Stage light look, top menu bar (rail gone), Session in the mockup grid (song 2/3 16:9 beside the camera, take under the camera; chords, timeline, mix, inputs under the song; drag splitters off in this layout), input cards, unplugged inputs keep their choice |
| `a8aca78` | **Revamp 2:** Library (count line, Find a song, Ready / Not analyzed, Today dates, solo tag), Prepare (amber only on the live chord), Settings and Tuner in one column |
| `e89fc9f` | **Revamp 3:** confirms and Import chart on `<dialog>`; Queue and Projector on native popovers |
| `3cf9f37` | **Revamp 4:** shortcuts R (record / stop), G / V (hear guitar / vocal); fix: shortcuts paused only while a dialog or popover is open |
| `0ce56f8` | **Revamp 5:** light theme in the same look (warm paper, deeper amber #a86a12, black pills) |
| `0580d72` · `62e354c` · `5084c46` | Docs for the revamp; README for reviewers; public GitHub copy + `tools/dev/publish_public.py` (§6b) |
| `5297e42` | **Vocal polish** (Vocal card: switch + "Distance lift" 0–12 dB) and `spikes/cleanup/CleanupRender` |
| `8c13039` | **Clean vocal** (take list: "Clean vocal", then a Clean / Original switch); solo songs play from their take |

Verified by JP: the buzz is gone with hum filter + learned gate (E2 noise peaked about −32 dB with the hum filter
alone: partly broadband, so the gate does the work); the new Session layout with a YouTube video; R / G / V; light
theme. Stage light rules: amber (#f2b33d dark) only on live data (current chord, playhead, meters); primary and "on"
controls are inverted pills; record is the one red; no borders on cards, lightness steps instead.

### 3c. PD200X vocal while playing guitar (2026-11-19)
JP's ask: a better vocal from the PD200X (dynamic, cardioid) when he sits a little away from it while playing, done
the way studios do acoustic covers. What was done, in order of effect:
1. **Mic setup (advice, in the Maono app — JP to apply):** gain from 100 to about 60–70 and sing at 10–25 cm; EQ from
   "Deep" to **Flat** (Deep boosts lows and cuts highs: muffled); noise cancellation 17 → **0** (use the app's gate +
   Learn noise); Maono compressor **off** (the app compresses); Maono limiter **on at −3 dB** (safety before USB);
   AI noise reduction and Hear-Self **off** (already). Aim the back of the mic at the guitar.
2. **Vocal polish** (`5297e42`), live. Offline test on JP's solo take of 2026-11-17 19:50: first version clipped
   (14 samples) and raised the noise 8 dB; fixed (ceiling, voice-only leveling) → peak −1.1 dBTP, noise +3 dB vs the
   gate alone. JP: "better".
3. **Clean vocal** (`8c13039`), after the take. The 19:50 vocal track was measured as mostly acoustic guitar with
   singing on top (earshot: acoustic guitar z 3.2); cleaned it reads as a-cappella singing, noise floor −88 dB.
   Tested on a temporary copy (since moved to the Recycle Bin). JP: "sounds clean".
Physics to remember: each doubling of distance costs ~6 dB of voice while bleed and room stay; software can level the
voice but cannot separate it live — position and gain matter most.

### Verified live on 2026-11-17
- Learn this song end to end (ads waited out, saved, analysed in ~30 s); autoplay pause after learning.
- Key spelling (Eb not D#), chart import + Undo import, chart-first chord band (guesses hidden, "Show guesses").
- Monitoring guitar + vocal into the PD200X: shared ≈ 35 ms, exclusive ≈ 25–27 ms, JP: "clean" and "feels good".
- YouTube audible in exclusive mode through the app (levels measured, video plays).
- Letterboxed previews, Video only, Browse mode, splitter drags, camera pop-out window, camera 1080p60.
- Camera looks + auto colour fix on JP's camera (pink/purple cast → neutral), output 1920×1080 @ 60.

### Built but NOT verified by JP yet
- **Pads** (never confirmed by ear). Solo takes WERE recorded on 2026-11-17 (Library: "Solo 2026-11-17 …", one with
  camera video), but the clean-vocal switch back to "Original vocal" and its progress text were not seen in the app.
- **Learn this song after the freeze fixes** (YouTube player API seek, freeze nudge, mid-song jump cancels): the last
  two attempts before the fixes failed because YouTube froze; not retested since.
- Takes with the camera as MP4 (recorder path changed from WebM), and with a look on.
- Projector on a second display (JP has one).

### Known issues / gaps
- **Testing through CDP shows on JP's screen.** On 2026-11-19 a test opened "Confirm all…" on Tanging Kailangan; all
  83 chords got saved as confirmed and were set back by hand. Never leave a data-changing dialog open; close it in the
  same eval, or use a throwaway song. Also: JP's own launches have no debug port; ask him to close the app first.
- Text size: the guide's `<meta name="text-scale">` does nothing on Windows desktop; JP uses Ctrl +/− zoom (≈ 200 %).
  Fixed px sizes were left as they are (decision 2026-11-19).
- E2 Gen2 sometimes is not detected (USB); JP has to re-plug it and press ↻ Inputs.
- Closing the app during a solo take leaves it in a hidden `Songs\.solo-<time>` folder (not turned into a song).
- Library holds two broken test songs from today: "Still - Wood Room Sessions…" (31 s) and "Goodness of God…" (32 s);
  JP deletes them himself.
- Detected chords are often wrong; by design the band only shows imported/checked chords. Since 2026-11-17 the guesses
  come from Basic Pitch notes (drone notes removed) + spectrum: better, still not reliable ("Mighty To Save" holds Eb
  for its first 80 s). Old songs keep their old guesses until re-analysed. A trained chord model (BTC / Omnizart)
  benchmark is an option JP may ask for (licences unclear).

---

## 4b. Outside repo reviews and the agreed audio order (2026-11-19)
Both reviews are in Slack `#claude-chatgpt`. Licences below were checked on GitHub on 2026-11-19.

**Muse, 2026-11-17 (14 repos).** In the app: audio-separator, librosa, tonal, beat_this, Basic Pitch (+ device IDs).
Not adopted: MSST / BS-RoFormer 53-stem (checkpoint licences unclear), music21 (later), aubio (GPL-3), Rubber Band
(GPL-2), whisper.cpp (MIT; lyrics, later), miniaudio (reference only), Audacity (patterns only). None of the 14 target
recording or vocal quality. Muse's warning stands: Demucs weights are research-only — do not bundle them for release.

**ChatGPT, 2026-11-19 ("real studio quality", acoustic + vocal chains; JP asked "Codex", the reply is signed
[ChatGPT]).** Its chain advice is standard practice and agreed (guitar: HPF 65–85 Hz, dynamic cut 180–280 Hz, 2:1 with
20–40 ms attack, short room + low plate; vocal: HPF, mud cut 180–350 Hz, de-ess 5–9 kHz, two light compressors,
plate/chamber + tempo delay ducked under the voice, optional transparent pitch correction, never on by default;
loudness-matched A/B; no artist-named presets). Its repo facts were partly wrong:

| Repo | ChatGPT said | Checked | Use |
|---|---|---|---|
| airwindows/airwindows | verify | **MIT**, active | ✓ best source for reverb, console/tape colour, de-ess DSP |
| Signalsmith Stretch | keep | MIT, active | ✓ in the app; also the engine for gentle pitch correction |
| Tracktion/pluginval | adopt | GPL-3 | ✓ as a separate test tool only (never linked) |
| michaelwillis/dragonfly-reverb | GPL-3 | GPL-3, active | ⚠ reference only while the app is closed-source |
| Chowdhury-DSP/CHOW | "BSD-3" | **GPL-3, last push 2019** | ✗ |
| Audbol/audbol-plugins | verify | **no licence, 1 star** | ✗ |
| x42 fat1 (auto-tune) | — | GPL-2 | ✗ (build our own instead) |
| Matchering (reference mastering) | — | GPL-3 | ⚠ only as a separate sidecar process |

What ChatGPT missed and Claude proposed: (a) **gentle pitch correction** of our own (tuner pitch detection + Signalsmith
shift, offline on vocal takes, strength / speed / key, off by default); (b) a **guitar body IR** made from JP's own
Ibanez (record E2 pickup + a mic at once, deconvolve) instead of branded Martin IRs, plus tone presets in the
D-28 / 000-28 / 000-18 *direction* (fuller lows, scooped mids, sparkle) — software cannot make it a Martin;
(c) **mastering**: LUFS / true-peak meters, a true-peak limiter, optional reference matching to a worship track.

**Agreed next order for sound (JP has not picked the first one yet):**
1. **Reverb + tempo delay** sends (Airwindows-based or own), ducked under the dry signal, on monitor and takes.
2. **Guitar body sound** from JP's own guitar + tone presets.
3. **Gentle tuning** on vocal takes.
4. **Mastering** chain + meters (+ optional reference match).
Rules from both reviews: keep the live chain no-look-ahead, keep raw takes, A/B at matched loudness, 48 kHz throughout,
keep GPL/AGPL out of the binary until the licence is decided, no artist IRs/presets/weights without permission.

## 4. What to do next
0. Sound: §4b order (ask JP which first). Not yet published: GitHub is at the README/publish-script snapshot; the vocal
   polish and clean vocal commits are local only until JP says "update GitHub".
0b. UI follow-ups if JP asks: a song/camera width handle in the new grid (splitters are off there); waveform peaks not
   drawn for Tanging Kailangan in the timeline (check whether that predates the revamp).
1. With JP: plug in the E2 → solo take with camera and a look → listen; pads by ear; Learn this song retest.
2. Phase B leftovers: device IDs instead of names, Windows-effects check (Maono/intelliGo "AI noise" must be off),
   take delete/recovery, storage meter, manual take nudge (instead of calibration), the 5-minute E2 + PD200X test.
3. Charts: repeated sections; lyrics in Prepare › Chart; CCLI list.
4. Phase C "Sunday mode", Phase D polish (lint warnings, zoom reflow, a11y re-score), then M3 VST3.

## 5. Decisions already made (see ROADMAP decision log)
Process-loopback capture, never downloading; takes recorded dry and lined up after the take; software monitoring
(shared low latency default, exclusive for recording; YouTube through the app in exclusive); no play-along
calibration (JP: inaccurate); chart-first chords; camera MP4 H.264; looks baked into recordings; pads made in code;
buzz cleanup in software, raw takes kept dry; Stage light look (mockup A over B "Console"); UI built from the
modern-web-guidance guides, browser features of current Chromium used without fallbacks; vocal processing = no
look-ahead live chain + offline repair (clean vocal) with the original always kept; public GitHub = cleaned
`public` branch only.

## 6. Build, run, test
```
cd ui && npm run build && npm test          # 41 tests; typecheck: npx tsc -b --noEmit
cmake --build app/build --config Release --target WorshipStudio   # close the app first (exe is locked)
set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333
app\build\WorshipStudio_artefacts\Release\"Worship Studio.exe"
```
- Dev helpers in `tools/dev/` (cdp.mjs eval/shot, call.js `__call(...)`, screen.ps1). cdp.mjs takes the first app page:
  when the camera pop-out is open it may hit that window — close it first (`__call('projectorClose')`).
- Useful native calls: `monitorStatus` (output mode, per-input delay/dropouts, page audio), `devices`, `recInputs`,
  `siteVideo('state')`, `listSongs`, `inputCleanup`, `cleanVocal`, `useCleanVocal`.
- Offline DSP check: `cmake --build app/build --config Release --target CleanupRender`, then
  `CleanupRender in.wav out.wav [--hum] [--gate dB] [--vocal liftDb]`; measure with the earshot tools (no new mic audio).
- Sidecar by hand: `analysis/.venv/Scripts/python.exe -u analysis/run_wsa.py clean-vocal --input X.wav --out Y.wav`.
- Files are CRLF in the working copy; scripted edits must keep CRLF (several edits today hit mixed endings).
- Test song: `tanging-kailangan-acoustic-victory-worship-victo` (JP's; never delete).

## 6b. Public GitHub copy (for Muse and other reviewers)
- **https://github.com/JP-RanzCalhoun/Worship-Studio** (public). Local remote: `github`.
- It is the local `public` branch: one snapshot commit per update, signed `JP-RanzCalhoun` with GitHub's noreply
  address. **Never push `master`**: its commits carry JP's work email. Never force-push.
- Update only when JP asks ("update GitHub"): commit locally, then
  `python tools/dev/publish_public.py "What changed" --push`. The script stops if the committed files contain the
  local git email, its domain, the Windows user name or a Slack channel ID; fix those in the files and commit.
- Keep out of the repo: song lyrics, recordings, model weights, personal paths. The mockups use placeholder lyrics.

## 7. Waiting for JP
Apply the Maono settings (§3c) · pick the first sound step (§4b) · say "update GitHub" when Muse should see the vocal
work · listen to the pads · Learn retest · delete the
two broken test songs and the "WE PLAY YOU SING" zips himself · licensing before any public release (JUCE AGPL,
Demucs weights, YouTube terms, H.264 for distribution).
