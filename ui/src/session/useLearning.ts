import { useCallback, useEffect, useRef, useState } from "react";
import { engine, type LibrarySong } from "../engine";
import type { useGetSong } from "./useGetSong";

const AUTO_STORE = "wsa.learnAuto";
const QUEUE_STORE = "wsa.learnQueue";

const vidOf = (url: string) => /[?&]v=([\w-]+)/.exec(url)?.[1] ?? "";
const read = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
};
const write = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage blocked: the setting is just not remembered */
  }
};

/**
 * Learning songs from YouTube without a button:
 * - learn-while-playing: when a video that is not a song yet starts playing from its beginning in Session,
 *   it is recorded in the background ("Learning…") and becomes a song (stems, chords, sections, cues) at its end;
 * - prepare-ahead queue: links learned one after another (each still plays once, in real time).
 * Uses "Get this song" underneath, so the same rules apply (pre-roll ads, stop at the end, skipping cancels).
 */
export function useLearning(getSong: ReturnType<typeof useGetSong>, songs: LibrarySong[], active: boolean) {
  // Off by default (audit UX-02): learning plays the video at full volume, which must never start by surprise.
  const [auto, setAutoState] = useState<boolean>(() => read(AUTO_STORE, false));
  const [queue, setQueueState] = useState<string[]>(() => read(QUEUE_STORE, []));
  const [queueRunning, setQueueRunning] = useState(false);
  const tried = useRef(new Set<string>()); // videos already learned or declined this session (no loops)
  const stage = getSong.state.stage;
  // The app re-renders many times a second (transport): keep the effects stable and read start() from a ref.
  const startRef = useRef(getSong.start);
  startRef.current = getSong.start;

  const setAuto = (v: boolean) => {
    setAutoState(v);
    write(AUTO_STORE, v);
  };
  const setQueue = useCallback((q: string[]) => {
    setQueueState(q);
    write(QUEUE_STORE, q);
  }, []);

  const known = useCallback(
    (vid: string) => !!vid && (tried.current.has(vid) || songs.some((s) => s.referenceUrl && vidOf(s.referenceUrl) === vid)),
    [songs],
  );

  // Learn-while-playing: watch the video while Session is open and nothing else is being learned.
  useEffect(() => {
    if (!active || !auto || queueRunning || stage !== "idle") return;
    let busy = false;
    const id = window.setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const v = await engine.siteVideo("state");
        const vid = v.vid ?? "";
        if (v.has && !v.ad && !v.paused && (v.t ?? 99) < 3 && /youtube\.com\/watch/.test(v.url) && !known(vid)) {
          tried.current.add(vid);
          await startRef.current(); // restarts the video from 0:00 and records it
        }
      } catch {
        /* the video page is not ready */
      } finally {
        busy = false;
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [active, auto, queueRunning, stage, known]);

  // Prepare-ahead queue: open the next link, wait until its video is there, learn it, repeat.
  const running = useRef(false);
  useEffect(() => {
    if (!queueRunning || stage !== "idle" || running.current) return;
    if (!queue.length) {
      setQueueRunning(false);
      return;
    }
    running.current = true;
    const [next, ...rest] = queue;
    (async () => {
      try {
        const vid = vidOf(next);
        if (vid && known(vid)) return; // already a song
        await engine.siteGo(next);
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 500));
          const v = await engine.siteVideo("state").catch(() => null);
          if (v?.has && (!vid || v.vid === vid)) break;
        }
        if (vid) tried.current.add(vid);
        await startRef.current();
      } finally {
        setQueue(rest);
        running.current = false;
      }
    })();
  }, [queueRunning, stage, queue, known, setQueue]);

  const addToQueue = (text: string) => {
    const links = text
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => /^https?:\/\/(www\.)?(youtube\.com\/watch|youtu\.be\/)/i.test(s));
    const plain = links.map((l) => {
      const id = /[?&]v=([\w-]+)/.exec(l)?.[1] ?? /youtu\.be\/([\w-]+)/.exec(l)?.[1];
      return id ? `https://www.youtube.com/watch?v=${id}` : l;
    });
    setQueue([...queue, ...plain.filter((l) => !queue.includes(l))]);
    return plain.length;
  };

  return { auto, setAuto, queue, setQueue, addToQueue, queueRunning, startQueue: () => setQueueRunning(true), stopQueue: () => setQueueRunning(false) };
}
