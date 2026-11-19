import { useEffect, useRef, useState } from "react";
import { loadKeys, prettyCombo } from "../shortcuts";
import { Banner, Button } from "../components/ui";
import { engine, type InputCleanupSettings, type MonitorStatus, type OutputMode } from "../engine";

export interface InputSlot {
  label: "Guitar" | "Vocal";
  device: string;
  /** Windows endpoint ID (what is opened); the name is for display */
  id?: string;
  armed: boolean;
}

const MON_ON = "wsa.monitor"; // { Guitar: { on, gain }, Vocal: { on, gain } } (was a plain boolean under "wsa.monitorOn")
const MON_GAIN = "wsa.monitorGain";
const readJson = <T,>(k: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
};
const writeJson = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* not remembered */
  }
};

/**
 * Hear the guitar (E2 Gen2) and the vocal (PD200X) in the headphones of the output device, together with the song.
 * Software monitoring: a little late (shown per input), takes are not affected. Low-latency mode shrinks the
 * output buffer while monitoring; the ring between the clocks only grows if the sound breaks up.
 */
type MonPrefs = Record<"Guitar" | "Vocal", { on: boolean; gain: number }>;
/** YouTube sound: "direct" = Windows plays it (silent in exclusive mode); "app" = the app plays it (needs the
 *  Windows setting that sends the app's browser to VB-Cable, see the help text) */
const PAGE_ROUTE = "wsa.youtubeRoute";
const PAGE_GAIN = "wsa.youtubeGain";
const MON_MODE = "wsa.monitorOutputMode2"; // v2: default changed to shared low latency
/** Buzz cleanup per input (hum filter + gate): on what you hear and on the lined-up takes; raw files stay dry. */
const CLEANUP = "wsa.inputCleanup";
type CleanPrefs = Record<"Guitar" | "Vocal", InputCleanupSettings>;
const CLEAN_DEFAULT: InputCleanupSettings = { hum: false, humHz: 60, gate: false, thresholdDb: -50, vocal: false, lift: 9 };

/** Live monitoring state for both inputs. `row(label)` goes in that input's card; `output` is the shared output
 *  settings (mode, YouTube sound). One hook per screen: it starts and stops the monitor streams. */
export function useMonitorControls({ slots, outputName }: { slots: InputSlot[]; outputName: string }) {
  const [prefs, setPrefs] = useState<MonPrefs>(() =>
    readJson<MonPrefs>(MON_ON, { Guitar: { on: readJson<unknown>("wsa.monitorOn", false) === true, gain: readJson(MON_GAIN, 1) }, Vocal: { on: false, gain: 1 } }),
  );
  const [mode, setMode] = useState<OutputMode>(() => {
    // Shared low latency by default (about 35 ms): YouTube stays audible. Exclusive (about 26 ms) blocks every other
    // sound on the output, so it is a choice for recording sessions (JP, 2026-11-17).
    const m = readJson<unknown>(MON_MODE, "low");
    return m === "normal" || m === "low" || m === "exclusive" ? m : "low";
  });
  const [status, setStatus] = useState<MonitorStatus | null>(null);
  const [route, setRouteState] = useState<"direct" | "app">(() => (readJson<unknown>(PAGE_ROUTE, "direct") === "app" ? "app" : "direct"));
  const [pageGain, setPageGain] = useState<number>(() => readJson(PAGE_GAIN, 0.8));
  const [showHelp, setShowHelp] = useState(false);
  const setRoute = (r: "direct" | "app") => {
    setRouteState(r);
    writeJson(PAGE_ROUTE, r);
    if (r === "app") setShowHelp(true);
  };
  const [error, setError] = useState("");
  const [clean, setClean] = useState<CleanPrefs>(() => {
    const c = readJson<Partial<CleanPrefs>>(CLEANUP, {});
    return { Guitar: { ...CLEAN_DEFAULT, ...c.Guitar }, Vocal: { ...CLEAN_DEFAULT, ...c.Vocal } };
  });
  const [learning, setLearning] = useState<"Guitar" | "Vocal" | null>(null);
  const [learnMsg, setLearnMsg] = useState<Partial<Record<"Guitar" | "Vocal", string>>>({});
  // The engine keeps the settings per input; send them at start and on every change (takes use them too).
  useEffect(() => {
    for (const label of ["Guitar", "Vocal"] as const) engine.inputCleanup(label, clean[label]).catch((e) => setError(String(e.message ?? e)));
  }, [clean]);
  const updateClean = (label: "Guitar" | "Vocal", patch: Partial<InputCleanupSettings>) => {
    setClean((c) => {
      const next = { ...c, [label]: { ...c[label], ...patch } };
      writeJson(CLEANUP, next);
      return next;
    });
  };
  /** "Learn noise": 2 s of the input with the strings muted; gate threshold = loudest buzz + 6 dB. Nothing is stored. */
  const learnNoise = async (label: "Guitar" | "Vocal") => {
    setLearning(label);
    setLearnMsg((m) => ({ ...m, [label]: "Hands off the strings for 2 seconds…" }));
    try {
      await engine.inputCleanupPeak(label); // reset
      await new Promise((r) => window.setTimeout(r, 2000));
      const peak = await engine.inputCleanupPeak(label);
      if (peak < -100) {
        setLearnMsg((m) => ({ ...m, [label]: "No sound came in. Is the input plugged in and monitoring on?" }));
      } else {
        const thr = Math.round(Math.min(-20, Math.max(-80, peak + 6)));
        updateClean(label, { gate: true, thresholdDb: thr });
        setLearnMsg((m) => ({
          ...m,
          [label]: `Buzz peaks at ${Math.round(peak)} dB, gate set to ${thr} dB.` + (peak > -35 ? " That buzz is loud: check the cable, USB port and charger too." : ""),
        }));
      }
    } catch (e) {
      setLearnMsg((m) => ({ ...m, [label]: String((e as Error).message ?? e) }));
    } finally {
      setLearning(null);
    }
  };
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const dev = (label: "Guitar" | "Vocal") => {
    const s = slots.find((x) => x.label === label);
    return s?.id || s?.device || "";
  };
  const guitar = dev("Guitar"), vocal = dev("Vocal");
  const anyOn = (prefs.Guitar.on && !!guitar) || (prefs.Vocal.on && !!vocal);
  // YouTube through the app: the engine plays the page's sound. Automatic in exclusive mode: Windows silences the
  // browser's own output there, so the app plays it instead (no echo, no Windows setting; checked 2026-11-17).
  // "app" = always (needs the Windows setting in shared mode, or the sound doubles).
  const exclusiveNow = anyOn && mode === "exclusive";
  const pageThroughApp = route === "app" || exclusiveNow;
  useEffect(() => {
    engine.pageListen(pageThroughApp, pageGain).catch((e) => setError(String(e.message ?? e)));
  }, [pageThroughApp, pageGain]);
  useEffect(() => () => void engine.pageListen(false).catch(() => {}), []);

  // Start or stop each input's monitor stream.
  useEffect(() => {
    setError("");
    for (const [label, d] of [["Guitar", guitar], ["Vocal", vocal]] as const) {
      const p = prefsRef.current[label];
      engine.monitorSet(label, p.on ? d : "", p.gain).catch((e) => setError(String(e.message ?? e)));
    }
  }, [prefs.Guitar.on, prefs.Vocal.on, guitar, vocal]);
  // The chosen output mode only while monitoring; the normal shared mode otherwise (so YouTube and other apps can play).
  // Exclusive blocks every other sound on that output, YouTube included. Switching it automatically while a video
  // plays was tried (2026-11-17) and failed: each switch restarts the device, YouTube's player stalls and pauses.
  useEffect(() => {
    engine.outputMode(anyOn ? mode : "normal").catch((e) => setError(String(e.message ?? e)));
  }, [anyOn, mode]);
  useEffect(() => {
    if (!anyOn) return setStatus(null);
    const id = window.setInterval(() => engine.monitorStatus().then(setStatus).catch(() => {}), 1000);
    return () => window.clearInterval(id);
  }, [anyOn]);
  // Leaving Session: stop monitoring and go back to the normal output mode.
  useEffect(
    () => () => {
      engine.monitorSet("Guitar", "").catch(() => {});
      engine.monitorSet("Vocal", "").catch(() => {});
      engine.outputMode("normal").catch(() => {});
    },
    [],
  );

  const update = (label: "Guitar" | "Vocal", patch: Partial<{ on: boolean; gain: number }>) => {
    const next = { ...prefs, [label]: { ...prefs[label], ...patch } };
    setPrefs(next);
    writeJson(MON_ON, next);
    if (patch.gain !== undefined) engine.monitorGain(label, patch.gain).catch(() => {});
  };
  const row = (label: "Guitar" | "Vocal", device: string) => {
    const p = prefs[label];
    const s = status?.inputs.find((x) => x.label === label);
    return (
      <div key={label} className="monitor-input">
        <label className="checkbox-line small" title={`Shortcut: ${prettyCombo(loadKeys()[label === "Guitar" ? "hearGuitar" : "hearVocal"])}`}>
          <input type="checkbox" checked={p.on} disabled={!device} onChange={(e) => update(label, { on: e.target.checked })} />
          Hear the {label.toLowerCase()}
          {s && <span className="muted"> · about {Math.round(s.totalMs)} ms late</span>}
        </label>
        {p.on && device && (
          <label className="small monitor-gain">
            Level
            <input type="range" min={0} max={2} step={0.05} value={p.gain} onChange={(e) => update(label, { gain: +e.target.value })} aria-label={`${label} monitor level`} />
            <span className="muted">{Math.round(p.gain * 100)}%</span>
          </label>
        )}
        {device && (
          <div className="small input-cleanup" aria-label={`${label} buzz cleanup`}
            title="Hum filter removes mains hum (60 Hz in the Philippines) and its overtones. The gate turns the input down 40 dB when you are not playing. Both apply to what you hear and to the lined-up take; the raw file stays untouched.">
            <label className="checkbox-line">
              <input type="checkbox" checked={clean[label].hum} onChange={(e) => updateClean(label, { hum: e.target.checked })} />
              Hum filter
            </label>
            {clean[label].hum && (
              <select value={clean[label].humHz} onChange={(e) => updateClean(label, { humHz: +e.target.value === 50 ? 50 : 60 })} aria-label={`${label} mains frequency`}>
                <option value={60}>60 Hz</option>
                <option value={50}>50 Hz</option>
              </select>
            )}
            <label className="checkbox-line">
              <input type="checkbox" checked={clean[label].gate} onChange={(e) => updateClean(label, { gate: e.target.checked })} />
              Gate
            </label>
            {clean[label].gate && (
              <>
                <input type="range" min={-80} max={-20} step={1} value={clean[label].thresholdDb} aria-label={`${label} gate threshold`}
                  onChange={(e) => updateClean(label, { thresholdDb: +e.target.value })} />
                <span className="muted">{clean[label].thresholdDb} dB</span>
              </>
            )}
            {label === "Vocal" && (
              <label className="checkbox-line" title="Low cut, an auto-leveler that lifts your voice when you lean away, gentle compression, de-esser and presence. On what you hear and on the take; the raw file stays untouched.">
                <input type="checkbox" checked={!!clean[label].vocal} onChange={(e) => updateClean(label, { vocal: e.target.checked })} />
                Vocal polish
              </label>
            )}
            {label === "Vocal" && clean[label].vocal && (
              <>
                <span className="muted">Distance lift</span>
                <input type="range" min={0} max={12} step={1} value={clean[label].lift ?? 9} aria-label="Vocal distance lift"
                  onChange={(e) => updateClean(label, { lift: +e.target.value })} />
                <span className="muted">+{clean[label].lift ?? 9} dB</span>
              </>
            )}
            <Button size="sm" variant="quiet" disabled={!p.on || learning !== null} onClick={() => void learnNoise(label)}
              title={p.on ? "Mute the strings, then click: measures the buzz for 2 s and sets the gate just above it" : "Turn on “Hear the " + label.toLowerCase() + "” first"}>
              {learning === label ? "Listening…" : "Learn noise"}
            </Button>
          </div>
        )}
        {learnMsg[label] && <p className="small muted">{learnMsg[label]}</p>}
        {s && s.underruns > 3 && <p className="small warn-text">The {label.toLowerCase()} broke up {s.underruns} times; the delay grew a little to stop it.</p>}
      </div>
    );
  };

  const output = (
    <div className="monitor-controls" aria-label="Live monitoring output">
      <span className="small muted">You hear it in {outputName ? <b>{shortName(outputName)}</b> : "the output"}</span>
      {anyOn && (
        <label className="small monitor-gain" title="How the app uses the output while you monitor. Exclusive: lowest delay, but nothing else can play through that device meanwhile.">
          Output
          <select
            value={mode}
            onChange={(e) => {
              const m = e.target.value as OutputMode;
              setMode(m);
              writeJson(MON_MODE, m);
            }}
            aria-label="Output mode while monitoring"
          >
            <option value="exclusive">Exclusive (lowest delay)</option>
            <option value="low">Shared, low latency</option>
            <option value="normal">Shared (normal)</option>
          </select>
          {status && <span className="muted">{Math.round(status.outputBlockMs ?? 0)} ms blocks</span>}
        </label>
      )}
      {exclusiveNow && (
        <p className="small muted">Exclusive: the app plays YouTube itself (other apps stay silent on {shortName(outputName)}).</p>
      )}
      <label className="small monitor-gain" title="Where the YouTube page's sound plays">
        YouTube
        <select value={route} onChange={(e) => setRoute(e.target.value as "direct" | "app")} aria-label="YouTube sound">
          <option value="direct">Sound: automatic</option>
          <option value="app">Sound: always through the app</option>
        </select>
        <Button size="sm" variant="quiet" onClick={() => setShowHelp(!showHelp)} aria-expanded={showHelp}>
          ?
        </Button>
      </label>
      {pageThroughApp && (
        <label className="small monitor-gain">
          Level
          <input type="range" min={0} max={2} step={0.05} value={pageGain} aria-label="YouTube level"
            onChange={(e) => {
              setPageGain(+e.target.value);
              writeJson(PAGE_GAIN, +e.target.value);
            }} />
          <span className="muted">{Math.round(pageGain * 100)}%{status?.page ? ` · ${Math.round(status.page.totalMs)} ms` : ""}</span>
        </label>
      )}
      {showHelp && (
        <div className="small help-box">
          <b>Automatic</b>: in Exclusive mode the app plays YouTube itself (with this level); in shared modes Windows plays it.
          Nothing to set up. <b>Always through the app</b> also uses the app in shared modes, and needs a one-time Windows
          setting (or you hear it twice):
          <ol>
            <li>Play a YouTube video in the app (so Windows lists it).</li>
            <li>Windows Settings → System → Sound → Volume mixer.</li>
            <li>Under Apps, open <b>Worship Studio</b> (or “Microsoft Edge WebView2”) → Output device: <b>CABLE Input (VB-Audio Virtual Cable)</b>.</li>
          </ol>
          Then YouTube is silent from Windows and the app plays it to {outputName ? shortName(outputName) : "your output"}. If you hear an
          echo, step 3 is not done yet. To undo: set that Output device back to Default and choose “direct” here.
        </div>
      )}
      {error && <Banner tone="error">{error}</Banner>}
    </div>
  );
  /** For the G / V shortcuts: turn hearing an input on or off (only when it has a device). */
  const toggleHear = (label: "Guitar" | "Vocal") => {
    if (label === "Guitar" ? guitar : vocal) update(label, { on: !prefs[label].on });
  };
  return { row: (label: "Guitar" | "Vocal") => row(label, label === "Guitar" ? guitar : vocal), output, anyOn, toggleHear };
}

const shortName = (n: string) => /\(([^)]+)\)\s*$/.exec(n)?.[1] ?? n;
