// Chord charts from text: ChordPro (SongSelect "ChordPro" download, .cho/.pro) or chords written over the lyrics
// (what you copy from chord sites). Then lined up with the song's detected chords, so lyrics and chord names land
// at the right time. Our own small parser (ChordSheetJS is GPL, so it is not used).

import type { ChordSeg, Section } from "./song";
import { chordName, isMinor, parseChord, transposeChord } from "./theory/chords";
import { mod12 } from "./theory/notes";

export interface ChartLine {
  lyrics: string;
  chords: string[];
}
export interface ChartSection {
  label: string;
  lines: ChartLine[];
}
export interface ParsedChart {
  title?: string;
  artist?: string;
  key?: string;
  ccli?: string;
  copyright?: string;
  sections: ChartSection[];
}

const CHORD_RE = /^[A-G][#b]?(?:maj|min|m|M|dim|aug|sus|add|\+|°|ø)?\d*(?:\([^)]*\))?(?:(?:sus|add|maj|b|#)?\d+)*(?:\/[A-G][#b]?)?$/;
export const isChord = (t: string) => CHORD_RE.test(t) || t === "N.C.";
const SECTION_RE = /^\s*[[(]?\s*(intro|verse|pre-?chorus|chorus|bridge|tag|outro|interlude|instrumental|refrain|ending|turnaround|vamp|coda)(\s*\d+)?\s*[\])]?\s*:?\s*(x\s*\d+)?\s*$/i;

/** A line made only of chords (and bar marks / repeat signs) is a chord line. */
function chordTokens(line: string): string[] | null {
  const toks = line.replace(/[|]/g, " ").trim().split(/\s+/).filter((t) => t && !/^(x\d+|\d+x|\(x\d+\)|-+|\/+)$/i.test(t));
  if (!toks.length) return null;
  return toks.every(isChord) ? toks : null;
}

/** Parses ChordPro or chords-over-lyrics text. */
export function parseChart(text: string): ParsedChart {
  const out: ParsedChart = { sections: [] };
  const lines = text.replace(/\r/g, "").split("\n");
  let cur: ChartSection | null = null;
  const section = (label: string) => {
    cur = { label, lines: [] };
    out.sections.push(cur);
    return cur;
  };
  const line = (l: ChartLine) => (cur ?? section("Song")).lines.push(l);
  const chordPro = /\{[a-z_]+[:}]|\[[A-G][#b]?[^\]\s]*\]/i.test(text);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t) continue;
    const dir = /^\{\s*([a-z_]+)\s*(?::\s*(.*?))?\s*\}$/i.exec(t);
    if (dir) {
      const [, name, value = ""] = dir;
      const n = name.toLowerCase();
      if (n === "title" || n === "t") out.title = value;
      else if (n === "artist" || n === "subtitle" || n === "st") out.artist = out.artist ?? value;
      else if (n === "key") out.key = value;
      else if (n === "ccli" || n === "ccli_license") out.ccli = value;
      else if (n === "copyright") out.copyright = value;
      else if (/^(start_of_|so)(verse|chorus|bridge|tab|grid|part)?/.test(n) && !n.startsWith("end")) section(value || n.replace(/^(start_of_|so)/, "").replace(/^v$/, "verse").replace(/^c$/, "chorus") || "Part");
      else if (n === "comment" || n === "c" || n === "ci") {
        if (SECTION_RE.test(value)) section(value.replace(/[:[\]()]/g, "").trim());
      }
      continue;
    }
    if (/^(ccli|©|copyright)/i.test(t)) {
      if (/ccli/i.test(t)) out.ccli = out.ccli ?? (/\d{4,}/.exec(t)?.[0] ?? t);
      else out.copyright = out.copyright ?? t;
      continue;
    }
    if (SECTION_RE.test(t)) {
      section(t.replace(/[:[\]()]/g, "").trim());
      continue;
    }
    if (chordPro && /\[[^\]]+\]/.test(t)) {
      // inline ChordPro: "Ama[G]zing [C]grace"
      const chords: string[] = [];
      const lyrics = t.replace(/\[([^\]]+)\]/g, (_, c: string) => {
        if (isChord(c.trim())) chords.push(c.trim());
        return "";
      });
      line({ lyrics: lyrics.replace(/\s+/g, " ").trim(), chords });
      continue;
    }
    const toks = chordTokens(t);
    if (toks) {
      // chords over lyrics: the next non-empty, non-chord line is the lyric line
      const nextRaw = lines[i + 1]?.trim() ?? "";
      if (nextRaw && !chordTokens(nextRaw) && !SECTION_RE.test(nextRaw) && !nextRaw.startsWith("{")) {
        line({ lyrics: nextRaw, chords: toks });
        i++;
      } else line({ lyrics: "", chords: toks });
      continue;
    }
    line({ lyrics: t, chords: [] });
  }
  return out;
}

// ---------- lining up with the song ----------

interface Flat {
  chord: string;
  section: number;
  line: number;
}

const pcOf = (c: string) => parseChord(c)?.root ?? null;
const minorOf = (c: string) => {
  const p = parseChord(c);
  return p ? isMinor(p) : false;
};

/** Score of chart chord `a` (moved by `shift` semitones) against a detected chord `b`. */
function score(a: string, b: string, shift: number): number {
  const pa = pcOf(a),
    pb = pcOf(b);
  if (pa === null || pb === null) return -1;
  if (mod12(pa + shift) !== pb) return -1;
  return minorOf(a) === minorOf(b) ? 3 : 1;
}

export interface AlignResult {
  chords: ChordSeg[];
  sections: Section[];
  lyrics: { t: number; text: string; section: string }[];
  matched: number;
  total: number;
  /** semitones from the chart's key to the recording's key (e.g. a capo chart) */
  shift: number;
  /** lyric lines placed between their neighbours (no matched chord to time them): check them */
  estimated: number;
}

/**
 * Lines the chart up with the detected chord changes (sequence alignment, trying all 12 keys, since charts are often
 * written for a capo or another key). Each matched detected chord takes the chart's chord name (sus, add9, slash…),
 * moved to the sounding key; lyric lines and section names take the time of their first matched chord.
 * Detected chords that match nothing stay as they were; nothing is marked confirmed (the user checks it).
 */
export function alignChart(chart: ParsedChart, detected: ChordSeg[]): AlignResult {
  const flat: Flat[] = [];
  chart.sections.forEach((s, si) => s.lines.forEach((l, li) => l.chords.forEach((c) => c !== "N.C." && flat.push({ chord: c, section: si, line: li }))));
  const det = detected.filter((d) => d.chord !== "N.C.");
  const total = flat.length;
  let best = { s: -Infinity, shift: 0, pairs: [] as [number, number][] };
  if (total && det.length) {
    for (let shift = 0; shift < 12; shift++) {
      // Needleman-Wunsch: skipping a detected chord is cheap (repeats, passing chords), skipping a chart chord costs more.
      const n = flat.length,
        m = det.length;
      const S = Array.from({ length: n + 1 }, () => new Float32Array(m + 1));
      const B = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)); // 1 diag, 2 up (skip chart), 3 left (skip detected)
      for (let i = 1; i <= n; i++) {
        S[i][0] = -2 * i;
        B[i][0] = 2;
      }
      for (let j = 1; j <= m; j++) {
        S[0][j] = -0.3 * j;
        B[0][j] = 3;
      }
      for (let i = 1; i <= n; i++)
        for (let j = 1; j <= m; j++) {
          const d = S[i - 1][j - 1] + score(flat[i - 1].chord, det[j - 1].chord, shift);
          const u = S[i - 1][j] - 2;
          const l = S[i][j - 1] - 0.3;
          if (d >= u && d >= l) (S[i][j] = d), (B[i][j] = 1);
          else if (u >= l) (S[i][j] = u), (B[i][j] = 2);
          else (S[i][j] = l), (B[i][j] = 3);
        }
      if (S[n][m] > best.s) {
        const pairs: [number, number][] = [];
        for (let i = n, j = m; i > 0 || j > 0; ) {
          const b = B[i][j];
          if (b === 1) {
            if (score(flat[i - 1].chord, det[j - 1].chord, shift) > 0) pairs.push([i - 1, j - 1]);
            i--, j--;
          } else if (b === 2) i--;
          else j--;
        }
        best = { s: S[n][m], shift, pairs: pairs.reverse() };
      }
    }
  }
  const named = new Map<number, string>(); // detected index -> chart chord (sounding key)
  const timeOfFlat = new Map<number, number>();
  for (const [fi, di] of best.pairs) {
    const p = parseChord(flat[fi].chord);
    // Spelled like the detected chord (flats only when it uses them).
    named.set(di, p ? chordName(transposeChord(p, best.shift), /^[A-G]b/.test(det[di].chord)) : flat[fi].chord);
    timeOfFlat.set(fi, det[di].start);
  }
  const chords = detected.map((d) => {
    const i = det.indexOf(d);
    const n = i >= 0 ? named.get(i) : undefined;
    return n ? { ...d, chord: n, confirmed: false, user: true } : d;
  });
  // Lyric lines and sections at the time of their first matched chord.
  const lyrics: AlignResult["lyrics"] = [];
  const secStart = new Map<number, number>();
  flat.forEach((f, fi) => {
    const t = timeOfFlat.get(fi);
    if (t === undefined) return;
    if (!secStart.has(f.section)) secStart.set(f.section, t);
    const key = `${f.section}:${f.line}`;
    if (!lyrics.some((l) => (l as any).key === key)) lyrics.push({ t, text: chart.sections[f.section].lines[f.line].lyrics, section: chart.sections[f.section].label, key } as any);
  });
  // Lines with no matched chord (an intro without chords, a verse whose chords did not match) are not dropped
  // (audit): they get a time between the placed lines around them, in chart order, and are counted as estimated.
  const placed = new Map(lyrics.map((l: any) => [l.key as string, l.t as number]));
  const order: { key: string; si: number; li: number }[] = [];
  chart.sections.forEach((sec, si) => sec.lines.forEach((ln, li) => ln.lyrics.trim() && order.push({ key: `${si}:${li}`, si, li })));
  let estimated = 0;
  for (let k = 0; k < order.length; k++) {
    if (placed.has(order[k].key)) continue;
    let p = k - 1;
    while (p >= 0 && !placed.has(order[p].key)) p--;
    let n = k + 1;
    while (n < order.length && !placed.has(order[n].key)) n++;
    const tp = p >= 0 ? placed.get(order[p].key)! : undefined;
    const tn = n < order.length ? placed.get(order[n].key)! : undefined;
    if (tp === undefined && tn === undefined) break; // nothing placed at all
    const t = tp !== undefined && tn !== undefined ? tp + ((tn - tp) * (k - p)) / (n - p) : tp !== undefined ? tp + 2 * (k - p) : Math.max(0, tn! - 2 * (n - k));
    placed.set(order[k].key, t);
    const sec = chart.sections[order[k].si];
    lyrics.push({ t, text: sec.lines[order[k].li].lyrics, section: sec.label, key: order[k].key } as any);
    estimated++;
  }
  lyrics.sort((a, b) => a.t - b.t);
  const starts = [...secStart.entries()].sort((a, b) => a[1] - b[1]);
  const end = detected.length ? detected[detected.length - 1].end : 0;
  const sections: Section[] = starts.map(([si, t], k) => ({ start: t, end: k + 1 < starts.length ? starts[k + 1][1] : end, label: chart.sections[si].label, suggested: false }));
  return { chords, sections, lyrics: lyrics.map(({ t, text, section }) => ({ t, text, section })), matched: best.pairs.length, total, shift: best.shift, estimated };
}
