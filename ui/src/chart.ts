// Turns a chart chord into the three things a guitarist needs: sounding chord, Nashville number, shape to play.

import { chordName, fromNashville, nashville, parseChord, transposeChord } from "./theory/chords";
import { cagedShapes, parseTuning, shapeFor, shapeInTuning, type Shape, type Tuning, TUNINGS, uniformShift } from "./theory/guitar";
import { type Key, keyName, keyUsesFlats, mod12, parseKey } from "./theory/notes";
import type { Analysis, ChordSeg, SongDoc } from "./song";
import { simplifyChord } from "./song";

export interface ChartContext {
  /** key of the original recording (detected or user override) */
  baseKey: Key;
  /** key after transposition: what the band plays */
  playKey: Key;
  transpose: number;
  capo: number;
  tuning: Tuning;
  simple: boolean;
  minorNumbering: SongDoc["nashvilleMinor"];
}

export function contextFor(song: SongDoc, analysis: Analysis | null): ChartContext {
  const baseKey = parseKey(song.key ?? analysis?.key.name ?? "C") ?? { tonic: 0, minor: false };
  const playKey = { tonic: mod12(baseKey.tonic + song.transpose), minor: baseKey.minor };
  return {
    baseKey,
    playKey,
    transpose: song.transpose,
    capo: song.capo,
    tuning: resolveTuning(song.tuning),
    simple: song.simpleChords,
    minorNumbering: song.nashvilleMinor,
  };
}

export function resolveTuning(name: string): Tuning {
  if (name.startsWith("custom:")) return parseTuning(name.slice(7), "Custom") ?? TUNINGS[0];
  return TUNINGS.find((t) => t.name === name) ?? TUNINGS[0];
}

export interface ChordView {
  concert: string;
  nashville: string;
  shape: string | null; // null = shapes not available for this tuning
  diagram: Shape | null;
  shapeDiffers: boolean;
  /** diagram is a simpler stand-in: "triad" (no stored shape, basic CAGED triad) or "adapted" (re-fretted for the tuning) */
  diagramNote?: "triad" | "adapted";
}

export function describe(symbol: string, ctx: ChartContext): ChordView {
  const src = ctx.simple ? simplifyChord(symbol) : symbol;
  const c = parseChord(src);
  if (!c) return { concert: symbol, nashville: "", shape: null, diagram: null, shapeDiffers: false };
  const sounding = transposeChord(c, ctx.transpose);
  const concert = chordName(sounding, keyUsesFlats(ctx.playKey.tonic, ctx.playKey.minor));
  const shape = shapeFor(sounding, ctx.capo, ctx.tuning);
  const differs = ctx.capo !== 0 || (uniformShift(ctx.tuning) ?? 1) !== 0;
  // No stored open shape (e.g. Gm, Gsus2): show the lowest CAGED triad, labelled as such (re-fretted for the tuning).
  const caged = !shape?.shape && shape ? cagedShapes(parseChord(shape.shapeName)!)[0] : undefined;
  const fallback = caged ? shapeInTuning(caged.shape, ctx.tuning) : undefined;
  // Shape names are stored with sharps; show them spelled for the key the shapes are played in (Eb, not D#).
  const shapeKeyPc = mod12(ctx.playKey.tonic - ctx.capo - (uniformShift(ctx.tuning) ?? 0));
  const shapeChord = shape ? parseChord(shape.shapeName) : null;
  const shapeLabel = shapeChord ? chordName(shapeChord, keyUsesFlats(shapeKeyPc, ctx.playKey.minor)) : shape?.shapeName ?? null;
  return {
    concert,
    nashville: nashville(sounding, ctx.playKey, ctx.minorNumbering),
    shape: shapeLabel,
    diagram: shape?.shape ?? fallback?.shape ?? null,
    shapeDiffers: differs,
    diagramNote: shape?.adapted ? "adapted" : fallback ? "triad" : undefined,
  };
}

/**
 * Parse what the user typed in the chart editor. Accepts a chord name ("D/F#") in the sounding
 * (transposed) key, or a Nashville number ("4", "6m", "5/7"). Returns the chord in the ORIGINAL
 * recording's key (what the chart stores), or null when it cannot be read.
 */
export function parseUserChord(text: string, ctx: ChartContext): string | null {
  const t = text.trim();
  if (!t) return null;
  if (/^(N\.?C\.?|nc)$/i.test(t)) return "N.C.";
  const asChord = parseChord(t) ?? fromNashville(t, ctx.playKey, ctx.minorNumbering);
  if (!asChord) return null;
  const original = transposeChord(asChord, -ctx.transpose);
  return chordName(original, keyUsesFlats(ctx.baseKey.tonic, ctx.baseKey.minor));
}

/**
 * The chords the live band, waveform and projector show. Detected chords are a guess (chord detection cannot tell
 * sus/add9/slash and passing chords apart reliably), so by default only chords from an imported chart or chords the
 * user typed or checked are shown; `showGuesses` shows the detected ones too.
 */
export function shownChords(chords: ChordSeg[], showGuesses: boolean): ChordSeg[] {
  return showGuesses ? chords : chords.filter((c) => c.confirmed || c.user);
}

export function chordAt(chords: ChordSeg[], t: number): number {
  let lo = 0,
    hi = chords.length - 1,
    ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (chords[mid].start <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans >= 0 && t < chords[ans].end ? ans : -1;
}

/** Index of the section playing at t. A seek lands a hair before a boundary, so allow 50 ms. */
export function sectionAt(sections: { start: number; end: number }[], t: number): number {
  for (let i = sections.length - 1; i >= 0; i--) if (t >= sections[i].start - 0.05) return t < sections[i].end ? i : -1;
  return -1;
}

export function fmtTime(t: number): string {
  const sign = t < 0 ? "-" : "";
  const tenths = Math.round(Math.abs(t) * 10); // round first, so 59.96 becomes 1:00.0, not 0:60.0
  const m = Math.floor(tenths / 600);
  const s = (tenths - m * 600) / 10;
  return `${sign}${m}:${s.toFixed(1).padStart(4, "0")}`;
}

export const ALL_KEYS: string[] = (() => {
  const out: string[] = [];
  for (let pc = 0; pc < 12; pc++) out.push(keyName({ tonic: pc, minor: false }));
  for (let pc = 0; pc < 12; pc++) out.push(keyName({ tonic: pc, minor: true }));
  return out;
})();
