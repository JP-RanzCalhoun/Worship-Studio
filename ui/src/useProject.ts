// Loads one song project, autosaves song.json, and keeps the audio engine in sync with it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { on } from "./bridge";
import { engine, type LoadedSong } from "./engine";
import { type Analysis, chartOf, defaultMix, mergeChartWithAnalysis, normalizeSong, type SongDoc, type StemInfo } from "./song";
import { beatGrid, clickEvents, expandCues } from "./timeline";

export interface Project {
  id: string;
  dir: string;
  song: SongDoc;
  analysis: Analysis | null;
  loaded: LoadedSong | null;
  peaks: number[];
  error: string | null;
}

declare global {
  interface Window {
    /** Called by the host before the window closes: writes any pending song.json save. */
    __wsaFlush?: () => Promise<void>;
  }
}

export function useProject(id: string | null) {
  const [project, setProjectState] = useState<Project | null>(null);
  // The latest project, readable synchronously. All mutations go through here, so state updaters stay pure.
  const projRef = useRef<Project | null>(null);
  const setProject = useCallback((p: Project | null) => {
    projRef.current = p;
    setProjectState(p);
  }, []);

  // ---- saving: debounced, but always flushed before switching songs, reloading, or closing
  const pending = useRef<{ id: string; song: SongDoc; timer: number } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Engine sync (mixer, tempo, loop, click...) failed: the screen and what you hear may differ.
  // One entry per setting (mixer part, tempo, loop...): a success clears only its own entry.
  const [syncErrors, setSyncErrors] = useState<Record<string, string>>({});
  const syncOk = useCallback(
    (key: string) => setSyncErrors((m) => (key in m ? Object.fromEntries(Object.entries(m).filter(([k]) => k !== key)) : m)),
    [],
  );
  const syncFail = useCallback(
    (key: string, what: string) => (e: any) => setSyncErrors((m) => ({ ...m, [key]: `${what}: ${String(e?.message ?? e)}` })),
    [],
  );
  const synced = useCallback(
    (key: string, what: string, p: Promise<unknown>) => p.then(() => syncOk(key), syncFail(key, what)),
    [syncOk, syncFail],
  );
  const sentMix = useRef<Record<string, string>>({}); // last mixer state sent per part (only changes are sent)
  const flush = useCallback(async () => {
    const p = pending.current;
    if (!p) return;
    window.clearTimeout(p.timer);
    pending.current = null;
    try {
      await engine.saveSong(p.id, p.song);
      setSaveError(null);
    } catch (e: any) {
      // Keep the edit and tell the user. If a newer edit (or another song) took the slot, retry this one separately.
      // (Read the ref fresh: a newer edit may have arrived while this save was in flight.)
      const now = pending.current as { id: string } | null;
      if (!now) pending.current = { ...p, timer: window.setTimeout(flush, 5000) };
      else if (now.id !== p.id) {
        const retry = () => engine.saveSong(p.id, p.song).then(() => setSaveError(null), () => window.setTimeout(retry, 5000));
        window.setTimeout(retry, 5000);
      }
      setSaveError(String(e.message ?? e));
    }
  }, []);
  const persist = useCallback(
    (pid: string, song: SongDoc) => {
      if (pending.current && pending.current.id !== pid) flush();
      if (pending.current) window.clearTimeout(pending.current.timer);
      pending.current = { id: pid, song, timer: window.setTimeout(flush, 400) };
    },
    [flush],
  );
  useEffect(() => {
    window.__wsaFlush = flush;
    return () => {
      flush();
    };
  }, [flush]);

  const [loadError, setLoadError] = useState<string | null>(null);
  const reload = useCallback(
    async (_opts: { mergeNewAnalysis?: boolean } = {}) => {
      if (!id) return setProject(null);
      await flush(); // never load a disk copy older than what is on screen
      if (pending.current?.id === id && projRef.current?.id === id) return; // save failed: keep the newer copy on screen
      try {
        const p = await engine.readProject(id);
        let song = normalizeSong(p.song ?? {});
        const analysis = (p.analysis ?? null) as Analysis | null;
        // The chart was made from an older analysis (re-analyzed while this or another song was open):
        // keep the user's confirmed chords and named sections, take the new estimates everywhere else.
        if (song.chart && analysis?.createdAt && !song.chartFromAnalysis) {
          // Chart saved before this field existed: assume it matches the current analysis (no surprise merge).
          song = { ...song, chartFromAnalysis: analysis.createdAt };
          persist(id, song);
        } else if (song.chart && analysis?.createdAt && song.chartFromAnalysis !== analysis.createdAt) {
          const before = song;
          const chart = mergeChartWithAnalysis(song.chart, analysis);
          // New unconfirmed estimates mean the chart needs review again before it is "ready".
          const stillReady = chart.chords.every((c) => c.confirmed);
          song = { ...song, chart, chartFromAnalysis: analysis.createdAt, preparedAt: stillReady ? song.preparedAt : undefined };
          persist(id, song);
          // One undo step brings the chart from before the merge back. It is marked as made from this analysis,
          // so undoing it lasts (a later reload does not merge again).
          past.current = [...past.current.slice(-79), { ...before, chartFromAnalysis: analysis.createdAt }];
          future.current = [];
          setHistoryTick((t) => t + 1);
        }
        const loaded = await engine.loadSong(id);
        const peaks = await engine.peaks(id, 2400);
        setLoadError(null);
        setProject({ id, dir: p.dir, song, analysis, loaded, peaks, error: null });
      } catch (e: any) {
        // Never leave the previous song on screen (edits would go to the wrong song.json).
        setProject(null);
        setLoadError(String(e.message ?? e));
      }
    },
    [id, flush, persist, setProject],
  );

  useEffect(() => {
    reload();
  }, [reload]);

  // ---- undo / redo. Rapid changes with the same key (a fader drag) merge into one step.
  const past = useRef<SongDoc[]>([]);
  const future = useRef<SongDoc[]>([]);
  const lastKey = useRef<{ key: string; at: number } | null>(null);
  const [historyTick, setHistoryTick] = useState(0);

  /** Update song.json (debounced save). `mergeKey` groups rapid edits into one undo step; null = do not record. */
  const update = useCallback(
    (fn: (s: SongDoc) => SongDoc, mergeKey: string | null = "edit") => {
      const prev = projRef.current;
      if (!prev) return;
      const song = fn(prev.song);
      if (song === prev.song) return;
      if (mergeKey !== null) {
        const now = Date.now();
        const merge = mergeKey !== "edit" && lastKey.current?.key === mergeKey && now - lastKey.current.at < 800;
        if (!merge) {
          past.current = [...past.current.slice(-79), prev.song];
          future.current = [];
          setHistoryTick((t) => t + 1);
        }
        lastKey.current = { key: mergeKey, at: now };
      }
      persist(prev.id, song);
      setProject({ ...prev, song });
    },
    [persist, setProject],
  );

  const undo = useCallback(() => {
    const prev = projRef.current;
    const last = past.current.pop();
    if (!prev || !last) return;
    future.current.push(prev.song);
    lastKey.current = null;
    setHistoryTick((t) => t + 1);
    persist(prev.id, last);
    setProject({ ...prev, song: last });
  }, [persist, setProject]);

  const redo = useCallback(() => {
    const prev = projRef.current;
    const next = future.current.pop();
    if (!prev || !next) return;
    past.current.push(prev.song);
    setHistoryTick((t) => t + 1);
    persist(prev.id, next);
    setProject({ ...prev, song: next });
  }, [persist, setProject]);

  useEffect(() => {
    past.current = [];
    future.current = [];
    setHistoryTick((t) => t + 1);
  }, [id]);

  const song = project?.song;
  const analysis = project?.analysis ?? null;
  const duration = project?.loaded?.duration ?? song?.duration ?? 0;

  const stems: StemInfo[] = useMemo(() => {
    const names = new Map((analysis?.stems ?? []).map((s) => [s.id, s]));
    return (project?.loaded?.tracks ?? []).map((t) => names.get(t.id) ?? { id: t.id, name: t.name, path: "" });
  }, [project?.loaded, analysis]);

  // ---- engine sync: mixer
  // A newly loaded song starts a fresh engine track list: resend everything (runs before the send below).
  useEffect(() => {
    sentMix.current = {};
  }, [project?.loaded]);
  useEffect(() => {
    if (!song) return;
    const ids = new Set(stems.map((s) => s.id));
    for (const k of Object.keys(sentMix.current)) if (!ids.has(k)) delete sentMix.current[k];
    for (const s of stems) {
      const m = song.mixer[s.id] ?? defaultMix(s);
      const key = `${m.gain}|${m.mute}|${m.solo}`;
      if (sentMix.current[s.id] === key) continue;
      sentMix.current[s.id] = key;
      engine
        .setTrack(s.id, m.gain, m.mute, m.solo)
        .then(() => syncOk(`mix:${s.id}`))
        .catch((e) => {
          delete sentMix.current[s.id]; // send it again with the next change
          syncFail(`mix:${s.id}`, `The mixer change for ${s.name} did not reach the audio engine`)(e);
        });
    }
  }, [song?.mixer, stems]);

  // ---- master bus
  useEffect(() => {
    if (song) synced("master", "The master level did not reach the audio engine", engine.setMaster(song.master.gain, song.master.limiter));
  }, [song?.master.gain, song?.master.limiter, project?.loaded]);

  // ---- tempo and pitch
  useEffect(() => {
    if (!song) return;
    const t = window.setTimeout(() => synced("tempo", "The tempo change did not reach the audio engine", engine.setTempo(song.tempoRatio)), 180);
    return () => window.clearTimeout(t);
  }, [song?.tempoRatio, project?.loaded]);
  useEffect(() => {
    if (!song) return;
    const t = window.setTimeout(() => synced("pitch", "The key change did not reach the audio engine", engine.setPitch(song.linkPitchToTranspose ? song.transpose : 0)), 180);
    return () => window.clearTimeout(t);
  }, [song?.transpose, song?.linkPitchToTranspose, project?.loaded]);

  // ---- loop
  useEffect(() => {
    if (!song) return;
    const l = song.loop;
    synced("loop", "The loop did not reach the audio engine", engine.setLoop(!!l?.enabled, l?.a ?? 0, l?.b ?? 0));
  }, [song?.loop, project?.loaded]);

  // ---- click
  const grid = useMemo(() => (song ? beatGrid(analysis, song.click, duration) : []), [analysis, song?.click, duration]);
  useEffect(() => {
    if (!song) return;
    const nudge = (song.click.nudgeMs ?? 0) / 1000;
    synced("click", "The click did not reach the audio engine", engine.setClick(clickEvents(grid, song.click.subdivision).map((e) => ({ ...e, t: e.t + nudge })), song.click.enabled, song.click.gain));
  }, [grid, song?.click.enabled, song?.click.gain, song?.click.subdivision, song?.click.nudgeMs, project?.loaded]);

  // ---- spoken cues: render missing words (cached on disk), then schedule them.
  const cueWords = useMemo(() => (song ? expandCues(song.cues.items, grid, song.click.beatsPerBar) : []), [song?.cues.items, grid, song?.click.beatsPerBar]);
  const [cueStatus, setCueStatus] = useState<string>("");
  const cueMix = useRef({ enabled: true, gain: 0.9 });
  cueMix.current = { enabled: song?.cues.enabled ?? true, gain: song?.cues.gain ?? 0.9 };
  const rendering = useRef(false);
  const [renderAgain, setRenderAgain] = useState(0);

  useEffect(() => {
    if (!song || !project) return;
    const texts = [...new Set(cueWords.map((w) => w.text))];
    const files = song.cues.files ?? {};
    const leadsKnown = song.cues.leads ?? {};
    // Words without a measured lead come from an older renderer: make them again (level-matched).
    const missing = texts.filter((t) => !files[t] || leadsKnown[t] === undefined);
    let cancelled = false;
    const leads = song.cues.leads ?? {};
    const nudge = (song.click.nudgeMs ?? 0) / 1000;
    // Each word starts early by its measured lead, so the vowel (what you hear) lands on the beat.
    const schedule = (f: Record<string, string>, l: Record<string, number> = leads) =>
      engine.setCues(
        cueWords.filter((w) => f[w.text]).map((w) => ({ t: w.t + nudge - (l[w.text] ?? 0), file: f[w.text] })),
        cueMix.current.enabled,
        cueMix.current.gain,
      );
    if (missing.length === 0) {
      schedule(files)
        .then((r) => {
          // Cue files that no longer exist (e.g. library moved): forget them so they are made again.
          const gone = new Set(r?.missing ?? []);
          if (gone.size)
            update((s) => {
              const keep = Object.fromEntries(Object.entries(s.cues.files ?? {}).filter(([, f]) => !gone.has(f)));
              return { ...s, cues: { ...s.cues, files: keep } };
            }, null);
          if (gone.size) setRenderAgain((n) => n + 1); // make the missing words again now, not on next open
        })
        .catch(() => {});
      return;
    }
    // One voice render at a time; if words change meanwhile, run again afterwards.
    if (rendering.current) return;
    setCueStatus(`Making ${missing.length} spoken cue word(s) with the Windows voice…`);
    const t = window.setTimeout(async () => {
      rendering.current = true;
      try {
        const r = await engine.renderCues(project.id, missing);
        const latest = projRef.current;
        if (!latest || latest.id !== project.id) return;
        const merged = { ...(latest.song.cues.files ?? {}), ...r.files };
        const mergedLeads = { ...(latest.song.cues.leads ?? {}), ...(r.leads ?? {}) };
        update((s) => ({ ...s, cues: { ...s.cues, files: merged, leads: mergedLeads } }), null);
        if (!cancelled) await schedule(merged, mergedLeads);
        setCueStatus("");
      } catch (e: any) {
        setCueStatus("Spoken cues failed: " + (e.message ?? e));
      } finally {
        rendering.current = false;
        setRenderAgain((n) => n + 1);
      }
    }, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [cueWords, project?.loaded, renderAgain, song?.click.nudgeMs]);

  // Volume / on-off only: no reload of the cue sounds.
  useEffect(() => {
    if (song) engine.setCueMix(song.cues.enabled, song.cues.gain).catch(() => {});
  }, [song?.cues.enabled, song?.cues.gain]);

  const chart = useMemo(() => (song ? chartOf(song, analysis) : { chords: [], sections: [] }), [song, analysis]);

  const history = { canUndo: past.current.length > 0, canRedo: future.current.length > 0, tick: historyTick };
  return { project, song, analysis, stems, duration, grid, chart, update, undo, redo, history, reload, cueStatus, loadError, saveError, syncError: Object.values(syncErrors)[0] ?? null };
}

/** Transport position, pushed by the host at 30 Hz. */
export function useTransport() {
  const [state, setState] = useState({ pos: 0, playing: false });
  useEffect(() => on("transport", (t) => setState(t)), []);
  return state;
}

export function useMeters() {
  const [m, setM] = useState<Record<string, number>>({});
  useEffect(() => on("meters", (x) => setM(x)), []);
  return m;
}
