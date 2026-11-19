import { useCallback, useEffect, useRef, useState } from "react";
import { engineAvailable, on } from "./bridge";
import { sectionAt } from "./chart";
import { roleOf } from "./components/music";
import { defaultMix } from "./song";
import { FlowSteps, TransportBar, type Workspace } from "./components/shell";
import { Button, ConfirmHost, Segmented, ToastHost, useConfirm, useToast } from "./components/ui";
import { engine, type LibrarySong } from "./engine";
import { comboOf, loadKeys, SESSION_ACTIONS, type Action } from "./shortcuts";
import { spellKey } from "./theory/notes";
import { countIn } from "./timeline";
import { useAnalysisJobs } from "./useAnalysisJobs";
import { useProject, useTransport } from "./useProject";
import { Library } from "./views/Library";
import { PrepareChart } from "./views/PrepareChart";
import { PrepareCues } from "./views/PrepareCues";
import { PrepareStems } from "./views/PrepareStems";
import { Session } from "./views/Session";
import { useGetSong } from "./session/useGetSong";
import { useLearning } from "./session/useLearning";
import { Settings } from "./views/Settings";
import { Tuner } from "./views/Tuner";

type PrepareTab = "chart" | "cues" | "stems";

function loadTheme(): "dark" | "light" {
  try {
    return localStorage.getItem("wsa.theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export default function App() {
  if (!engineAvailable())
    return (
      <div className="standalone">
        <h1>Worship Studio</h1>
        <p>This screen runs inside the Worship Studio desktop app.</p>
        <code>app\build\WorshipStudio_artefacts\Release\Worship Studio.exe</code>
      </div>
    );
  return (
    <ToastHost>
      <ConfirmHost>
        <Shell />
      </ConfirmHost>
    </ToastHost>
  );
}

function Shell() {
  const [songs, setSongs] = useState<LibrarySong[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [ws, setWs] = useState<Workspace>("library");
  const [prepTab, setPrepTab] = useState<PrepareTab>("chart");
  const [importing, setImporting] = useState<number | null>(null);
  const [theme, setThemeState] = useState(loadTheme);
  const [keys, setKeys] = useState(loadKeys);
  const [recSeconds, setRecSeconds] = useState<number | null>(null);
  const [recFailed, setRecFailed] = useState("");
  useEffect(
    () =>
      on("capture", (c: { seconds: number; failed?: string }) => {
        if (c.failed) {
          setRecSeconds(null);
          setRecFailed(c.seconds >= 5 ? `${c.failed} Open Session to save it.` : c.failed);
        } else setRecSeconds(c.seconds);
      }),
    [],
  );
  useEffect(() => {
    // the capture event stops when recording stops; clear the indicator shortly after
    if (recSeconds === null) return;
    const t = window.setTimeout(() => setRecSeconds(null), 1500);
    return () => window.clearTimeout(t);
  }, [recSeconds]);
  const [countInState, setCountInState] = useState<{ until: number; beats: number } | null>(null);
  // The count-in display ends when playback reaches the start point or stops.
  const { pos: tpos, playing: tplaying } = useTransport();
  useEffect(() => {
    if (countInState && (!tplaying || tpos >= countInState.until)) setCountInState(null);
  }, [countInState, tpos, tplaying]);
  const p = useProject(current);
  const { pos, playing } = useTransport();
  const toast = useToast();
  // A recording from the video that stopped by itself (e.g. disk full): say so.
  useEffect(() => {
    if (!recFailed) return;
    toast({ tone: "error", text: recFailed });
    setRecFailed("");
  }, [recFailed, toast]);
  const confirm = useConfirm();

  const setTheme = (t: "dark" | "light") => {
    setThemeState(t);
    try {
      localStorage.setItem("wsa.theme", t);
    } catch {
      /* not critical */
    }
  };
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const refreshLibrary = useCallback(
    () =>
      engine
        .listSongs()
        .then((s) => setSongs(s.sort((a, b) => b.modified - a.modified)))
        .catch((e) => toast({ tone: "error", text: "Could not read the library: " + (e.message ?? e) })),
    [toast],
  );
  useEffect(() => {
    refreshLibrary();
  }, [refreshLibrary]);
  // A solo take cut off by a crash or power loss becomes a song on the next start.
  useEffect(() => {
    engine
      .soloRecover()
      .then((list) => {
        if (!list?.length) return;
        refreshLibrary();
        for (const r of list)
          toast({ tone: "warn", text: `A solo take was recovered after the app closed: “${r.title}” is in the Library. ${r.warning ?? ""}` });
      })
      .catch(() => {});
  }, [refreshLibrary, toast]);
  useEffect(() => on("import", (pct: number) => setImporting(pct)), []);

  const go = useCallback((w: Workspace, sub?: string) => {
    setWs(w);
    if (w === "prepare" && sub) setPrepTab(sub as PrepareTab);
  }, []);

  // Where a song opens depends on its state, known once it has loaded.
  const openIntent = useRef<string | null>(null);
  const routeFor = () => {
    if (!p.analysis) go("prepare", "stems");
    else go("session"); // chords to check are shown there (and one click away in Prepare)
  };
  const open = (id: string) => {
    if (id === current && p.project?.id === id) return routeFor(); // already open: just go there
    setCurrent(id);
    openIntent.current = id;
  };
  useEffect(() => {
    if (!p.project || openIntent.current !== p.project.id) return;
    openIntent.current = null;
    routeFor();
  }, [p.project?.id]);

  const doImport = async () => {
    try {
      setImporting(0);
      const r = await engine.importSong();
      setImporting(null);
      if (r.id) {
        await refreshLibrary();
        setCurrent(r.id);
        go("prepare", "stems");
        toast({ tone: "ok", text: "Song imported. Next: analyze it." });
      }
    } catch (e: any) {
      setImporting(null);
      toast({ tone: "error", text: "Import failed: " + (e.message ?? e) });
    }
  };

  // Analysis runs in the background; results load whenever it finishes, wherever the user is.
  const currentRef = useRef(current);
  currentRef.current = current;
  const reloadRef = useRef(p.reload);
  reloadRef.current = p.reload;
  const analysis = useAnalysisJobs((songId) => {
    if (songId === currentRef.current) reloadRef.current({ mergeNewAnalysis: true });
    refreshLibrary();
    const title = songs.find((s) => s.id === songId)?.title ?? "the song";
    toast({ tone: "ok", text: `Analysis of ${title} finished.`, action: { label: "Review chords", run: () => { setCurrent(songId); go("prepare", "chart"); } } });
  });

  const togglePlay = useCallback(() => {
    if (playing) return engine.pause();
    const song = p.song;
    if (song && song.click.countInBars > 0 && p.grid.length && pos >= 0) {
      const c = countIn(p.grid, pos, song.click.countInBars, song.click.beatsPerBar);
      setCountInState({ until: c.from, beats: song.click.countInBars * song.click.beatsPerBar });
      return engine.play(c.from, c.preRoll);
    }
    return engine.play();
  }, [playing, p.song, p.grid, pos]);

  // ---- shortcuts (configurable, ignored while typing or in a dialog)
  const live = useRef({ togglePlay, pos, p, keys, ws });
  live.current = { togglePlay, pos, p, keys, ws };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.repeat) return; // holding a key must not toggle play or click on and off
      const textEntry =
        el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable ||
        (el.tagName === "INPUT" && !["range", "checkbox", "radio", "button"].includes((el as HTMLInputElement).type));
      if (textEntry) return;
      const type = el.tagName === "INPUT" ? (el as HTMLInputElement).type : "";
      // A focused slider keeps its own keys; a focused checkbox keeps Space. Everything else still works.
      if (type === "range" && /^(Arrow|Home|End|Page)/.test(e.code)) return;
      if ((type === "checkbox" || type === "radio") && e.code === "Space") return;
      if (el.getAttribute("role") === "radio" && /^Arrow/.test(e.code)) return; // segmented controls use arrows
      // A button reached with the keyboard keeps Space = press it. (Mouse clicks drop focus, see below.)
      if (el.tagName === "BUTTON" && (e.code === "Space" || e.code === "Enter")) return;
      if (document.querySelector("dialog[open], [popover]:popover-open")) return; // a dialog or panel has the keys
      const { togglePlay, pos, p, keys, ws } = live.current;
      const action = (Object.keys(keys) as Action[]).find((a) => keys[a] === comboOf(e));
      if (action && SESSION_ACTIONS.includes(action)) {
        // Record and monitoring belong to Session (they work with no song, in solo recording too)
        if (ws === "session") {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("ws-action", { detail: action }));
        }
        return;
      }
      if (!action || !p.song) return;
      e.preventDefault();
      const secs = p.chart.sections;
      const cur = sectionAt(secs, pos);
      const run: Record<Action, () => void> = {
        playPause: () => togglePlay(),
        back5: () => engine.seek(Math.max(0, pos - 5)),
        fwd5: () => engine.seek(pos + 5),
        toStart: () => engine.seek(0),
        nextSection: () => {
          if (cur + 1 < secs.length) engine.seek(secs[cur + 1].start);
        },
        prevSection: () => {
          if (cur >= 0) engine.seek(pos - secs[cur].start > 2 || cur === 0 ? secs[cur].start : secs[cur - 1].start);
        },
        toggleLoop: () => {
          if (p.song?.loop) p.update((s) => ({ ...s, loop: { ...s.loop!, enabled: !s.loop!.enabled } }), "loop");
        },
        toggleClick: () => p.update((s) => ({ ...s, click: { ...s.click, enabled: !s.click.enabled } })),
        muteGuitars: () => {
          const g = p.stems.filter((s) => roleOf(s) === "guitar");
          const all = g.length > 0 && g.every((x) => p.song!.mixer[x.id]?.mute);
          p.update((s) => {
            const mixer = { ...s.mixer };
            for (const x of g) mixer[x.id] = { ...(mixer[x.id] ?? defaultMix(x)), mute: !all };
            return { ...s, mixer };
          });
        },
        record: () => {},
        hearGuitar: () => {},
        hearVocal: () => {},
        undo: () => p.undo(),
        redo: () => p.redo(),
      };
      run[action]();
    };
    // After a MOUSE click a button gives up focus, so Space keeps meaning play/pause while you hold the guitar.
    const onUp = (e: MouseEvent) => {
      const b = (e.target as HTMLElement).closest("button");
      if (b && e.detail > 0) window.setTimeout(() => b.blur(), 0);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const song = p.song;
  const songWs = ws === "prepare";

  const deleteSong = async (id: string, title: string) => {
    const ok = await confirm({
      title: `Remove “${title}”?`,
      body: "The song folder with its stems, chart and cues moves to the Windows Recycle Bin. Your original file is not touched.",
      confirm: "Move to Recycle Bin",
      danger: true,
    });
    if (!ok) return;
    try {
      if (analysis.jobs[id]?.running) {
        analysis.cancel(id); // the sidecar must not write into a folder that is being removed
        await new Promise((r) => setTimeout(r, 1500));
      }
      await engine.deleteSong(id);
      if (id === current) setCurrent(null);
      setWs("library");
      refreshLibrary();
      toast({ tone: "ok", text: "Moved to the Recycle Bin." });
    } catch (e: any) {
      toast({ tone: "error", text: String(e.message ?? e) });
    }
  };

  const navItem = (w: Workspace, label: string, icon: string, opts: { rec?: string; disabled?: boolean; hint?: string } = {}) => (
    <button
      className={`nav-item${ws === w ? " is-current" : ""}`}
      onClick={() => go(w)}
      disabled={opts.disabled}
      aria-current={ws === w ? "page" : undefined}
      title={opts.hint ?? label}
    >
      <span className="nav-icon" aria-hidden>
        {icon}
      </span>
      <span className="nav-label">{label}</span>
      {opts.rec && <span className="pill pill-rec" aria-label="Recording">{opts.rec}</span>}
    </button>
  );

  // "Get this song" (record a video's sound once) is supervised here, so leaving Session never orphans it.
  // After learning, the next autoplayed video keeps playing only when it will be learned too.
  const keepPlayingRef = useRef<() => boolean>(() => false);
  const getSong = useGetSong(async (id, info) => {
    await refreshLibrary();
    setCurrent(id);
    analysis.start(id, "fast", "auto");
    if (info.stalledSeconds >= 1)
      toast({
        tone: "warn",
        text: `Song saved, but the video stopped to load for about ${Math.round(info.stalledSeconds)} s while learning, so the recording has a silent gap there. Learn it again if that part matters.`,
      });
    else toast({ tone: "ok", text: "Song saved. Splitting the stems and finding the chords now." });
  }, () => keepPlayingRef.current());
  const learning = useLearning(getSong, songs, ws === "session");
  keepPlayingRef.current = () => (learning.auto && ws === "session") || learning.queueRunning;

  return (
    <div className={`shell${song ? " has-transport" : ""}`}>
      {song && (
        <a className="skip-link" href="#transport" onClick={(e) => { e.preventDefault(); document.querySelector<HTMLElement>(".tp-play")?.focus(); }}>
          Skip to transport
        </a>
      )}
      <header className="topbar no-print">
        <div className="brand">
          <svg viewBox="0 0 22 22" aria-hidden>
            <circle cx="11" cy="11" r="10" fill="none" stroke="var(--accent)" strokeWidth="1.5" />
            <path d="M6 14c2-5 8-5 10 0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="11" cy="8" r="1.6" fill="currentColor" />
          </svg>
          Worship Studio
        </div>
        <nav className="topnav" aria-label="Main">
          {navItem("library", "Library", "♫")}
          {navItem("session", "Session", "▣", recSeconds !== null ? { rec: "REC" } : {})}
          {navItem("prepare", "Prepare", "✎", { disabled: !song, hint: song ? `Chart, sections, cues and stems of ${song.title}` : "Open a song first" })}
          {navItem("tuner", "Tuner", "◎")}
          {navItem("settings", "Settings", "⚙")}
        </nav>
      </header>

      <main className="main" id="main">
        {current && p.loadError && !song ? (
          <div className="empty-state">
            <h2>This song could not be opened</h2>
            <div className="empty-body">{p.loadError}</div>
            <div className="empty-action">
              <Button onClick={() => p.reload()}>Try again</Button> <Button variant="quiet" onClick={() => { setCurrent(null); setWs("library"); }}>Back to library</Button>
            </div>
          </div>
        ) : songWs && song && p.project ? (
          <>
            <header className="song-head no-print">
              <div className="song-title">
                <h1 title={song.title}>{song.title}</h1>
                <span className="muted small">
                  {p.analysis ? `Key ${spellKey(song.key ?? p.analysis.key.name)}` : "Not analyzed"}
                  {p.analysis?.rhythm.bpm ? ` · about ${Math.round(p.analysis.rhythm.bpm)} BPM` : ""}
                  {song.capo ? ` · Capo ${song.capo}` : ""}
                </span>
                {song.referenceUrl && (
                  <Button
                    size="sm"
                    variant="quiet"
                    title={song.referenceUrl}
                    onClick={() => go("session")}
                  >
                    ▶ Open in Session
                  </Button>
                )}
              </div>
              <FlowSteps p={p} current={ws} go={go} />
            </header>
            {p.project.error && <div className="banner banner-error">{p.project.error}</div>}
            {p.saveError && (
              <div className="banner banner-error" role="alert">
                Your last change is not saved yet: {p.saveError}. The app keeps trying. Check that the disk is not full.
              </div>
            )}
            {p.syncError && (
              <div className="banner banner-error" role="alert">
                {p.syncError}. What you hear may not match the screen. Change the setting again, or reopen the song.
              </div>
            )}

            {ws === "prepare" && (
              <>
                <div className="subnav no-print">
                  <Segmented
                    label="Prepare sections"
                    value={prepTab}
                    onChange={setPrepTab}
                    options={[
                      { value: "chart", label: "Chart & shapes" },
                      { value: "cues", label: "Click & cues" },
                      { value: "stems", label: "Stems & analysis" },
                    ]}
                  />
                  <Button size="sm" variant="quiet" onClick={() => deleteSong(p.project!.id, song.title)}>
                    Remove song…
                  </Button>
                </div>
                {prepTab === "chart" && <PrepareChart p={p} goStems={() => setPrepTab("stems")} />}
                {prepTab === "cues" && <PrepareCues p={p} />}
                {prepTab === "stems" && (
                  <PrepareStems
                    p={p}
                    job={analysis.jobs[p.project.id]}
                    onStart={(q, d) => analysis.start(p.project!.id, q, d)}
                    onCancel={() => analysis.cancel(p.project!.id)}
                  />
                )}
              </>
            )}
          </>
        ) : ws === "session" ? (
          <Session
            p={p}
            theme={theme}
            job={current ? analysis.jobs[current] : undefined}
            countInState={countInState}
            setCountInState={setCountInState}
            getSong={getSong}
            learning={learning}
            goPrepare={(tab) => go("prepare", tab ?? "chart")}
            onSoloSaved={async (id) => {
              await refreshLibrary();
              setCurrent(id);
            }}
          />
        ) : ws === "tuner" ? (
          <>
            <h1 className="page-title">Tuner</h1>
            <Tuner tuningName={song?.tuning} />
          </>
        ) : ws === "settings" ? (
          <Settings theme={theme} setTheme={setTheme} keys={keys} setKeys={setKeys} />
        ) : (
          <Library songs={songs} current={current} importing={importing} onImport={doImport} onOpen={open}
            onSolo={() => {
              engine.pause().catch(() => {});
              setCurrent(null); // no song: Session shows the solo recording panel
              go("session");
            }} />
        )}
      </main>

      {song && (
        <footer className="transport-wrap no-print">
          <TransportBar p={p} pos={pos} playing={playing} onPlay={togglePlay} />
        </footer>
      )}
    </div>
  );
}
