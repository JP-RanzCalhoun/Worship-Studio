// Chord symbols: parse, spell, transpose, and convert to Nashville numbers.

import { type Key, keyUsesFlats, mod12, nashvilleTonic, noteName, parseNote } from "./notes";

export interface Chord {
  root: number; // pitch class
  /** Quality suffix exactly as written after the root, e.g. "", "m", "7", "maj7", "sus4", "m7b5". */
  suffix: string;
  bass: number | null; // slash bass pitch class
}

export const NO_CHORD = "N.C.";

export function parseChord(symbol: string): Chord | null {
  const s = symbol.trim();
  const m = /^([A-G][#b♯♭]?)([^/]*)(?:\/([A-G][#b♯♭]?))?$/.exec(s);
  if (!m) return null;
  const root = parseNote(m[1]);
  if (root === null) return null;
  const bass = m[3] ? parseNote(m[3]) : null;
  if (m[3] && bass === null) return null;
  return { root, suffix: m[2], bass };
}

export function isMinor(c: Chord): boolean {
  return /^(m|min|-)(?!aj)/.test(c.suffix);
}

export function chordName(c: Chord, flats: boolean): string {
  const bass = c.bass === null ? "" : "/" + noteName(c.bass, flats);
  return noteName(c.root, flats) + c.suffix + bass;
}

export function transposeChord(c: Chord, semitones: number): Chord {
  return {
    root: mod12(c.root + semitones),
    suffix: c.suffix,
    bass: c.bass === null ? null : mod12(c.bass + semitones),
  };
}

/** Transpose a chord symbol and spell it for the target key. */
export function transposeSymbol(symbol: string, semitones: number, target: Key): string {
  const c = parseChord(symbol);
  if (!c) return symbol;
  return chordName(transposeChord(c, semitones), keyUsesFlats(target.tonic, target.minor));
}

const DEGREES = ["1", "b2", "2", "b3", "3", "4", "b5", "5", "b6", "6", "b7", "7"];

export type MinorNumbering = "relative-major" | "minor-tonic";

/**
 * Nashville number for a chord in a key.
 * Default numbers minor keys from the relative major (Am in C = 6m), the usual Nashville habit.
 */
export function nashville(c: Chord, key: Key, minorNumbering: MinorNumbering = "relative-major"): string {
  const tonic = key.minor && minorNumbering === "minor-tonic" ? key.tonic : nashvilleTonic(key);
  const deg = DEGREES[mod12(c.root - tonic)];
  const bass = c.bass === null ? "" : "/" + DEGREES[mod12(c.bass - tonic)];
  return deg + nashvilleSuffix(c.suffix) + bass;
}

function nashvilleSuffix(suffix: string): string {
  // Keep it close to how charts are written: "m" stays, "maj7" -> "Δ7", "dim" -> "°".
  return suffix.replace(/^maj7/, "Δ7").replace(/^dim7?/, (d) => (d === "dim7" ? "°7" : "°"));
}

/** Parse a Nashville number (e.g. "4", "6m", "b7", "1/3") back into a chord in the given key. */
export function fromNashville(num: string, key: Key, minorNumbering: MinorNumbering = "relative-major"): Chord | null {
  const tonic = key.minor && minorNumbering === "minor-tonic" ? key.tonic : nashvilleTonic(key);
  const m = /^([b#]?)([1-7])([^/]*)(?:\/([b#]?)([1-7]))?$/.exec(num.trim());
  if (!m) return null;
  const step = (acc: string, d: string) =>
    [0, 2, 4, 5, 7, 9, 11][+d - 1] + (acc === "b" ? -1 : acc === "#" ? 1 : 0);
  const suffix = m[3].replace(/^Δ7/, "maj7").replace(/^°7/, "dim7").replace(/^°/, "dim");
  return {
    root: mod12(tonic + step(m[1], m[2])),
    suffix,
    bass: m[5] ? mod12(tonic + step(m[4], m[5])) : null,
  };
}
