// Analysis jobs live at app level, keyed by song, so leaving the Stems page never loses a running job.

import { useCallback, useEffect, useRef, useState } from "react";
import { on } from "./bridge";
import { engine } from "./engine";

export interface JobState {
  songId: string;
  jobId: number | null;
  pct: number;
  message: string;
  error?: string;
  cancelled?: boolean;
  running: boolean;
}

export function useAnalysisJobs(onFinished: (songId: string) => void) {
  const [jobs, setJobs] = useState<Record<string, JobState>>({});
  const byJob = useRef<Record<number, string>>({});
  const cancelAsked = useRef<Set<string>>(new Set()); // Cancel pressed before the job id arrived
  // Events for a job id the UI does not know yet: a fast job can finish before analyze() returns its id.
  const early = useRef<Map<number, any[]>>(new Map());
  const finished = useRef(onFinished);
  finished.current = onFinished;

  const patch = (songId: string, p: Partial<JobState>) =>
    setJobs((j) => ({ ...j, [songId]: { ...(j[songId] ?? { songId, jobId: null, pct: 0, message: "", running: false }), ...p } }));

  const handle = useCallback((jobId: number, msg: any) => {
    const songId = byJob.current[jobId];
    if (!songId) return;
    if (msg.type === "progress") patch(songId, { pct: msg.pct, message: msg.message });
    if (msg.type === "error") patch(songId, { error: msg.message, running: false }); // an error without an exit must not stay "Analyzing"
    if (msg.type === "exit") {
      delete byJob.current[jobId];
      const ok = msg.code === 0 && !msg.cancelled && !msg.timedOut;
      patch(songId, {
        running: false,
        jobId: null,
        cancelled: !!msg.cancelled,
        pct: ok ? 100 : 0,
        message: ok ? "Done" : "",
        ...(msg.timedOut ? { error: "The analysis tools stopped responding for 20 minutes and were stopped. Try again, or use the Fast preset." } : {}),
      });
      if (!ok && !msg.cancelled && !msg.timedOut)
        setJobs((j) => (j[songId]?.error ? j : { ...j, [songId]: { ...j[songId], error: `The analysis stopped without a result (exit code ${msg.code}).` } }));
      if (ok) finished.current(songId);
    }
  }, []);

  useEffect(
    () =>
      on("job", ({ jobId, msg }) => {
        if (!byJob.current[jobId]) {
          // Not known (yet): keep it briefly in case analyze() has not returned this job's id.
          const list = early.current.get(jobId) ?? [];
          if (list.length < 200) list.push(msg);
          early.current.set(jobId, list);
          window.setTimeout(() => early.current.delete(jobId), 60_000);
          return;
        }
        handle(jobId, msg);
      }),
    [handle],
  );

  const start = useCallback(async (songId: string, quality: string, device: string) => {
    patch(songId, { running: true, pct: 0, message: "Starting the analysis tools…", error: undefined, cancelled: false });
    try {
      cancelAsked.current.delete(songId);
      const r = await engine.analyze(songId, quality, device);
      byJob.current[r.jobId] = songId;
      patch(songId, { jobId: r.jobId });
      for (const m of early.current.get(r.jobId) ?? []) handle(r.jobId, m); // events that arrived before the id
      early.current.delete(r.jobId);
      if (cancelAsked.current.delete(songId)) engine.cancelJob(r.jobId);
    } catch (e: any) {
      patch(songId, { running: false, error: String(e.message ?? e) });
    }
  }, [handle]);

  const cancel = useCallback((songId: string) => {
    const j = Object.entries(byJob.current).find(([, s]) => s === songId);
    if (j) engine.cancelJob(+j[0]);
    else cancelAsked.current.add(songId); // the job is still starting: cancel it as soon as it has an id
  }, []);

  return { jobs, start, cancel };
}
