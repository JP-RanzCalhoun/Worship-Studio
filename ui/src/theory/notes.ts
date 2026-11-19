// Pitch classes, note spelling, and transposition.

export const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Major keys that are written with flats. */
// F#/Gb (6) is written with sharps: guitarists read F#, B, C#, and an F# chart in Gb is unreadable on a stand.
const FLAT_MAJOR_KEYS = new Set([5, 10, 3, 8, 1]); // F Bb Eb Ab Db

export const mod12 = (n: number) => ((n % 12) + 12) % 12;

/** Parse a note name such as "C", "F#", "Bb", "Ebb". Returns a pitch class or null. */
export function parseNote(name: string): number | null {
  const m = /^([A-Ga-g])([#b♯♭]*)$/.exec(name.trim());
  if (!m) return null;
  let pc = LETTER_PC[m[1].toUpperCase()];
  for (const ch of m[2]) pc += ch === "#" || ch === "♯" ? 1 : -1;
  return mod12(pc);
}

/** Should notes in this key be spelled with flats? */
export function keyUsesFlats(keyPc: number, minor = false): boolean {
  // A minor key uses the signature of its relative major.
  const relMajor = minor ? mod12(keyPc + 3) : keyPc;
  return FLAT_MAJOR_KEYS.has(relMajor);
}

export function noteName(pc: number, flats: boolean): string {
  return (flats ? FLAT_NAMES : SHARP_NAMES)[mod12(pc)];
}

export interface Key {
  tonic: number; // pitch class
  minor: boolean;
}

export function parseKey(text: string): Key | null {
  const m = /^([A-G][#b]?)\s*(m|min|minor)?$/i.exec(text.trim());
  if (!m) return null;
  const tonic = parseNote(m[1]);
  if (tonic === null) return null;
  return { tonic, minor: !!m[2] };
}

export function keyName(k: Key): string {
  return noteName(k.tonic, keyUsesFlats(k.tonic, k.minor)) + (k.minor ? "m" : "");
}

/** A key written as text (the analysis writes sharps: "D#"), spelled the way a musician reads it ("Eb"). */
export function spellKey(text: string): string {
  const k = parseKey(text);
  return k ? keyName(k) : text;
}

/** The major key used for Nashville numbering (relative major for minor keys). */
export function nashvilleTonic(k: Key): number {
  return k.minor ? mod12(k.tonic + 3) : k.tonic;
}
