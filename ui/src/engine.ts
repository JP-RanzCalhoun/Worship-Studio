// Typed wrappers around the native functions registered in app/src/MainComponent.cpp.

import { call } from "./bridge";

export interface LibrarySong {
  id: string;
  title: string;
  artist: string;
  key?: string;
  analyzed: boolean;
  modified: number;
  /** the video the song was learned from */
  referenceUrl?: string;
}

export interface LoadedSong {
  tracks: { id: string; name: string }[];
  duration: number;
  sampleRate: number;
}

export interface Devices {
  type: string;
  inputs: { name: string; virtual: boolean }[];
  outputs: string[];
  input: string;
  output: string;
  sampleRate?: number;
  bufferSize?: number;
  bitDepth?: number;
  outputLatencyMs?: number;
  inputLatencyMs?: number;
}

export interface SidecarInfo {
  python: string;
  torch: string | null;
  cuda: boolean;
  gpu: string | null;
  vram_gb: number | null;
  presets: Record<string, { label: string; note: string; stems: string[] }>;
}

/** An audio input for recording; `warning` marks virtual, webcam or wireless devices. */
export interface RecInput {
  name: string;
  /** Windows endpoint ID: what takes and monitors open (unique even for two identical mics) */
  id?: string;
  warning?: string;
}

/** One recording pass (take.json). Files are lined up with the song: sample 0 = song time `startSec`. */
export interface Take {
  id: string;
  startSec: number;
  recordedAt: string;
  tracks?: { label: string; device: string; file: string; seconds: number; glitches: number; gapMs: number; ppm: number; error?: string }[];
  warning?: string;
  error?: string;
  /** the camera picture was recorded too (video.mp4 or video.webm in the take folder) */
  hasVideo?: boolean;
}

/** State of the main video in the built-in browser. */
export interface SiteVideo {
  has: boolean;
  t?: number;
  d?: number;
  paused?: boolean;
  ended?: boolean;
  muted?: boolean;
  ad: boolean;
  /** YouTube video id of the page (or its address) */
  vid?: string;
  url: string;
  title: string;
}

export const engine = {
  listSongs: () => call<LibrarySong[]>("listSongs"),
  importSong: () => call<{ id?: string; cancelled?: boolean; error?: string }>("importSong"),
  readProject: (id: string) => call<{ id: string; dir: string; song: any; analysis: any }>("readProject", id),
  saveSong: (id: string, song: unknown) => call("saveSong", id, JSON.stringify(song, null, 2)),
  deleteSong: (id: string) => call("deleteSong", id),
  loadSong: (id: string) => call<LoadedSong>("loadSong", id),
  peaks: (id: string, bins: number) => call<number[]>("peaks", id, bins),

  play: (from?: number, preRoll = 0) => (from === undefined ? call("play") : call("play", from, preRoll)),
  pause: () => call("pause"),
  seek: (sec: number) => call("seek", sec),
  setLoop: (on: boolean, a: number, b: number) => call("setLoop", on, a, b),
  setTempo: (ratio: number) => call("setTempo", ratio),
  setPitch: (semis: number) => call("setPitch", semis),
  setTrack: (id: string, gain: number, mute: boolean, solo: boolean) => call("setTrack", id, gain, mute, solo),
  setMasterMute: (m: boolean) => call("setMasterMute", m),
  setMaster: (gain: number, limiter: boolean) => call("setMaster", gain, limiter),
  setClick: (events: { t: number; k: number }[], enabled: boolean, gain: number) => call("setClick", events, enabled, gain),
  setCues: (events: { t: number; file: string }[], enabled: boolean, gain: number) => call<{ missing?: string[] }>("setCues", events, enabled, gain),
  setCueMix: (enabled: boolean, gain: number) => call("setCueMix", enabled, gain),

  siteShow: (x: number, y: number, w: number, h: number, visible: boolean) => call("siteShow", x, y, w, h, visible),
  siteGo: (text: string) => call("siteGo", text),
  siteBack: () => call("siteBack"),
  siteForward: () => call("siteForward"),
  siteReload: () => call("siteReload"),
  /** YouTube watch pages: only the player, letterboxed */
  siteVideoOnly: (on: boolean) => call("siteVideoOnly", on),
  captureStart: () => call("captureStart"),
  captureStop: () => call<{ seconds: number; title: string; url: string }>("captureStop"),
  /** offset = video time minus song time, so the muted video can follow the player */
  captureSave: (name: string, url: string, offset?: number) =>
    call<{ id?: string }>("captureSave", name, url, ...(offset === undefined ? [] : [offset])),
  captureDiscard: () => call("captureDiscard"),
  captureStatus: () => call<{ recording: boolean; seconds: number; pending: boolean; title: string; url: string }>("captureStatus"),

  devices: () => call<Devices>("devices"),
  setDevices: (output: string, input: string) => call("setDevices", output, input),
  tuner: (on: boolean) => call("tuner", on),

  sidecarInfo: () => call<SidecarInfo & { error?: string }>("sidecarInfo"),
  analyze: (id: string, quality: string, device: string, noStems = false) =>
    call<{ jobId: number }>("analyze", id, quality, device, noStems),
  cancelJob: (jobId: number) => call("cancelJob", jobId),
  renderCues: (id: string, texts: string[]) => call<{ files: Record<string, string>; leads: Record<string, number> }>("renderCues", id, texts),

  exportMix: (id: string, opts: unknown) => call<{ path?: string; warning?: string; error?: string; cancelled?: boolean }>("exportMix", id, opts),
  reveal: (path: string) => call("reveal", path),
  libraryRoot: () => call<string>("libraryRoot"),
  // Session: song video control, camera video of a take, projector window
  siteVideo: (action: "state" | "prepare" | "play" | "pause" | "sync" | "nudge", arg?: { t: number; playing: boolean; rate: number; id?: string }) =>
    call<SiteVideo>("siteVideo", action, arg ?? {}),
  videoStart: (mime: string, pageStartEpochMs: number) => call("videoStart", mime, pageStartEpochMs),
  videoChunk: (base64: string) => call("videoChunk", base64),
  videoMark: (recorderStartEpochMs: number) => call("videoMark", recorderStartEpochMs),
  videoStop: () => call<{ file: string; bytes: number }>("videoStop"),
  displays: () => call<{ index: number; label: string; thisWindow: boolean }[]>("displays"),
  projectorOpen: (view: "chords" | "camera", display: number, songId = "") => call("projectorOpen", view, display, songId),
  projectorClose: () => call("projectorClose"),
  /** web search for the song's chord sheet in a separate window */
  chartSearch: (query: string) => call("chartSearch", query),
  /** Windows display scaling of the app window (1.25 = 125%); used with devicePixelRatio to get the page zoom. */
  displayScale: () => call<number>("displayScale"),

  // recording (M2b): dry takes per input, lined up with the song
  recInputs: () => call<RecInput[]>("recInputs"),
  recMonitor: (tracks: { label: string; device: string }[]) => call("recMonitor", tracks),
  recStart: (songId: string, tracks: { label: string; device: string }[], takeStartSec: number) => call("recStart", songId, tracks, takeStartSec),
  recStop: () => call<Take>("recStop"),
  recCancel: () => call("recCancel"),
  recStatus: () => call<{ recording: boolean; seconds: number }>("recStatus"),
  recTakes: (songId: string) => call<Take[]>("recTakes", songId),
  revealTake: (songId: string, takeId: string) => call("revealTake", songId, takeId),
  /** solo takes left by a killed app become songs (returns the recovered takes with songId + title) */
  soloRecover: () => call<{ songId: string; title: string; warning?: string }[]>("soloRecover"),

  // live monitoring: inputs (by label) played through the output device (device "" = off)
  monitorSet: (label: string, device: string, gain = 1) => call("monitorSet", label, device, gain),
  monitorGain: (label: string, gain: number) => call("monitorGain", label, gain),
  /** Hum filter / noise gate for one input: live on its monitor and on its next takes (raw files stay dry). */
  inputCleanup: (label: string, s: InputCleanupSettings) => call("inputCleanup", label, s),
  /** Loudest level of that input's monitor stream since the last call, in dB (resets). */
  inputCleanupPeak: (label: string) => call<number>("inputCleanupPeak", label),
  /** normal = Windows shared (10 ms); low = shared, smallest period; exclusive = the app owns the output (lowest delay) */
  outputMode: (mode: OutputMode) => call("outputMode", mode),
  /** YouTube through the app: play the built-in browser's sound in the engine (heard even in exclusive mode) */
  pageListen: (on: boolean, gain = 1) => call("pageListen", on, gain),
  /** ambient pad made in code: key 0-11 (C = 0), level 0-1 */
  padSet: (p: { on?: boolean; key?: number; level?: number; flavor?: PadFlavor }) => call("padSet", p),
  monitorStatus: () => call<MonitorStatus>("monitorStatus"),
};

export type OutputMode = "normal" | "low" | "exclusive";
/** Per-input buzz cleanup: hum notches at humHz and its harmonics, and a noise gate that opens above thresholdDb. */
export interface InputCleanupSettings {
  hum: boolean;
  humHz: 50 | 60;
  gate: boolean;
  thresholdDb: number;
}

export interface MonitorStatus {
  outputMode: OutputMode;
  outputMs: number;
  outputBlockMs?: number;
  /** the YouTube page played through the app (pageListen on) */
  page?: { totalMs: number; peak: number };
  inputs: {
    label: string;
    device: string;
    inputMs: number;
    bufferMs: number;
    totalMs: number;
    lowLatencyInput: boolean;
    underruns: number;
    overflows: number;
    peak: number;
  }[];
}


/** Ambient pad sounds (made in code; styles of worship records, not their samples) */
export type PadFlavor = "warm" | "shimmer" | "analog" | "organ";
