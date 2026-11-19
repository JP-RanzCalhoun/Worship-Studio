import { useCallback, useEffect, useRef, useState } from "react";
import { engine } from "../engine";

export type GetSongStage = "idle" | "waitingAd" | "recording" | "saving" | "error" | "pending";

export interface GetSongState {
  stage: GetSongStage;
  seconds: number;
  duration: number;
  title: string;
  message: string;
  /** an ad appeared during the recording (it is in the recording too) */
  adDuring: boolean;
}

const IDLE: GetSongState = { stage: "idle", seconds: 0, duration: 0, title: "", message: "", adDuring: false };

/**
 * YouTube page titles end in " - YouTube"; song names do not. YouTube also wraps @handles in invisible
 * direction marks (U+202A … U+202C), which would end up in the song title and its file name.
 */
export const cleanTitle = (t: string) =>
  t
    .replace(/[​-‏‪-‮⁠-⁩﻿]/g, "")
    .replace(/\s*-\s*YouTube\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim() || "Song from video";
/** The plain watch link of a video (no playlist or radio parameters, which make YouTube jump to the next song). */
const plainUrl = (url: string) => {
  const id = /[?&]v=([\w-]+)/.exec(url)?.[1];
  return id ? `https://www.youtube.com/watch?v=${id}` : url;
};
const vidOf = (url: string) => /[?&]v=([\w-]+)/.exec(url)?.[1] ?? url;

/**
 * "Get this song": records the sound of the video in the built-in browser from its start to its end (real time),
 * then saves it as a song; the caller then starts the analysis (stems, chords, sections, cues).
 * Also measures the offset between the video and the recording, so the muted video can follow the player later.
 *
 * Used at app level (not inside the Session screen), so leaving Session never leaves a recording unsupervised.
 * After an app restart, a running recording is picked up again and an unsaved one is offered.
 */
export interface SavedInfo {
  /** seconds the video stood still (buffering) while the recording ran on: silence in the recording */
  stalledSeconds: number;
}

/** How long the video stood still while recording: early offsets minus late offsets (each a median of 5 readings). */
export function stallSeconds(offsets: number[]): number {
  if (offsets.length < 10) return 0;
  const med = (a: number[]) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  return Math.max(0, med(offsets.slice(0, 5)) - med(offsets.slice(-5)));
}

/**
 * @param keepPlaying asked when learning ends: true when the next video should keep playing (it will be learned
 *   too). Otherwise a video YouTube autoplays after the song is paused, so nothing plays out loud unasked.
 */
export function useGetSong(onSaved: (songId: string, info: SavedInfo) => void, keepPlaying: () => boolean = () => false) {
  const [state, setState] = useState<GetSongState>(IDLE);
  const keepRef = useRef(keepPlaying);
  keepRef.current = keepPlaying;
  const timer = useRef(0);
  const offsets = useRef<number[]>([]); // video time minus recording time, measured while it plays
  const info = useRef({ url: "", title: "", vid: "" });
  const lastT = useRef(0);
  const fullD = useRef(0); // the song's own length (largest duration seen outside ads)
  const backCount = useRef(0);
  const stuckSince = useRef(0); // when the video time last stopped moving while it should play
  const lastNudge = useRef(0);
  const finishing = useRef(false);
  const aborted = useRef(false);
  const savedRef = useRef(onSaved);
  savedRef.current = onSaved;

  const stopTimer = () => window.clearInterval(timer.current);

  /** YouTube autoplays the next video a few seconds after the end (also after our pause): stop it, for 20 s. */
  const quietAfter = useCallback((learnedVid: string) => {
    const until = Date.now() + 20000;
    const id = window.setInterval(async () => {
      if (Date.now() > until || keepRef.current()) return window.clearInterval(id);
      const v = await engine.siteVideo("state").catch(() => null);
      if (v?.has && !v.paused && v.vid && v.vid !== learnedVid) {
        await engine.siteVideo("pause").catch(() => {});
        window.clearInterval(id);
      }
    }, 500);
  }, []);

  const finish = useCallback(async () => {
    if (finishing.current) return; // a poll still in flight must not save twice
    finishing.current = true;
    stopTimer();
    setState((s) => ({ ...s, stage: "saving", message: "Saving the recording…" }));
    try {
      const r = await engine.captureStop();
      await engine.siteVideo("pause").catch(() => {});
      quietAfter(info.current.vid);
      if (r.seconds < 5) {
        await engine.captureDiscard();
        setState({ ...IDLE, stage: "error", message: "The recording was shorter than 5 seconds, so it was discarded." });
        return;
      }
      const o = offsets.current.slice().sort((a, b) => a - b);
      const offset = o.length ? o[Math.floor(o.length / 2)] : undefined; // median: robust against one slow reading
      const saved = await engine.captureSave(info.current.title, info.current.url, offset);
      if (!saved.id) throw new Error("The song could not be saved.");
      setState(IDLE);
      savedRef.current(saved.id, { stalledSeconds: stallSeconds(offsets.current) });
    } catch (e: any) {
      const c = await engine.captureStatus().catch(() => null);
      setState((s) => ({ ...s, stage: c?.pending ? "pending" : "error", message: String(e.message ?? e) }));
    } finally {
      finishing.current = false;
    }
  }, [quietAfter]);

  /** Watches the video while it records; finishes at its end, or when YouTube moves on to another video. */
  const poll = useCallback(() => {
    stopTimer();
    timer.current = window.setInterval(async () => {
      try {
        const [s, c] = await Promise.all([engine.siteVideo("state"), engine.captureStatus()]);
        if (!c.recording) return finish(); // stopped by itself (e.g. disk full): save what is there
        const t = s.t ?? 0;
        const otherVideo = !!info.current.vid && !!s.vid && s.vid !== info.current.vid;
        const jumpedBack = t < lastT.current - 2 && !s.ad; // autoplay started the next song from 0
        // Skipped ahead: the recording would miss part of the song.
        if (!s.ad && !otherVideo && t > lastT.current + 3 && lastT.current > 0) {
          lastT.current = t;
          stopTimer();
          await engine.captureDiscard().catch(() => {});
          setState({ ...IDLE, stage: "error", message: "You skipped ahead, so learning this song stopped. Play it from the start to learn it." });
          return;
        }
        // Freeze watchdog: the video should play but its time stands still (YouTube stuck loading). Nudge it every 4 s.
        const now = Date.now();
        if (s.has && !s.ad && !s.paused && !otherVideo && t <= lastT.current + 0.05) {
          if (!stuckSince.current) stuckSince.current = now;
          else if (now - stuckSince.current > 4000 && now - lastNudge.current > 4000) {
            lastNudge.current = now;
            engine.siteVideo("nudge").catch(() => {});
          }
        } else stuckSince.current = 0;
        lastT.current = Math.max(lastT.current, t);
        if (s.has && !s.ad && !s.paused && t > 0.5 && !otherVideo) offsets.current.push(t - c.seconds);
        if (!s.ad && !otherVideo && s.d) fullD.current = Math.max(fullD.current, s.d);
        setState((x) => ({ ...x, seconds: c.seconds, duration: s.d || x.duration, adDuring: x.adDuring || s.ad }));
        // While YouTube buffers or slips in an ad, the player can briefly report a short duration or an "ended" that is
        // not the song's end (2026-11-17: a 203 s song stopped at 31 s). Only an end near the song's own length counts,
        // and a jump back must last 1.5 s.
        const endish = s.ended || (!!s.d && t >= s.d - 0.15);
        const atSongEnd = endish && (!fullD.current || t >= fullD.current - 3);
        backCount.current = jumpedBack ? backCount.current + 1 : 0;
        if (backCount.current >= 3 && fullD.current && lastT.current < fullD.current - 3) {
          // Back to the start in the middle of the song (YouTube reloaded the player, or a click): not the end.
          stopTimer();
          await engine.captureDiscard().catch(() => {});
          await engine.siteVideo("pause").catch(() => {});
          setState({ ...IDLE, stage: "error", message: "The video jumped back in the middle of the song, so learning it stopped. Press Learn this song to try again." });
          return;
        }
        if (otherVideo || atSongEnd || backCount.current >= 3) finish();
      } catch {
        /* one missed reading is fine */
      }
    }, 500);
  }, [finish]);

  // After a restart: a recording that still runs is supervised again; an unsaved one is offered.
  useEffect(() => {
    engine
      .captureStatus()
      .then((c) => {
        info.current = { url: plainUrl(c.url), title: cleanTitle(c.title), vid: vidOf(c.url) };
        if (c.recording) {
          setState({ ...IDLE, stage: "recording", seconds: c.seconds, title: info.current.title });
          poll();
        } else if (c.pending && c.seconds >= 5)
          setState({ ...IDLE, stage: "pending", seconds: c.seconds, title: info.current.title, message: "A recording from a video was not saved yet." });
      })
      .catch(() => {});
    return stopTimer;
  }, [poll]);

  const start = useCallback(async () => {
    offsets.current = [];
    lastT.current = 0;
    fullD.current = 0;
    backCount.current = 0;
    stuckSince.current = 0;
    lastNudge.current = 0;
    aborted.current = false;
    let started = false;
    try {
      let v = await engine.siteVideo("state");
      if (!v.has) throw new Error("Open a video first (search, or paste its link above).");
      info.current = { url: plainUrl(v.url), title: cleanTitle(v.title), vid: v.vid ?? vidOf(v.url) };
      // A pre-roll ad plays in the same player: wait until it is gone, then start the song from 0:00.
      if (v.ad) {
        setState({ ...IDLE, stage: "waitingAd", title: info.current.title, message: "Waiting for the ad to finish…" });
        await engine.siteVideo("play");
        for (let i = 0; i < 240 && v.ad; i++) {
          await new Promise((r) => setTimeout(r, 500));
          if (aborted.current) return;
          v = await engine.siteVideo("state");
        }
        if (v.ad) throw new Error("The ad did not finish. Skip it in the video, then press Learn this song again.");
      }
      await engine.siteVideo("prepare");
      await engine.captureStart(); // also sets the video to full volume for a clean recording
      started = true;
      await engine.siteVideo("play");
      setState({ ...IDLE, stage: "recording", title: info.current.title, duration: v.d ?? 0 });
      poll();
    } catch (e: any) {
      stopTimer();
      if (started) await engine.captureDiscard().catch(() => {}); // never delete a recording this call did not start
      setState({ ...IDLE, stage: "error", message: String(e.message ?? e) });
    }
  }, [poll]);

  const savePending = useCallback(async () => {
    setState((s) => ({ ...s, stage: "saving", message: "Saving the recording…" }));
    try {
      const saved = await engine.captureSave(info.current.title, info.current.url);
      if (!saved.id) throw new Error("The song could not be saved.");
      setState(IDLE);
      savedRef.current(saved.id, { stalledSeconds: 0 }); // recovered after a restart: no readings to judge
    } catch (e: any) {
      setState((s) => ({ ...s, stage: "pending", message: String(e.message ?? e) }));
    }
  }, []);

  const stopNow = useCallback(() => finish(), [finish]);
  const cancel = useCallback(async () => {
    aborted.current = true;
    stopTimer();
    await engine.captureDiscard().catch(() => {});
    await engine.siteVideo("pause").catch(() => {});
    setState(IDLE);
  }, []);
  const dismiss = useCallback(() => setState(IDLE), []);

  return { state, start, stopNow, cancel, dismiss, savePending };
}
