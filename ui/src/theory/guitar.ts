// Guitar shapes: tunings, capo, open-position shapes, and CAGED positions.

import { type Chord, chordName, isMinor, parseChord, transposeChord } from "./chords";
import { type Key, mod12, parseNote } from "./notes";

// ---------- Tunings ----------

export interface Tuning {
  name: string;
  /** Open-string MIDI notes, low string first. */
  strings: number[];
}

const STANDARD_MIDI = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4

export const TUNINGS: Tuning[] = [
  { name: "Standard (E A D G B E)", strings: STANDARD_MIDI },
  { name: "Half step down (Eb)", strings: STANDARD_MIDI.map((n) => n - 1) },
  { name: "Whole step down (D)", strings: STANDARD_MIDI.map((n) => n - 2) },
  { name: "Drop D (D A D G B E)", strings: [38, 45, 50, 55, 59, 64] },
  { name: "DADGAD", strings: [38, 45, 50, 55, 57, 62] },
  { name: "Open G (D G D G B D)", strings: [38, 43, 50, 55, 59, 62] },
];

/** Parse "D A D G B E" or "D2 A2 D3 G3 B3 E4" into a tuning. Octaves are inferred low to high. */
export function parseTuning(text: string, name = "Custom"): Tuning | null {
  const parts = text.trim().split(/[\s,]+/);
  if (parts.length !== 6) return null;
  const strings: number[] = [];
  for (let i = 0; i < 6; i++) {
    const m = /^([A-Ga-g][#b]?)(\d)?$/.exec(parts[i]);
    if (!m) return null;
    const pc = parseNote(m[1]);
    if (pc === null) return null;
    let midi: number;
    if (m[2] !== undefined) midi = 12 * (+m[2] + 1) + pc;
    else {
      // Pick the octave closest to the standard string pitch.
      const ref = STANDARD_MIDI[i];
      midi = ref + ((((pc - ref) % 12) + 18) % 12) - 6;
    }
    strings.push(midi);
  }
  return { name, strings };
}

/**
 * If every string is shifted by the same amount from standard, return that shift (e.g. -1 for Eb tuning).
 * Otherwise null: standard chord shapes do not apply as-is.
 */
export function uniformShift(t: Tuning): number | null {
  const d = t.strings[0] - STANDARD_MIDI[0];
  return t.strings.every((n, i) => n - STANDARD_MIDI[i] === d) ? d : null;
}

// ---------- Shape library (standard tuning, frets low E to high e, -1 = muted) ----------

export interface Shape {
  frets: number[];
  barre: boolean;
}

const S = (s: string, barre = false): Shape => ({
  frets: s.split("").map((c) => (c === "x" ? -1 : parseInt(c, 36))),
  barre,
});

/** Common open and near-open shapes, keyed by chord name in sharps (guitar spelling). */
export const OPEN_SHAPES: Record<string, Shape> = {
  C: S("x32010"), Cmaj7: S("x32000"), C7: S("x32310"), Cadd9: S("x32033"), Csus2: S("x30010"),
  "C/E": S("032010"), "C/G": S("332010"),
  D: S("xx0232"), Dm: S("xx0231"), D7: S("xx0212"), Dsus4: S("xx0233"), Dsus2: S("xx0230"),
  Dm7: S("xx0211"), Dmaj7: S("xx0222"), "D/F#": S("200232"),
  E: S("022100"), Em: S("022000"), E7: S("020100"), Em7: S("022033"), Esus4: S("022200"),
  G: S("320003"), G7: S("320001"), Gsus4: S("330013"), "G/B": S("x20003"), G6: S("320000"),
  A: S("x02220"), Am: S("x02210"), A7: S("x02020"), Am7: S("x02010"), Asus2: S("x02200"),
  Asus4: S("x02230"), Amaj7: S("x02120"), "A/C#": S("x42220"), "Am/G": S("302210"),
  F: S("133211", true), Fmaj7: S("xx3210"), "F/C": S("x33211", true),
  Bm: S("x24432", true), B7: S("x21202"), Bm7: S("x20202"),
};

// ---------- Shape to play ----------

export interface ShapeChoice {
  /** Chord name of the shape your hand makes (relative to the capo). */
  shapeName: string;
  shape: Shape | null;
  /** true when a standard-tuning shape was re-fretted for this tuning (e.g. Drop D low string +2) */
  adapted?: boolean;
}

/** The shift shared by most strings (Drop D -> 0, Eb standard -> -1, DADGAD -> 0). Ties prefer the smaller shift. */
export function tuningShift(t: Tuning): number {
  const counts = new Map<number, number>();
  t.strings.forEach((n, i) => counts.set(n - STANDARD_MIDI[i], (counts.get(n - STANDARD_MIDI[i]) ?? 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || Math.abs(a[0]) - Math.abs(b[0]))[0][0];
}

/** A standard-tuning shape played in tuning t: re-fretted where needed (null result = unchanged). */
export function shapeInTuning(shape: Shape, t: Tuning): { shape: Shape; adapted: boolean } {
  if (uniformShift(t) !== null) return { shape, adapted: false };
  const out = retune(shape, t, tuningShift(t));
  return { shape: out, adapted: out.frets.join() !== shape.frets.join() };
}

/** Re-fret a standard-tuning shape for strings tuned differently; a string that would need a negative fret is muted. */
function retune(shape: Shape, t: Tuning, shift: number): Shape {
  return {
    barre: shape.barre,
    frets: shape.frets.map((f, i) => {
      if (f < 0) return -1;
      const g = f + (STANDARD_MIDI[i] + shift - t.strings[i]);
      return g < 0 || g > 15 ? -1 : g;
    }),
  };
}

/**
 * The shape to play for a sounding chord, given a capo and tuning.
 * Returns null when the tuning is non-uniform (e.g. DADGAD): standard shapes do not apply.
 */
export function shapeFor(sounding: Chord, capo: number, tuning: Tuning): ShapeChoice | null {
  const uniform = uniformShift(tuning);
  const shift = uniform ?? tuningShift(tuning);
  const shapeChord = transposeChord(sounding, -(capo + shift));
  const shapeName = chordName(shapeChord, false);
  const std = OPEN_SHAPES[shapeName] ?? null;
  if (uniform !== null || !std) return { shapeName, shape: std };
  const re = retune(std, tuning, shift);
  return { shapeName, shape: re, adapted: re.frets.join() !== std.frets.join() }; // "adapted" only when it changed
}

export function isOpenFriendly(choice: ShapeChoice | null): boolean {
  return !!choice?.shape && !choice.shape.barre;
}

export interface CapoOption {
  capo: number;
  shapeKey: string;
  openCount: number;
  total: number;
}

/** Rank capo positions 0-7 by how many of the song's chords become open (non-barre) shapes. */
export function suggestCapos(chords: string[], key: Key, tuning: Tuning, maxCapo = 7): CapoOption[] {
  const shift = uniformShift(tuning) ?? tuningShift(tuning);
  const parsed = [...new Set(chords)].map(parseChord).filter((c): c is Chord => !!c);
  const options: CapoOption[] = [];
  for (let capo = 0; capo <= maxCapo; capo++) {
    const openCount = parsed.filter((c) => isOpenFriendly(shapeFor(c, capo, tuning))).length;
    const shapeTonic = mod12(key.tonic - capo - shift);
    const shapeKey = chordName({ root: shapeTonic, suffix: key.minor ? "m" : "", bass: null }, false);
    options.push({ capo, shapeKey, openCount, total: parsed.length });
  }
  // Most open shapes first; lower capo wins a tie.
  return options.sort((a, b) => b.openCount - a.openCount || a.capo - b.capo);
}

// ---------- CAGED ----------

export interface CagedPosition {
  form: "C" | "A" | "G" | "E" | "D";
  /** Fret where the shape's nut (or barre) sits. 0 = open position. */
  fret: number;
}

const CAGED_ROOT: Record<CagedPosition["form"], number> = { C: 0, A: 9, G: 7, E: 4, D: 2 };

/**
 * CAGED positions for a chord in standard tuning (relative to the capo).
 * Minor chords list only the practical minor forms (A, E, D).
 */
export function cagedPositions(c: Chord): CagedPosition[] {
  const forms: CagedPosition["form"][] = isMinor(c) ? ["E", "A", "D"] : ["C", "A", "G", "E", "D"];
  return forms
    .map((form) => ({ form, fret: mod12(c.root - CAGED_ROOT[form]) }))
    .sort((a, b) => a.fret - b.fret);
}

// ---------- CAGED diagrams ----------

const CAGED_MAJOR: Record<CagedPosition["form"], string> = { C: "x32010", A: "x02220", G: "320003", E: "022100", D: "xx0232" };
const CAGED_MINOR: Partial<Record<CagedPosition["form"], string>> = { E: "022000", A: "x02210", D: "xx0231" };

export interface CagedShape extends CagedPosition {
  shape: Shape;
  /** true when only the triad is shown (the chord has extensions such as 7 or sus) */
  triadOnly: boolean;
}

/**
 * Playable diagrams for each CAGED form of a chord (standard tuning, relative to the capo).
 * The open form moved up n frets: every fretted note + n, open strings become the barre at n.
 */
export function cagedShapes(c: Chord): CagedShape[] {
  const minor = isMinor(c);
  const templates = minor ? CAGED_MINOR : CAGED_MAJOR;
  const triadOnly = !/^(m|)$/.test(c.suffix);
  return cagedPositions(c)
    .filter((p) => templates[p.form])
    .map((p) => {
      const base = S(templates[p.form]!);
      const frets = base.frets.map((f) => (f < 0 ? -1 : f + p.fret));
      return { ...p, shape: { frets, barre: p.fret > 0 }, triadOnly };
    });
}
