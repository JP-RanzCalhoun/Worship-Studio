// Chord knowledge from tonal (MIT, tonaljs/tonal 6.6.0): 100+ chord types instead of our own short list.
// Used to check chord names people type or import (typos, unknown symbols), to name a chord's tones, and to
// simplify a chord to its triad the musical way (sus stays sus, m7b5 becomes dim).

import { Chord } from "tonal";

/** "Cm(add9)" -> "Cmadd9"; ♯/♭ -> #/b: forms charts use that tonal does not read. */
function normalise(symbol: string): string {
  return symbol.trim().replace(/♯/g, "#").replace(/♭/g, "b").replace(/[()]/g, "");
}

function info(symbol: string) {
  return Chord.get(normalise(symbol));
}

/** True when the symbol is a chord tonal knows (C2, Dsus, G/B, F#m7b5, A7sus4, C5...). */
export function isKnownChord(symbol: string): boolean {
  if (!symbol.trim() || symbol === "N.C.") return false;
  return !info(symbol).empty;
}

/** The chord's tones as note names, e.g. "Cadd9" -> ["C", "E", "G", "D"]; [] when unknown. */
export function chordTones(symbol: string): string[] {
  return info(symbol).notes;
}

/**
 * The simple version of a chord for beginners: its triad. Major and minor keep their third, diminished and
 * augmented keep theirs, sus chords stay sus (they have no third to keep), power chords stay power chords.
 * A slash bass is kept (it is what the bass plays). Unknown symbols come back unchanged.
 */
export function simplify(symbol: string): string {
  const s = normalise(symbol);
  const m = /^([A-G][#b]?)([^/]*)(\/.+)?$/.exec(s);
  if (!m) return symbol;
  const c = Chord.get(s);
  if (c.empty) return symbol;
  const bass = m[3] ?? "";
  const ints = c.intervals;
  const has = (i: string) => ints.includes(i);
  let q = "";
  if (c.quality === "Minor") q = "m";
  else if (c.quality === "Diminished") q = "dim";
  else if (c.quality === "Augmented") q = "aug";
  else if (c.quality === "Major") q = "";
  else if (has("4P") && !has("3M") && !has("3m")) q = "sus4";
  else if (has("2M") && !has("3M") && !has("3m")) q = "sus2";
  else if (ints.length === 2 && has("5P")) q = "5";
  return m[1] + q + bass;
}
