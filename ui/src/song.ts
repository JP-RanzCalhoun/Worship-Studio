// Song project data model. song.json is owned by the UI; analysis.json is machine output (read-only here).
import { keyName, parseKey } from "./theory/notes";
import { simplify } from "./theory/chordInfo";

export interface ChordSeg {
  start: number;
  end: number;
  chord: string;
  confidence?: number;
  /** true once the user typed or confirmed it */
  confirmed?: boolean;
  /** added or split by the user (kept on re-analysis even before it is confirmed) */
  user?: boolean;
}

export interface Section {
  start: number;
  end: number;
  label: string;
  group?: string;
  confidence?: number;
  suggested?: boolean;
}

export interface StemInfo {
  id: string;
  name: string;
  path: string;
  level_db?: number;
  silent?: boolean;
  /** quiet part (30–45 dB under the mix): kept, but muted until the user turns it on */
  quiet?: boolean;
  group?: string;
  experimental?: boolean;
  hint?: string;
  energy_share?: number;
  brightness_hz?: number;
}

export interface Analysis {
  version: number;
  duration: number;
  device: string;
  key: { tonic: string; mode: "major" | "minor"; name: string; confidence: number; alternative: string };
  rhythm: {
    method: string;
    beats: number[];
    downbeats: number[];
    bpm: number | null;
    bpm_confidence: number;
    time_signature: string | null;
    downbeats_estimated?: boolean;
    note?: string;
    half_time?: { likely: boolean; fast_bpm: number; slow_bpm: number };
    onset_shift_ms?: number;
  };
  chords: ChordSeg[];
  sections: Section[];
  stems?: StemInfo[];
  separation?: { preset: string; model: string; license: string; residual_db: number };
  guitarSplit?: { method: string; note: string };
  warnings: string[];
  silentStems?: string[];
  quietStems?: string[];
  chordSource?: string;
  elapsed_s?: number;
  createdAt?: string;
}

export interface CueItem {
  id: string;
  /** song time of the section start the cue announces */
  t: number;
  text: string;
  /** also speak "1 2 3 4" on the beats of the bar before t */
  count: boolean;
}

export interface ClickSettings {
  enabled: boolean;
  gain: number;
  source: "beats" | "fixed";
  bpm: number;
  offset: number;
  beatsPerBar: number;
  subdivision: 1 | 2 | 3 | 4;
  countInBars: number;
  /** multiply detected beats: 0.5 = half time, 2 = double time */
  beatScale: 0.5 | 1 | 2;
  /** shifts click and cues; negative = earlier (ms) */
  nudgeMs: number;
  /** remembered count-in length when the transport toggle turns it off and on */
  lastCountInBars?: number;
}

export interface MixState {
  gain: number;
  mute: boolean;
  solo: boolean;
}

export interface SongDoc {
  version: number;
  title: string;
  artist: string;
  source: string;
  sampleRate: number;
  sourceBits?: number;
  duration: number;
  key?: string; // user override of the detected key
  capo: number;
  tuning: string; // tuning name, or "custom:D A D G B E"
  transpose: number; // semitones, applies to chart and (when linked) playback pitch
  linkPitchToTranspose: boolean;
  tempoRatio: number;
  chart?: { chords: ChordSeg[]; sections: Section[] };
  mixer: Record<string, MixState>;
  /** master bus for playback and export */
  master: { gain: number; limiter: boolean };
  click: ClickSettings;
  cues: { enabled: boolean; gain: number; items: CueItem[]; files?: Record<string, string>; leads?: Record<string, number> };
  loop?: { a: number; b: number; enabled: boolean };
  nashvilleMinor: "relative-major" | "minor-tonic";
  simpleChords: boolean;
  /** set when the user marks the song ready to rehearse */
  preparedAt?: string;
  /** web page the song was recorded from (built-in browser capture) */
  referenceUrl?: string;
  /** lyric lines with the song time they start at (from an imported chart) */
  lyrics?: { t: number; text: string; section: string }[];
  /** CCLI song number and copyright line (from an imported chart; for CCLI reporting) */
  ccli?: string;
  copyright?: string;
  /** video time minus song time: the muted video in Session follows the player with it (seconds) */
  referenceOffset?: number;
  /** take that plays with the song (Record page), e.g. "take-003" */
  activeTake?: string;
  /** createdAt of the analysis the chart copy was made from */
  chartFromAnalysis?: string;
}

/** Mixer state of a part the user has not touched: quiet parts start muted. */
export function defaultMix(stem: { quiet?: boolean } | undefined): MixState {
  return { gain: 1, mute: !!stem?.quiet, solo: false };
}

export const DEFAULT_CLICK: ClickSettings = {
  enabled: false,
  gain: 0.7,
  source: "beats",
  bpm: 120,
  offset: 0,
  beatsPerBar: 4,
  subdivision: 1,
  countInBars: 1,
  beatScale: 1,
  nudgeMs: 0,
};

/** Fill in fields missing from an imported or older song.json. */
export function normalizeSong(raw: any): SongDoc {
  return {
    ...raw, // keep fields this version does not know about
    version: 1,
    title: raw.title ?? "Untitled",
    artist: raw.artist ?? "",
    source: raw.source ?? "",
    sampleRate: raw.sampleRate ?? 44100,
    sourceBits: raw.sourceBits,
    duration: raw.duration ?? 0,
    // Stored with the spelling of the day it was saved (e.g. "Gb"): show it the way the key picker spells it now.
    key: raw.key ? (parseKey(raw.key) ? keyName(parseKey(raw.key)!) : raw.key) : undefined,
    capo: raw.capo ?? 0,
    tuning: raw.tuning ?? "Standard (E A D G B E)",
    transpose: raw.transpose ?? 0,
    linkPitchToTranspose: raw.linkPitchToTranspose ?? true,
    tempoRatio: raw.tempoRatio ?? 1,
    chart: raw.chart,
    mixer: raw.mixer ?? {},
    // 71% = -3 dB: mastered songs peak at 0 dBFS, so this keeps the safety limiter idle at normal levels.
    master: { gain: 0.71, limiter: true, ...(raw.master ?? {}) },
    click: { ...DEFAULT_CLICK, ...(raw.click ?? {}) },
    cues: { enabled: true, gain: 0.9, items: [], ...(raw.cues ?? {}) },
    loop: raw.loop,
    nashvilleMinor: raw.nashvilleMinor ?? "relative-major",
    simpleChords: raw.simpleChords ?? false,
  } as SongDoc;
}

/** The chart in use: user edits when present, otherwise the analysis (marked unconfirmed). */
export function chartOf(song: SongDoc, analysis: Analysis | null): { chords: ChordSeg[]; sections: Section[] } {
  if (song.chart) return song.chart;
  return {
    chords: (analysis?.chords ?? []).map((c) => ({ ...c, confirmed: false })),
    sections: (analysis?.sections ?? []).map((s) => ({ ...s })),
  };
}

/**
 * Re-analysis: combine the user's chart with new estimates.
 * Chords: keep every chord the user confirmed, typed, added or split; new estimates fill only the gaps.
 * Sections: keep each section the user named or added; new suggestions fill only the time the user's
 * sections do not cover (so a fixed Chorus survives, and stale suggested sections are replaced).
 */
export function mergeChartWithAnalysis(chart: { chords: ChordSeg[]; sections: Section[] }, analysis: Analysis): { chords: ChordSeg[]; sections: Section[] } {
  const kept = chart.chords.filter((c) => c.confirmed || c.user).sort((a, b) => a.start - b.start);
  const fresh: ChordSeg[] = [];
  for (const c of analysis.chords) {
    for (const [a, b] of subtract([[c.start, c.end]], kept)) if (b - a >= 0.25) fresh.push({ ...c, start: a, end: b, confirmed: false });
  }
  const userSecs = chart.sections.filter((s) => !s.suggested).sort((a, b) => a.start - b.start);
  const freshSecs: Section[] = [];
  for (const s of analysis.sections) {
    for (const [a, b] of subtract([[s.start, s.end]], userSecs)) if (b - a >= 2) freshSecs.push({ ...s, start: a, end: b });
  }
  return {
    chords: [...kept, ...fresh].sort((a, b) => a.start - b.start),
    sections: [...userSecs, ...freshSecs].sort((a, b) => a.start - b.start),
  };
}

/** The parts of `ranges` not covered by any of `cut`. */
function subtract(ranges: [number, number][], cut: { start: number; end: number }[]): [number, number][] {
  let pieces = ranges;
  for (const k of cut) {
    pieces = pieces.flatMap(([a, b]): [number, number][] => {
      if (k.end <= a || k.start >= b) return [[a, b]];
      const out: [number, number][] = [];
      if (k.start > a) out.push([a, k.start]);
      if (k.end < b) out.push([k.end, b]);
      return out;
    });
  }
  return pieces;
}

export const LOW_CONFIDENCE = 0.35;

/** Reduce a chord to a plain triad for a simpler chart (Gsus4 -> G, Am7 -> Am). Keeps slash bass. */
export function simplifyChord(symbol: string): string {
  // tonal knows the chord's real quality: sus stays sus, m7b5 becomes dim, Cadd9 becomes C (theory/chordInfo.ts)
  return simplify(symbol);
}
