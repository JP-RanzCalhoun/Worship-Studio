import { loadKeys, prettyCombo } from "../shortcuts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { on } from "../bridge";
import { contextFor, describe, fmtTime, sectionAt, shownChords } from "../chart";
import { Meter, roleOf, type Role, ROLE_LABEL } from "../components/music";
import { Waveform } from "../components/Waveform";
import { anchorStyle, Banner, Button, Popover, Segmented, useToast } from "../components/ui";
import { engine, type RecInput, type Take } from "../engine";
import { ChordBand } from "../session/ChordBand";
import { type CameraQuality, useCamera } from "../session/useCamera";
import type { useGetSong } from "../session/useGetSong";
import type { useLearning } from "../session/useLearning";
import { ImportChart } from "../session/ImportChart";
import { useShowGuesses } from "../session/useShowGuesses";
import { Splitter, useSceneSplit } from "../session/SceneSplit";
import { CameraLookPanel } from "../session/CameraLookPanel";
import { PadStrip } from "../session/PadStrip";
import { useMonitorControls } from "../session/MonitorControls";
import { useSiteView } from "../session/useSiteView";
import { defaultMix, type MixState, type StemInfo } from "../song";
import { countIn } from "../timeline";
import { keyName, keyUsesFlats, spellKey } from "../theory/notes";
import type { JobState } from "../useAnalysisJobs";
import { useMeters, useProject, useTransport } from "../useProject";

type P = ReturnType<typeof useProject>;
type Layout = "split" | "song" | "camera";

/** YouTube video id of a watch link, or "" (other sites: the whole address is compared). */
const videoKey = (url: string) => /[?&]v=([\w-]{6,})/.exec(url)?.[1] ?? url;

// ---------- inputs (E2 Gen2 guitar, PD200X vocal) ----------

interface Slot {
  label: "Guitar" | "Vocal";
  /** the input's name (shown, and the fallback) */
  device: string;
  /** the input's Windows endpoint ID (what is opened) */
  id?: string;
  armed: boolean;
}
/** What the native side opens for a slot: the endpoint ID when known, else the name (audit AUD-01). */
const openKey = (s: Slot) => s.id || s.device;
const SLOT_STORE = "wsa.recSlots";
function loadSlots(): Slot[] {
  try {
    const s = JSON.parse(localStorage.getItem(SLOT_STORE) || "null");
    if (Array.isArray(s) && s.length === 2) return s;
  } catch {
    /* first run, or storage blocked */
  }
  return [
    { label: "Guitar", device: "", armed: true },
    { label: "Vocal", device: "", armed: true },
  ];
}
function guess(label: string, inputs: RecInput[]): string {
  const real = inputs.filter((i) => !i.warning);
  const pick = (re: RegExp) => real.find((i) => re.test(i.name))?.name;
  return (label === "Guitar" ? pick(/maonocaster|e2 gen/i) : pick(/pd200x/i)) ?? "";
}

const LAYOUT_STORE = "wsa.sessionLayout";
const loadLayout = (): Layout => {
  try {
    const l = localStorage.getItem(LAYOUT_STORE);
    return l === "song" || l === "camera" ? l : "split";
  } catch {
    return "split";
  }
};

export function Session({
  p,
  theme,
  job,
  countInState,
  setCountInState,
  getSong,
  learning,
  goPrepare,
  onSoloSaved,
}: {
  /** a solo take became a new song: open it */
  onSoloSaved?: (songId: string) => void;
  learning: ReturnType<typeof useLearning>;
  p: P;
  theme: string;
  job?: JobState;
  countInState: { until: number; beats: number } | null;
  setCountInState: (s: { until: number; beats: number } | null) => void;
  /** "Get this song" lives at app level, so a recording never runs unsupervised when Session is left */
  getSong: ReturnType<typeof useGetSong>;
  goPrepare: (tab?: string) => void;
}) {
  const { song, analysis, stems, chart, update, project, grid, duration } = p;
  const { pos, playing } = useTransport();
  const meters = useMeters();
  const toast = useToast();
  const [layout, setLayoutState] = useState<Layout>(loadLayout);
  const setLayout = (l: Layout) => {
    setLayoutState(l);
    try {
      localStorage.setItem(LAYOUT_STORE, l);
    } catch {
      /* storage blocked */
    }
  };
  // Browse: YouTube fills the whole Session area (full page, to search comfortably); Done or Learn returns.
  const [browsing, setBrowsing] = useState(false);
  // OBS-style sizing: drag the line between the boxes, and the line under them
  const scenesRef = useRef<HTMLDivElement>(null);
  const sceneSplit = useSceneSplit();
  const showSong = layout !== "camera" || browsing;
  const showCamera = layout !== "song" && !browsing;

  // ---- song video (native browser view over the left scene)
  const videoArea = useRef<HTMLDivElement>(null);
  const [projOpen, setProjOpen] = useState(false); // the native video would cover the popover: hide it meanwhile
  const [importOpen, setImportOpen] = useState(false);
  const [showGuesses, setShowGuesses] = useShowGuesses();
  useSiteView(videoArea, showSong && !projOpen && !importOpen);
  const [address, setAddress] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  useEffect(() => on("siteNav", (n: { url: string }) => setSiteUrl(n.url)), []);
  useEffect(() => {
    engine.siteVideo("state").then((v) => setSiteUrl((u) => u || v.url)).catch(() => {});
  }, []);
  const capturing = getSong.state.stage === "recording" || getSong.state.stage === "waitingAd" || getSong.state.stage === "saving";

  // Open the song's own video when the song has one (and the page shows something else).
  const refUrl = song?.referenceUrl ?? "";
  useEffect(() => {
    if (!refUrl) return;
    engine
      .siteVideo("state")
      .then((v) => {
        if (videoKey(v.url) !== videoKey(refUrl)) return engine.siteGo(refUrl);
      })
      .catch(() => engine.siteGo(refUrl).catch(() => {}));
  }, [refUrl]);

  // Picture follows the player: muted, same speed, corrected when it drifts. Only for the song's own video.
  const live = useRef({ pos, playing, offset: 0, tempo: 1, capturing: false });
  live.current = { pos, playing, offset: song?.referenceOffset ?? 0, tempo: song?.tempoRatio ?? 1, capturing };
  const linked = !!refUrl && videoKey(siteUrl || refUrl) === videoKey(refUrl);
  const refVid = videoKey(refUrl);
  // Said when the video cannot follow (audit P3: failures were silent): no answer for 2 s, or more than 1.5 s
  // away from the player for 3 s while playing (YouTube buffering, an ad, another video open).
  const [videoSyncIssue, setVideoSyncIssue] = useState("");
  useEffect(() => {
    if (!linked || capturing || !showSong) return setVideoSyncIssue("");
    let pending = false;
    let fails = 0,
      offSince = 0;
    const id = window.setInterval(() => {
      if (pending) return; // never stack calls: an old target applied late would fight the new one
      const { pos: t, playing: pl, offset, tempo } = live.current;
      const target = Math.max(0, t + offset);
      pending = true;
      engine
        .siteVideo("sync", { t: target, playing: pl && t >= 0, rate: tempo, id: refVid })
        .then((v) => {
          fails = 0;
          const off = pl && v.has && !v.ad && typeof v.t === "number" && Math.abs(v.t - target) > 1.5 && target < (v.d ?? Infinity) - 1;
          if (off) offSince = offSince || Date.now();
          else offSince = 0;
          setVideoSyncIssue(
            v.ad ? "An ad is playing: the picture follows again after it." : offSince && Date.now() - offSince > 3000 ? "The video can't keep up with the player (still loading?)." : "",
          );
        })
        .catch(() => {
          fails++;
          if (fails >= 8) setVideoSyncIssue("The video is not answering. Reload the page or open the song's video again.");
        })
        .finally(() => (pending = false));
    }, 250);
    return () => {
      window.clearInterval(id);
      // A capture starting needs the video playing: only pause when leaving or unlinking.
      if (!live.current.capturing) engine.siteVideo("sync", { t: Math.max(0, live.current.pos + live.current.offset), playing: false, rate: 1, id: refVid }).catch(() => {});
    };
  }, [linked, capturing, showSong, refVid]);

  const go = () => {
    const t = address.trim();
    if (t) engine.siteGo(t).catch((e) => toast({ tone: "error", text: String(e.message ?? e) }));
  };

  // ---- camera (right scene)
  const [recordVideo, setRecordVideo] = useState(true);
  const camera = useCamera(showCamera, (m) => toast({ tone: "warn", text: m }));
  const [mirror, setMirror] = useState(true);

  // ---- inputs and takes
  const [inputs, setInputs] = useState<RecInput[]>([]);
  const [slots, setSlots] = useState<Slot[]>(loadSlots);
  const [inPeaks, setInPeaks] = useState<Record<string, number>>({});
  const [rec, setRec] = useState({ on: false, seconds: 0 });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const [takes, setTakes] = useState<Take[]>([]);
  const [recError, setRecError] = useState("");
  const [cleaning, setCleaning] = useState<string | null>(null); // take id whose vocal is being cleaned
  // Live monitoring shows which output it plays through
  const [outputName, setOutputName] = useState("");

  const refreshInputs = useCallback(() => {
    engine.devices().then((d) => setOutputName(d.output)).catch(() => {});
    engine
      .recInputs()
      .then((list) => {
        setInputs(list);
        setSlots((s) =>
          s.map((x) => {
            // keep the chosen input (refresh its ID), else guess it again
            const kept = (x.id && list.find((i) => i.id === x.id)) || (x.device && list.find((i) => i.name === x.device));
            if (kept) return { ...x, device: kept.name, id: kept.id };
            if (x.device) return x; // chosen but unplugged: keep the choice, it comes back when plugged in again
            const g = guess(x.label, list);
            return { ...x, device: g, id: list.find((i) => i.name === g)?.id };
          }),
        );
      })
      .catch((e) => setRecError(String(e.message ?? e)));
  }, []);
  useEffect(() => {
    refreshInputs();
    engine.recStatus().then((s) => s.recording && setRec({ on: true, seconds: s.seconds })).catch(() => {});
  }, [refreshInputs]);
  useEffect(() => {
    try {
      localStorage.setItem(SLOT_STORE, JSON.stringify(slots));
    } catch {
      /* storage blocked */
    }
  }, [slots]);
  const songId = project?.id ?? "";
  const refreshTakes = useCallback(() => {
    if (songId) engine.recTakes(songId).then(setTakes).catch(() => {});
    else setTakes([]);
  }, [songId]);
  useEffect(refreshTakes, [refreshTakes]);

  const present = (s: Slot) => !!s.device && inputs.some((i) => i.name === s.device);
  const armed = useMemo(() => slots.filter((s) => s.armed && s.device && inputs.some((i) => i.name === s.device)), [slots, inputs]);
  const armedKey = armed.map((s) => openKey(s)).join("|");
  useEffect(() => {
    if (rec.on) return;
    // Live meters only (nothing is stored until Record). With or without a song (solo).
    engine.recMonitor(armed.map((s) => ({ label: s.label, device: openKey(s) }))).catch((e) => setRecError(String(e.message ?? e)));
    return () => {
      engine.recMonitor([]).catch(() => {});
    };
  }, [armedKey, rec.on]);
  useEffect(
    () =>
      on("rec", (r: { seconds: number; recording: boolean; meters: { label: string; peak: number }[] }) => {
        setInPeaks(Object.fromEntries(r.meters.map((m) => [m.label, m.peak])));
        setRec((x) => (r.recording ? { on: true, seconds: r.seconds } : x.on && !busyRef.current ? { on: false, seconds: 0 } : x));
      }),
    [],
  );

  // Live monitoring (hear it, buzz cleanup) lives in each input's card; the output settings sit with the take.
  const monitor = useMonitorControls({ slots, outputName });

  // Keyboard shortcuts owned by Session (App sends them as "ws-action"): record / stop, hear the guitar / vocal.
  const actions = useRef<{ record?: () => void }>({});
  const monitorRef = useRef(monitor);
  monitorRef.current = monitor;
  useEffect(() => {
    const onAction = (e: Event) => {
      const a = (e as CustomEvent<string>).detail;
      if (a === "record") actions.current.record?.();
      if (a === "hearGuitar") monitorRef.current.toggleHear("Guitar");
      if (a === "hearVocal") monitorRef.current.toggleHear("Vocal");
    };
    window.addEventListener("ws-action", onAction);
    return () => window.removeEventListener("ws-action", onAction);
  }, []);
  const recKey = prettyCombo(loadKeys().record);

  // Input cards (Guitar, Vocal): the signal chain from the input to your headphones. Used with a song and solo.
  const inputStrips = () =>
    slots.map((s, i) => {
      const warn = inputs.find((x) => x.name === s.device)?.warning;
      return (
        <div key={s.label} className={`input-card${s.armed ? " is-armed" : ""}`}>
          <div className="ic-head">
            <h3 className="ic-name">{s.label}</h3>
            {warn && <span className="warn-text small" title={warn}>not recommended</span>}
            <span className="spacer" />
            <Button size="sm" pressed={s.armed} className="arm" disabled={rec.on} onClick={() => setSlots((x) => x.map((y, j) => (j === i ? { ...y, armed: !y.armed } : y)))}
              aria-label={`${s.armed ? "Disarm" : "Arm"} ${s.label}`} title="Armed inputs are recorded when you press Record">
              {s.armed ? "Armed" : "Arm"}
            </Button>
          </div>
          <Meter peak={s.armed && s.device ? inPeaks[s.label] ?? 0 : 0} showClip />
          <select aria-label={`${s.label} input`} value={s.device} disabled={rec.on}
            onChange={(e) => {
              const name = e.target.value;
              const id = inputs.find((x) => x.name === name)?.id;
              setSlots((x) => x.map((y, j) => (j === i ? { ...y, device: name, id } : y)));
            }}>
            <option value="">Choose…</option>
            {s.device && !present(s) && <option value={s.device}>{s.device} (not plugged in)</option>}
            {inputs.map((x) => (
              <option key={x.name} value={x.name}>
                {x.name}
                {x.warning ? " (not recommended)" : ""}
              </option>
            ))}
          </select>
          {monitor.row(s.label as "Guitar" | "Vocal")}
        </div>
      );
    });

  // ---- solo take: no song. It becomes a new song in the library (mixdown + the separate dry tracks).
  const soloStart = async () => {
    setRecError("");
    setBusy(true);
    try {
      await engine.recStart("", armed.map((s) => ({ label: s.label, device: openKey(s) })), 0);
      if (recordVideo && camera.stream) {
        const e = await camera.startRecording();
        if (e) toast({ tone: "warn", text: e });
      }
      setRec({ on: true, seconds: 0 });
    } catch (e: any) {
      setRecError(String(e.message ?? e));
      await camera.stopRecording().catch(() => {});
      await engine.recCancel().catch(() => {});
    } finally {
      setBusy(false);
    }
  };
  const soloStop = async () => {
    setBusy(true);
    try {
      const [t] = await Promise.all([engine.recStop(), camera.stopRecording()]);
      setRec({ on: false, seconds: 0 });
      const r = t as Take & { songId?: string; title?: string };
      if (r?.error) setRecError(r.error);
      else {
        if (r?.warning) toast({ tone: "warn", text: r.warning });
        if (r?.songId) {
          toast({ tone: "ok", text: `Saved as “${r.title ?? "Solo"}” in the Library.` });
          onSoloSaved?.(r.songId);
        }
      }
    } catch (e: any) {
      setRecError(String(e.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  if (!song || !project) {
    actions.current.record = () => {
      if (busyRef.current) return;
      if (rec.on) void soloStop();
      else if (armed.length) void soloStart();
    };
    return (
      <div className={`session layout-${layout}${browsing ? " is-browsing" : ""}`}>
        <SourceBar address={address} setAddress={setAddress} go={go} siteUrl={siteUrl} layout={layout} setLayout={setLayout} getSong={getSong} learning={learning} projOpen={projOpen} setProjOpen={setProjOpen} browsing={browsing} setBrowsing={setBrowsing} />
        <div className="scenes" ref={scenesRef} style={sceneSplit.scenesStyle(showSong && showCamera, browsing)}>
          {showSong && (
            <article className="scene">
              <header className="scene-head">
                <span className="strong">Song</span>
                <span className="muted small">Find the song on YouTube, then press Learn this song.</span>
              </header>
              <div className="scene-screen" ref={videoArea}>
                <span className="muted">Loading the browser…</span>
              </div>
            </article>
          )}
          {showSong && showCamera && <Splitter dir="col" target={scenesRef} split={sceneSplit.split} save={sceneSplit.save} />}
          {showCamera && <CameraScene camera={camera} mirror={mirror} setMirror={setMirror} rec={false} seconds={0} />}
        </div>
        <Splitter dir="row" target={scenesRef} split={sceneSplit.split} save={sceneSplit.save} />
        <div className="session-deck solo-deck">
          <section className="panel mix-panel" aria-label="Solo recording">
            <header className="panel-head">
              <span className="strong">Solo recording</span>
              <span className="muted small">no song needed: record guitar and vocal, with a pad if you like</span>
            </header>
            <div className="chain">
              <div className="strips"><PadStrip /></div>
              {inputStrips()}
            </div>
          </section>
          <section className="panel take-panel" aria-label="Solo take">
            <header className="panel-head">
              <span className="strong">Take</span>
              <span className="spacer" />
              <Button size="sm" variant="quiet" onClick={refreshInputs} disabled={rec.on} title="Look for inputs again (after plugging in a device)">
                ↻ Inputs
              </Button>
            </header>
            {rec.on ? (
              <button className="rec-button is-on" onClick={soloStop} disabled={busy} title={`Stop (${recKey})`}>
                ■ Stop · {fmtTime(rec.seconds)}
              </button>
            ) : (
              <button className="rec-button" onClick={soloStart} disabled={!armed.length || busy} title={armed.length ? `Record (${recKey})` : "Arm an input first"}>
                {busy ? "Saving…" : "● Record solo"}
              </button>
            )}
            <label className="checkbox-line small">
              <input type="checkbox" checked={recordVideo} disabled={rec.on || !camera.stream} onChange={(e) => setRecordVideo(e.target.checked)} />
              Record the camera too {camera.stream ? "" : "(camera off)"}
            </label>
            <p className="small muted">When you stop, it is saved as a new song in the Library (the mix, plus the separate guitar and vocal).</p>
            {monitor.output}
            {recError && <Banner tone="error">{recError}</Banner>}
          </section>
        </div>
        <p className="small muted">
          Or open a song from the Library, or learn one from a video above: it plays once, then gets stems, chords, sections and cues.
        </p>
      </div>
    );
  }

  const ctx = contextFor(song, analysis);
  const label = (c: { chord: string }) => describe(c.chord, ctx).concert;
  // Chart chords (imported or checked) only, unless the user asked to see the detected guesses too.
  const shown = shownChords(chart.chords, showGuesses);
  const guessCount = chart.chords.length - shownChords(chart.chords, false).length;

  // During a count-in, the band shows the count.
  const counting = !!countInState && playing && pos < countInState.until - 0.02;
  const countNum = counting
    ? Math.max(1, countInState!.beats - grid.filter((g) => g.t > pos + 0.02 && g.t < countInState!.until - 0.02).length)
    : 0;

  // ---- mixer
  const mixOf = (id: string): MixState => song.mixer[id] ?? defaultMix(stems.find((s) => s.id === id));
  const setMix = (id: string, m: Partial<MixState>) =>
    update((s) => ({ ...s, mixer: { ...s.mixer, [id]: { ...mixOf(id), ...m } } }), "gain" in m ? `gain-${id}` : "edit");
  const anySolo = stems.some((s) => mixOf(s.id).solo);
  const groups = new Map<Role, StemInfo[]>();
  for (const s of stems) groups.set(roleOf(s), [...(groups.get(roleOf(s)) ?? []), s]);
  const ORDER: Role[] = ["takes", "vocals", "guitar", "keys", "bass", "drums", "other"];

  // ---- record
  const tempoOk = Math.abs(song.tempoRatio - 1) < 1e-6;
  const pitchSemis = song.linkPitchToTranspose ? song.transpose : 0;
  const armedNoInput = slots.filter((s) => s.armed && !present(s));
  const blocked = !tempoOk
    ? "Set the tempo to 100% to record."
    : pitchSemis !== 0
      ? "Set the key back to the original to record."
      : armedNoInput.length
        ? `${armedNoInput.map((s) => s.label).join(" and ")} ${armedNoInput.length > 1 ? "are" : "is"} armed but ${armedNoInput.length > 1 ? "have" : "has"} no input. Plug it in and press ↻ Inputs, or disarm it.`
        : armed.length === 2 && armed[0].device === armed[1].device
          ? "Both tracks use the same input."
          : armed.length === 0
            ? "Arm the guitar or the vocal input."
            : "";
  const secIdx = sectionAt(chart.sections, Math.max(0, pos));
  const fromLabel = secIdx >= 0 ? chart.sections[secIdx].label : fmtTime(Math.max(0, pos));

  const startTake = async () => {
    setRecError("");
    setBusy(true);
    try {
      let from = Math.max(0, pos),
        preRoll = 0;
      if (song.click.countInBars > 0 && grid.length) {
        const c = countIn(grid, from, song.click.countInBars, song.click.beatsPerBar);
        from = c.from;
        preRoll = c.preRoll;
      }
      await engine.recStart(project.id, armed.map((s) => ({ label: s.label, device: openKey(s) })), from - preRoll);
      if (recordVideo && camera.stream) {
        const e = await camera.startRecording();
        if (e) toast({ tone: "warn", text: e });
      }
      if (preRoll > 0) setCountInState({ until: from, beats: song.click.countInBars * song.click.beatsPerBar });
      await engine.play(from, preRoll);
      setRec({ on: true, seconds: 0 });
    } catch (e: any) {
      setRecError(String(e.message ?? e));
      await camera.stopRecording().catch(() => {});
      await engine.recCancel().catch(() => {}); // nothing useful was recorded: no half take is left behind
    } finally {
      setBusy(false);
    }
  };
  const stopTake = async () => {
    setBusy(true);
    try {
      await engine.pause();
      const [t] = await Promise.all([engine.recStop(), camera.stopRecording()]);
      setRec({ on: false, seconds: 0 });
      if (t?.error) setRecError(t.error);
      else if (t?.warning) toast({ tone: "warn", text: t.warning });
      refreshTakes();
      if (t && !t.error) {
        update((s) => ({ ...s, activeTake: t.id })); // hear the new take with the song right away
        await p.reload();
      }
    } catch (e: any) {
      setRecError(String(e.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  actions.current.record = () => {
    if (busyRef.current) return;
    if (rec.on) void stopTake();
    else if (!blocked) void startTake();
  };

  return (
    <div className={`session layout-${layout}${browsing ? " is-browsing" : ""}`}>
      <SourceBar address={address} setAddress={setAddress} go={go} siteUrl={siteUrl} layout={layout} setLayout={setLayout} getSong={getSong} learning={learning} songId={project.id} projOpen={projOpen} setProjOpen={setProjOpen} browsing={browsing} setBrowsing={setBrowsing} />
      <PrepSteps p={p} job={job} capture={getSong.state} goPrepare={goPrepare} />

      <div className="scenes" ref={scenesRef} style={sceneSplit.scenesStyle(showSong && showCamera, browsing)}>
        {showSong && (
          <article className="scene">
            <header className="scene-head">
              <span className="strong">Song</span>
              <span className={`small ${videoSyncIssue ? "warn-text" : "muted"}`} title={videoSyncIssue || undefined}>
                {videoSyncIssue || (linked ? "Video picture, muted · follows the player" : refUrl ? "Showing another page" : "No video for this song")}
              </span>
              <span className="spacer" />
              {linked && (
                <span className="row-tight" role="group" aria-label="Video sync">
                  <Button size="sm" variant="quiet" title="Picture is late: move it earlier" onClick={() => update((s) => ({ ...s, referenceOffset: (s.referenceOffset ?? 0) + 0.1 }), "video-offset")}>
                    −0.1 s
                  </Button>
                  <Button size="sm" variant="quiet" title="Picture is early: move it later" onClick={() => update((s) => ({ ...s, referenceOffset: (s.referenceOffset ?? 0) - 0.1 }), "video-offset")}>
                    +0.1 s
                  </Button>
                </span>
              )}
              <Button size="sm" variant="quiet" onClick={() => engine.chartSearch(song.title)} title="Search the web for this song's chord sheet (opens beside the scenes)">
                Chord sheet
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setImportOpen(true)} title="Import a SongSelect / ChordPro file or a pasted chart">
                Import chart
              </Button>
              {guessCount > 0 && (
                <Button size="sm" variant="quiet" pressed={showGuesses} onClick={() => setShowGuesses(!showGuesses)}
                  title="Show the chords the app detected by itself. They are a guess: often wrong on sus, add9, slash and passing chords.">
                  {showGuesses ? "✓ " : ""}Show guesses
                </Button>
              )}
              {refUrl && !linked && (
                <Button size="sm" onClick={() => engine.siteGo(refUrl)}>
                  Back to the song's video
                </Button>
              )}
            </header>
            <div className="scene-screen" ref={videoArea}>
              <span className="muted">{refUrl ? "Loading the video…" : "This song has no video. Search YouTube above to show one."}</span>
            </div>
          </article>
        )}
        {showSong && showCamera && <Splitter dir="col" target={scenesRef} split={sceneSplit.split} save={sceneSplit.save} />}
        {showCamera && <CameraScene camera={camera} mirror={mirror} setMirror={setMirror} rec={rec.on} seconds={rec.seconds} />}
      </div>
      <Splitter dir="row" target={scenesRef} split={sceneSplit.split} save={sceneSplit.save} />

      <ChordBand chords={shown} sections={chart.sections} grid={grid} ctx={ctx} pos={Math.max(0, pos)} countIn={countNum} lyrics={song.lyrics}
        empty={
          <>
            <span className="strong">No chart yet</span>
            <span className="muted small">Import the song's chart to see the right chords here, with lyrics.</span>
            <span className="row-tight">
              <Button size="sm" variant="primary" onClick={() => setImportOpen(true)}>Import chart</Button>
              <Button size="sm" onClick={() => engine.chartSearch(song.title)}>Find a chord sheet</Button>
              {guessCount > 0 && (
                <Button size="sm" variant="quiet" onClick={() => setShowGuesses(true)} title="The chords the app detected by itself: often wrong on sus, add9, slash and passing chords">
                  Show detected chords (guess)
                </Button>
              )}
            </span>
          </>
        }
      />
      {importOpen && <ImportChart p={p} onClose={() => setImportOpen(false)} />}

      <Waveform
        peaks={project.peaks}
        duration={duration}
        pos={pos}
        sections={chart.sections}
        chords={shown}
        chordLabel={label}
        loop={song.loop}
        theme={theme}
        onSeek={(t) => engine.seek(t)}
        onLoop={(a, b) => update((s) => ({ ...s, loop: { a, b, enabled: true } }), "loop")}
      />

      <div className="session-deck">
        <section className="panel mix-panel" aria-label="Mix">
          <header className="panel-head">
            <span className="strong">Mix</span>
            <span className="muted small">song parts from the AI split, then your inputs</span>
            <span className="spacer" />
            <PracticeControls p={p} />
          </header>
          {!analysis?.stems?.length && (
            <Banner tone="info" action={job?.running ? undefined : <Button size="sm" onClick={() => goPrepare("stems")}>Analyze</Button>}>
              {job?.running ? `Splitting and analyzing… ${Math.round(job.pct)}%` : "Playing the full mix. Analyze the song to get separate parts."}
            </Banner>
          )}
          <div className="strips">
            {ORDER.filter((r) => groups.has(r)).map((r) => (
              <StemStrip key={r} role={r} stems={groups.get(r)!} mixOf={mixOf} setMix={setMix} meters={meters} anySolo={anySolo} />
            ))}
            <div className="strip">
              <div className="strip-name">
                <i className="role-dot role-click" aria-hidden /> Click
              </div>
              <Meter peak={0} vertical />
              <input type="range" className="strip-fader" min={0} max={100} value={Math.round(song.click.gain * 100)} aria-label="Click level" aria-valuetext={`${Math.round(song.click.gain * 100)} percent`}
                onChange={(e) => update((s) => ({ ...s, click: { ...s.click, gain: +e.target.value / 100 } }), "click-gain")} />
              <div className="strip-btns">
                <Button size="sm" pressed={song.click.enabled} onClick={() => update((s) => ({ ...s, click: { ...s.click, enabled: !s.click.enabled } }))}>
                  {song.click.enabled ? "On" : "Off"}
                </Button>
              </div>
            </div>
            <div className="strip">
              <div className="strip-name">
                <i className="role-dot role-cues" aria-hidden /> Cues
              </div>
              <Meter peak={0} vertical />
              <input type="range" className="strip-fader" min={0} max={100} value={Math.round(song.cues.gain * 100)} aria-label="Spoken cues level" aria-valuetext={`${Math.round(song.cues.gain * 100)} percent`}
                onChange={(e) => update((s) => ({ ...s, cues: { ...s.cues, gain: +e.target.value / 100 } }), "cue-gain")} />
              <div className="strip-btns">
                <Button size="sm" pressed={song.cues.enabled} onClick={() => update((s) => ({ ...s, cues: { ...s.cues, enabled: !s.cues.enabled } }))}>
                  {song.cues.enabled ? "On" : "Off"}
                </Button>
                <Button size="sm" variant="quiet" onClick={() => goPrepare("cues")} title="Edit the spoken cues">
                  Edit
                </Button>
              </div>
            </div>
            <PadStrip songKey={ctx.playKey.tonic} flats={keyUsesFlats(ctx.playKey.tonic, ctx.playKey.minor)} />
          </div>
        </section>

        <section className="panel inputs-panel" aria-label="Your inputs">
          <header className="panel-head">
            <span className="strong">Your inputs</span>
            <span className="muted small">what you play and sing, into your headphones</span>
          </header>
          <div className="chain">{inputStrips()}</div>
        </section>

        <section className="panel take-panel" aria-label="Take">
          <header className="panel-head">
            <span className="strong">Take</span>
            <span className="spacer" />
            <Button size="sm" variant="quiet" onClick={refreshInputs} disabled={rec.on} title="Look for inputs again (after plugging in a device)">
              ↻ Inputs
            </Button>
          </header>
          {rec.on ? (
            <button className="rec-button is-on" onClick={stopTake} disabled={busy} title={`Stop (${recKey})`}>
              ■ Stop · {fmtTime(rec.seconds)}
            </button>
          ) : (
            <button className="rec-button" onClick={startTake} disabled={!!blocked || busy} title={blocked || `Record (${recKey})`}>
              {busy ? "Starting…" : `● Record from ${fromLabel}`}
            </button>
          )}
          {blocked && !rec.on && <p className="small warn-text">{blocked}</p>}
          <label className="checkbox-line small">
            <input type="checkbox" checked={recordVideo} disabled={rec.on || !camera.stream} onChange={(e) => setRecordVideo(e.target.checked)} />
            Record the camera too {camera.stream ? "" : "(camera off)"}
          </label>
          <ul className="checks small">
            <li className={armed.length ? "ok" : "warn"}>{armed.length ? `Inputs: ${armed.map((a) => a.label).join(" + ")}` : "No input armed"}</li>
            <li className="warn">Headphones: speakers leak into the mics</li>
            <li className="warn" title="Takes are lined up from the devices' timestamps. The USB/driver delay inside each device is not measured yet, so a take can sit a few ms late. A per-take nudge and a loopback test are planned.">
              Timing: from device timestamps, not calibrated (can sit a few ms late)
            </li>
          </ul>
          {monitor.output}
          {recError && <Banner tone="error">{recError}</Banner>}
          <ul className="takes small" aria-label="Takes">
            {takes.slice(0, 4).map((t) => (
              <li key={t.id}>
                <span>
                  <b>{t.id.replace("take-", "Take ")}</b> · {(t.tracks ?? []).map((x) => x.label).join(" + ")}
                  {t.hasVideo ? " + video" : ""}
                </span>
                {t.error ? (
                  <span className="warn-text" title={t.error}>
                    !
                  </span>
                ) : (
                  <Button size="sm" variant="quiet" pressed={song.activeTake === t.id}
                    onClick={async () => {
                      update((s) => ({ ...s, activeTake: s.activeTake === t.id ? undefined : t.id }));
                      await p.reload();
                    }}
                    title="Play this take with the song (it shows in the mix as Your takes)">
                    {song.activeTake === t.id ? "✓ In mix" : "▶ Mix"}
                  </Button>
                )}
                {!t.error && (t.tracks ?? []).some((x) => x.label === "Vocal") && (() => {
                  const cleaned = (t.tracks ?? []).find((x) => x.label === "Vocal")?.cleanVocal;
                  const working = cleaning === t.id;
                  return cleaned !== undefined ? (
                    <Button size="sm" variant="quiet" pressed={cleaned}
                      title="Vocal with the guitar bleed removed. Click to switch between the cleaned and the original vocal."
                      onClick={async () => {
                        await engine.useCleanVocal(project.id, t.id, !cleaned);
                        refreshTakes();
                        await p.reload();
                      }}>
                      {cleaned ? "✓ Clean vocal" : "Original vocal"}
                    </Button>
                  ) : (
                    <Button size="sm" variant="quiet" disabled={cleaning !== null || rec.on}
                      title="Remove the guitar that leaked into the vocal mic (about a minute). The original vocal is kept."
                      onClick={async () => {
                        setCleaning(t.id);
                        try {
                          await engine.cleanVocal(project.id, t.id);
                          // a solo recording plays from its take; a song's take is heard when it is in the mix
                          if (t.solo || song.activeTake === t.id) update((s) => ({ ...s, activeTake: t.id }));
                          toast({ tone: "ok", text: `${t.id.replace("take-", "Take ")}: guitar bleed removed from the vocal. The original is kept.` });
                          refreshTakes();
                          await p.reload();
                        } catch (e: any) {
                          toast({ tone: "error", text: String(e.message ?? e) });
                        } finally {
                          setCleaning(null);
                        }
                      }}>
                      {working ? "Cleaning… about a minute" : "Clean vocal"}
                    </Button>
                  );
                })()}
                <Button size="sm" variant="quiet" onClick={() => engine.revealTake(project.id, t.id)} title="Show the files" aria-label={`Show the files of ${t.id.replace("take-", "take ")}`}>
                  📁
                </Button>
              </li>
            ))}
            {!takes.length && <li className="muted">No takes yet.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}

// ---------- pieces ----------

function SourceBar({
  browsing,
  setBrowsing,
  address,
  setAddress,
  go,
  siteUrl,
  layout,
  setLayout,
  getSong,
  learning,
  songId,
  projOpen,
  setProjOpen,
}: {
  browsing: boolean;
  setBrowsing: (b: boolean) => void;
  learning: ReturnType<typeof useLearning>;
  projOpen: boolean;
  setProjOpen: (o: boolean | ((o: boolean) => boolean)) => void;
  address: string;
  setAddress: (s: string) => void;
  go: () => void;
  siteUrl: string;
  layout: Layout;
  setLayout: (l: Layout) => void;
  getSong: ReturnType<typeof useGetSong>;
  songId?: string;
}) {
  const g = getSong.state;
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueText, setQueueText] = useState("");
  const [displays, setDisplays] = useState<{ index: number; label: string; thisWindow: boolean }[]>([]);
  const [projView, setProjView] = useState<"chords" | "camera">("chords");
  const toast = useToast();
  const openProjector = async (display: number) => {
    try {
      await engine.projectorOpen(projView, display, songId ?? "");
      setProjOpen(false);
    } catch (e: any) {
      toast({ tone: "error", text: String(e.message ?? e) });
    }
  };
  const isVideoPage = /youtube\.com\/watch|youtu\.be\//i.test(siteUrl);
  // "Video only": YouTube watch pages show just the player, letterboxed (remembered; on by default)
  const [videoOnly, setVideoOnlyState] = useState(() => {
    try {
      return localStorage.getItem("wsa.videoOnly") !== "false";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    engine.siteVideoOnly(videoOnly && !browsing).catch(() => {}); // browsing shows the whole page
  }, [videoOnly, browsing]);
  const setVideoOnly = (v: boolean) => {
    setVideoOnlyState(v);
    try {
      localStorage.setItem("wsa.videoOnly", String(v));
    } catch {
      /* not remembered */
    }
  };

  return (
    <div className="source-bar">
      <input className="source-input" aria-label="Search YouTube or paste a video link" placeholder={siteUrl || "Search YouTube or paste a video link"} value={address}
        onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          setBrowsing(true);
          go();
        }} />
      <Button
        onClick={() => {
          setBrowsing(true); // search results need room
          go();
        }}
      >
        Go
      </Button>
      <Button variant={browsing ? "primary" : "secondary"} onClick={() => setBrowsing(!browsing)}
        title={browsing ? "Back to the session: the video plays in its box, letterboxed" : "Make YouTube big to search and pick a song"}>
        {browsing ? "✓ Done" : "⤢ Browse"}
      </Button>
      <Button variant="quiet" pressed={videoOnly} onClick={() => setVideoOnly(!videoOnly)}
        title="On a video page, show only the video, letterboxed (whole picture, no cropping). Off: the whole YouTube page.">
        {videoOnly ? "✓ " : ""}Video only
      </Button>
      {g.stage === "idle" ? (
        <>
          <Button variant="primary" onClick={() => {
            setBrowsing(false); // learning plays the video: back to the session view
            getSong.start();
          }} disabled={!isVideoPage} title={isVideoPage ? "Learn this video now: record its sound once, then split and analyze it" : "Open a video first"}>
            ⤓ Learn this song
          </Button>
          <label className="checkbox-line small" title="When a video that is not a song yet plays from its start, learn it automatically (it plays once, in real time)">
            <input type="checkbox" checked={learning.auto} onChange={(e) => learning.setAuto(e.target.checked)} /> Learn while playing
          </label>
        </>
      ) : g.stage === "pending" ? (
        <span className="source-status">
          {g.message} “{g.title}” · {fmtTime(g.seconds)}
          <Button size="sm" variant="primary" onClick={getSong.savePending}>
            Save as song
          </Button>
          <Button size="sm" variant="quiet" onClick={getSong.cancel}>
            Discard
          </Button>
        </span>
      ) : g.stage === "error" ? (
        <span className="source-status is-error">
          {g.message}{" "}
          <Button size="sm" variant="quiet" onClick={getSong.dismiss}>
            OK
          </Button>
        </span>
      ) : (
        <span className="source-status">
          <span className="rec-dot" aria-hidden />
          {g.stage === "waitingAd"
            ? g.message
            : g.stage === "saving"
              ? "Saving…"
              : `Learning “${g.title}” · ${fmtTime(g.seconds)}${g.duration ? ` / ${fmtTime(g.duration)}` : ""} · let it play to the end`}
          {g.adDuring && <span className="warn-text"> · an ad played (it is in the recording)</span>}
          {g.stage === "waitingAd" && (
            <Button size="sm" variant="quiet" onClick={getSong.cancel}>
              Cancel
            </Button>
          )}
          {g.stage === "recording" && (
            <>
              <Button size="sm" onClick={getSong.stopNow} title="Stop here and keep what is recorded">
                Stop & keep
              </Button>
              <Button size="sm" variant="quiet" onClick={getSong.cancel}>
                Cancel
              </Button>
            </>
          )}
        </span>
      )}
      <div className="projector-menu">
        <Button variant="quiet" aria-expanded={queueOpen} popoverTarget="queue-pop" style={anchorStyle("queue-pop")} title="Prepare songs ahead: they are learned one after another">
          Queue{learning.queue.length ? ` (${learning.queue.length})` : ""}
        </Button>
        <Popover id="queue-pop" open={queueOpen} onOpenChange={setQueueOpen} label="Prepare ahead" className="queue-popover">
            <p className="small muted">Paste YouTube links for this week's songs. Each one plays once, in real time, at full video volume (turn the Windows volume down, or set YouTube sound to “always through the app” for quiet learning), then gets stems, chords and cues.</p>
            <textarea value={queueText} onChange={(e) => setQueueText(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" aria-label="YouTube links" />
            <div className="row-tight">
              <Button size="sm" onClick={() => { learning.addToQueue(queueText); setQueueText(""); }} disabled={!queueText.trim()}>
                Add
              </Button>
              {learning.queueRunning ? (
                <Button size="sm" onClick={learning.stopQueue}>Pause queue</Button>
              ) : (
                <Button size="sm" variant="primary" onClick={learning.startQueue} disabled={!learning.queue.length}>
                  Start learning
                </Button>
              )}
              <Button size="sm" variant="quiet" onClick={() => learning.setQueue([])} disabled={!learning.queue.length}>
                Clear
              </Button>
            </div>
            <ol className="queue-list small">
              {learning.queue.map((q) => (
                <li key={q}>{q.replace(/^https?:\/\/(www\.)?/, "")}</li>
              ))}
              {!learning.queue.length && <li className="muted">Empty.</li>}
            </ol>
        </Popover>
      </div>
      <span className="spacer" />
      <Segmented
        label="Scenes"
        value={layout}
        onChange={setLayout}
        options={[
          { value: "split", label: "Split" },
          { value: "song", label: "Song only" },
          { value: "camera", label: "Camera only" },
        ]}
      />
      <div className="projector-menu">
        <Button variant="quiet" aria-expanded={projOpen} popoverTarget="proj-pop" style={anchorStyle("proj-pop")}
          onClick={async () => setDisplays(await engine.displays().catch(() => []))}>
          ⛶ Projector
        </Button>
        <Popover id="proj-pop" open={projOpen} onOpenChange={setProjOpen} label="Projector">
            <p className="small muted">Show a scene full screen on another display or TV. Press Esc on it to close.</p>
            <Segmented label="Scene" value={projView} onChange={setProjView} options={[{ value: "chords", label: "Chords" }, { value: "camera", label: "Camera" }]} />
            {displays.map((d) => (
              <Button key={d.index} size="sm" onClick={() => openProjector(d.index)} disabled={projView === "chords" && !songId}>
                {d.label}
                {d.thisWindow ? " · this window" : ""}
              </Button>
            ))}
            <Button size="sm" variant="quiet" onClick={() => engine.projectorClose()}>
              Close the projector
            </Button>
        </Popover>
      </div>
    </div>
  );
}

function PrepSteps({ p, job, capture, goPrepare }: { p: P; job?: JobState; capture: ReturnType<typeof useGetSong>["state"]; goPrepare: (t?: string) => void }) {
  const a = p.analysis;
  const confirmed = p.chart.chords.filter((c) => c.confirmed).length;
  const steps = [
    { label: p.song?.referenceUrl ? "Recorded from the video" : "Song imported", state: capture.stage === "recording" ? "run" : "done", to: undefined },
    { label: job?.running ? `Splitting stems · ${Math.round(job.pct)}%` : "Stems separated", state: job?.running ? "run" : a?.stems?.length ? "done" : "todo", to: "stems" },
    { label: a ? `Chords · key ${spellKey(p.song?.key ?? a.key.name)}${p.song?.capo ? ` · capo ${p.song.capo}` : ""}` : "Chords", state: a ? "done" : "todo", to: "chart" },
    { label: p.chart.chords.length ? `${p.chart.chords.length - confirmed} chords to check` : "Check chords", state: p.chart.chords.length && confirmed === p.chart.chords.length ? "done" : "todo", to: "chart" },
    { label: "Sections + cues", state: p.chart.sections.length ? "done" : "todo", to: "cues" },
  ];
  return (
    <ol className="prep-steps" aria-label="Song preparation">
      {steps.map((s, i) => (
        <li key={i} className={`prep-step is-${s.state}`}>
          {s.to ? (
            <button onClick={() => goPrepare(s.to)} title="Open in Prepare">
              {s.label}
            </button>
          ) : (
            <span>{s.label}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** Which end of the camera's focus range is far (checked on the EMEET C60E, see the focus test). */
const FOCUS_FAR_IS_HIGH = false;

function CameraScene({
  camera,
  mirror,
  setMirror,
  rec,
  seconds,
}: {
  camera: ReturnType<typeof useCamera>;
  mirror: boolean;
  setMirror: (m: boolean) => void;
  rec: boolean;
  seconds: number;
}) {
  const [lookOpen, setLookOpen] = useState(false);
  return (
    <article className="scene camera-scene">
      <header className="scene-head">
        <span className="strong">Camera</span>
        <span className="muted small">{camera.info || "live preview"}</span>
        <span className="spacer" />
        <select aria-label="Camera" value={camera.deviceId} onChange={(e) => camera.choose(e.target.value)} disabled={rec}>
          {camera.devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
        <select aria-label="Camera recording quality" value={camera.quality} disabled={rec} onChange={(e) => camera.setQuality(e.target.value as CameraQuality)}
          title="Quality of the recorded camera video (MP4). The preview's black bars are only on screen, never in the file.">
          <option value="1080p60">1080p · 60 fps</option>
          <option value="4k30">4K · 30 fps</option>
        </select>
        {camera.canFocus && (
          <span className="row-tight cam-focus" title="Auto: the camera focuses by itself. Fixed: one distance, so the room stays sharp and the focus never hunts.">
            <select aria-label="Camera focus" value={camera.focus.auto ? "auto" : "fixed"} onChange={(e) => camera.setFocus({ ...camera.focus, auto: e.target.value === "auto" })}>
              <option value="auto">Focus: auto</option>
              <option value="fixed">Focus: fixed</option>
            </select>
            {!camera.focus.auto && (
              <>
                <span className="small muted">Near</span>
                <input type="range" min={0} max={1} step={0.01} aria-label="Focus distance, near to far"
                  value={FOCUS_FAR_IS_HIGH ? camera.focus.value : 1 - camera.focus.value}
                  onChange={(e) => camera.setFocus({ auto: false, value: FOCUS_FAR_IS_HIGH ? +e.target.value : 1 - +e.target.value })} />
                <span className="small muted">Far</span>
              </>
            )}
          </span>
        )}
        <Button size="sm" variant="quiet" pressed={lookOpen} onClick={() => setLookOpen(!lookOpen)} title="Colour look (LUT) and camera settings: white balance, exposure, tone">
          🎨 Look
        </Button>
        <Button size="sm" variant="quiet" onClick={() => engine.projectorOpen("camera", -1).catch(() => {})}
          title="Open the camera in its own window: move it anywhere and resize it (stays on top). Close it with its X.">
          ⧉ Pop out
        </Button>
        <Button size="sm" variant="quiet" pressed={mirror} onClick={() => setMirror(!mirror)} title="Mirror the preview (the recording is never mirrored)">
          Mirror
        </Button>
      </header>
      <div className="scene-screen camera-screen">
        {camera.error ? (
          <span className="muted small camera-error">{camera.error}</span>
        ) : (
          <video
            ref={(el) => {
              if (el && el.srcObject !== camera.stream) el.srcObject = camera.stream;
            }}
            autoPlay
            muted
            playsInline
            className={mirror ? "is-mirrored" : ""}
            aria-label="Camera preview"
          />
        )}
        {rec && <span className="rec-pill">REC {fmtTime(seconds)}</span>}
      </div>
      {lookOpen && <CameraLookPanel camera={camera} recording={rec} onClose={() => setLookOpen(false)} />}
    </article>
  );
}

function StemStrip({
  role,
  stems,
  mixOf,
  setMix,
  meters,
  anySolo,
}: {
  role: Role;
  stems: StemInfo[];
  mixOf: (id: string) => MixState;
  setMix: (id: string, m: Partial<MixState>) => void;
  meters: Record<string, number>;
  anySolo: boolean;
}) {
  const allMuted = stems.every((s) => mixOf(s.id).mute);
  const audible = (s: StemInfo) => (anySolo ? mixOf(s.id).solo : !mixOf(s.id).mute);
  const peak = Math.max(0, ...stems.filter(audible).map((s) => meters[s.id] ?? 0));
  const single = stems.length === 1 ? stems[0] : null;
  const silenced = anySolo && !stems.some((s) => mixOf(s.id).solo) && !allMuted;
  const quiet = stems.every((s) => s.quiet);
  const name = single ? single.name.replace(/\s*\(.*\)$/, "") : `${ROLE_LABEL[role]} ×${stems.length}`;
  return (
    <div className={`strip${allMuted || silenced ? " is-muted" : ""}`}>
      <div className="strip-name" title={single?.name ?? stems.map((s) => s.name).join(", ")}>
        <i className={`role-dot role-${role}`} aria-hidden /> {name}
      </div>
      <Meter peak={allMuted ? 0 : peak} vertical />
      {single ? (
        <input type="range" className="strip-fader" min={0} max={150} value={Math.round(mixOf(single.id).gain * 100)} aria-label={`${single.name} level`}
          aria-valuetext={`${Math.round(mixOf(single.id).gain * 100)} percent`} onChange={(e) => setMix(single.id, { gain: +e.target.value / 100 })}
          onDoubleClick={() => setMix(single.id, { gain: 1 })} />
      ) : (
        <div className="strip-parts" role="group" aria-label={`${ROLE_LABEL[role]} parts`}>
          {stems.map((s) => (
            <button key={s.id} className={`part${mixOf(s.id).mute ? "" : " is-on"}`} onClick={() => setMix(s.id, { mute: !mixOf(s.id).mute })}
              aria-pressed={!mixOf(s.id).mute} title={`${s.name}: ${mixOf(s.id).mute ? "muted" : "on"}`}>
              {s.id.split("_")[1]?.toUpperCase() ?? s.name[0]}
            </button>
          ))}
        </div>
      )}
      <div className="strip-btns">
        <Button size="sm" pressed={allMuted} onClick={() => stems.forEach((s) => setMix(s.id, { mute: !allMuted }))} aria-label={`${allMuted ? "Unmute" : "Mute"} ${name}`}>
          M
        </Button>
        <Button size="sm" pressed={stems.some((s) => mixOf(s.id).solo)} onClick={() => {
            const on = !stems.some((s) => mixOf(s.id).solo);
            stems.forEach((s) => setMix(s.id, { solo: on }));
          }} aria-label={`Solo ${name}`}>
          S
        </Button>
      </div>
      {(quiet || (role === "guitar" && allMuted)) && <span className="strip-tag">{quiet ? "quiet part" : "reference, muted"}</span>}
    </div>
  );
}

function PracticeControls({ p }: { p: P }) {
  const { song, analysis, update, project, stems } = p;
  const toast = useToast();
  const [exporting, setExporting] = useState(false);
  if (!song || !project) return null;
  const ctx = contextFor(song, analysis);
  const doExport = async () => {
    setExporting(true);
    const mixOf = (id: string): MixState => song.mixer[id] ?? defaultMix(stems.find((s) => s.id === id));
    const anySolo = stems.some((s) => mixOf(s.id).solo);
    try {
      const r = await engine.exportMix(project.id, {
        tracks: stems.map((s) => ({ id: s.id, gain: (anySolo ? mixOf(s.id).solo : !mixOf(s.id).mute) ? mixOf(s.id).gain : 0 })),
        tempo: song.tempoRatio,
        semitones: song.linkPitchToTranspose ? song.transpose : 0,
        masterGain: song.master.gain,
        limit: song.master.limiter,
      });
      if (r.cancelled) return;
      if (r.error) toast({ tone: "error", text: "Export failed: " + r.error });
      else toast({ tone: r.warning ? "warn" : "ok", text: r.warning ?? "Rehearsal mix saved.", action: r.path ? { label: "Show file", run: () => engine.reveal(r.path!) } : undefined });
    } catch (e: any) {
      toast({ tone: "error", text: "Export failed: " + (e.message ?? e) });
    } finally {
      setExporting(false);
    }
  };
  return (
    <span className="practice">
      <label className="practice-item" title="Changes speed, not pitch. Double-click to reset.">
        Tempo {Math.round(song.tempoRatio * 100)}%
        <input type="range" min={50} max={150} value={Math.round(song.tempoRatio * 100)} aria-label="Tempo"
          onChange={(e) => update((s) => ({ ...s, tempoRatio: +e.target.value / 100 }), "tempo")} onDoubleClick={() => update((s) => ({ ...s, tempoRatio: 1 }))} />
      </label>
      <span className="practice-item" role="group" aria-label="Key">
        Key {analysis || song.key ? keyName(ctx.playKey) : ""}
        <Button size="sm" variant="quiet" onClick={() => update((s) => ({ ...s, transpose: Math.max(-6, s.transpose - 1) }), "transpose")} aria-label="Key down a semitone">
          −
        </Button>
        <Button size="sm" variant="quiet" onClick={() => update((s) => ({ ...s, transpose: Math.min(6, s.transpose + 1) }), "transpose")} aria-label="Key up a semitone">
          +
        </Button>
      </span>
      <Button size="sm" onClick={doExport} disabled={exporting} title="Save the current mix (levels, tempo, key) as a WAV file. Click, cues and takes are not included.">
        {exporting ? "Exporting…" : "Export mix"}
      </Button>
    </span>
  );
}
