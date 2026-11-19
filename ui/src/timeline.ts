// Beat grid, click events, count-in, and spoken-cue timing. Pure functions (unit tested).

import type { Analysis, ClickSettings, CueItem } from "./song";

export interface GridBeat {
  t: number;
  /** position in the bar, 0 = downbeat */
  pos: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0.5;
}

/** Beat grid covering [start, duration], extrapolated before the first and after the last detected beat. */
export function beatGrid(analysis: Analysis | null, click: ClickSettings, duration: number, start = -20): GridBeat[] {
  const bpb = Math.max(1, click.beatsPerBar);
  let beats: number[];
  let downs: number[];

  if (click.source === "fixed" || !analysis || analysis.rhythm.beats.length < 4) {
    const step = 60 / Math.max(20, click.bpm);
    beats = [];
    for (let t = click.offset; t <= duration + step; t += step) beats.push(t);
    downs = beats.filter((_, i) => i % bpb === 0);
  } else {
    beats = [...analysis.rhythm.beats];
    downs = [...analysis.rhythm.downbeats];
    if (click.beatScale === 2) {
      const doubled: number[] = [];
      beats.forEach((b, i) => {
        doubled.push(b);
        if (i + 1 < beats.length) doubled.push((b + beats[i + 1]) / 2);
      });
      beats = doubled;
    } else if (click.beatScale === 0.5) {
      // Keep the beats in phase with the downbeats.
      const first = downs.length ? beats.findIndex((b) => Math.abs(b - downs[0]) < 0.08) : 0;
      beats = beats.filter((_, i) => (i - Math.max(first, 0)) % 2 === 0);
    }
  }

  // Bar position of every beat.
  const isDown = (t: number) => downs.some((d) => Math.abs(d - t) < 0.08);
  const firstDown = beats.findIndex(isDown);
  const grid: GridBeat[] = [];
  let pos = firstDown < 0 ? 0 : (bpb - (firstDown % bpb)) % bpb;
  for (let i = 0; i < beats.length; i++) {
    if (isDown(beats[i])) pos = 0;
    grid.push({ t: beats[i], pos });
    pos = (pos + 1) % bpb;
  }
  if (!grid.length) return grid;

  // Extrapolate backwards (count-in before the song) and forwards (to the end).
  const headStep = median(grid.slice(0, 9).map((g, i, a) => (i ? g.t - a[i - 1].t : NaN)).filter((x) => !isNaN(x)));
  const tailStep = median(grid.slice(-9).map((g, i, a) => (i ? g.t - a[i - 1].t : NaN)).filter((x) => !isNaN(x)));
  const before: GridBeat[] = [];
  for (let t = grid[0].t - headStep, p = (grid[0].pos - 1 + bpb) % bpb; t >= start; t -= headStep, p = (p - 1 + bpb) % bpb)
    before.unshift({ t, pos: p });
  const after: GridBeat[] = [];
  const last = grid[grid.length - 1];
  for (let t = last.t + tailStep, p = (last.pos + 1) % bpb; t <= duration; t += tailStep, p = (p + 1) % bpb) after.push({ t, pos: p });
  return [...before, ...grid, ...after];
}

/** Click events for the engine: k = 0 accent, 1 beat, 2 subdivision. */
export function clickEvents(grid: GridBeat[], subdivision: number): { t: number; k: number }[] {
  const out: { t: number; k: number }[] = [];
  for (let i = 0; i < grid.length; i++) {
    out.push({ t: grid[i].t, k: grid[i].pos === 0 ? 0 : 1 });
    if (subdivision > 1 && i + 1 < grid.length) {
      const step = (grid[i + 1].t - grid[i].t) / subdivision;
      for (let s = 1; s < subdivision; s++) out.push({ t: grid[i].t + s * step, k: 2 });
    }
  }
  return out;
}

/** Index of the grid beat nearest to t. */
export function nearestBeat(grid: GridBeat[], t: number): number {
  let best = 0;
  for (let i = 1; i < grid.length; i++) if (Math.abs(grid[i].t - t) < Math.abs(grid[best].t - t)) best = i;
  return best;
}

/**
 * Start point and pre-roll for a count-in of `bars` bars before `from`.
 * Snaps `from` to the nearest beat when close (so the count lands on the grid).
 */
export function countIn(grid: GridBeat[], from: number, bars: number, beatsPerBar: number): { from: number; preRoll: number } {
  if (!grid.length || bars <= 0) return { from, preRoll: 0 };
  const i = nearestBeat(grid, from);
  const snapped = Math.abs(grid[i].t - from) < 0.2 ? grid[i].t : from;
  const j = i - bars * beatsPerBar;
  if (j < 0) return { from: snapped, preRoll: bars * beatsPerBar * (grid[1].t - grid[0].t) };
  return { from: snapped, preRoll: snapped - grid[j].t };
}

/**
 * Expand cue items into timed words.
 * A cue with count: label on the downbeat two bars before t, then "1 2 3 4" on the bar before t.
 * A cue without count: label on the downbeat one bar before t.
 */
export function expandCues(items: CueItem[], grid: GridBeat[], beatsPerBar: number): { t: number; text: string }[] {
  const out: { t: number; text: string }[] = [];
  for (const c of items) {
    if (!grid.length) continue;
    const i = nearestBeat(grid, c.t);
    const at = (k: number) => (i - k >= 0 ? grid[i - k].t : grid[0].t - (k - i) * (grid[1].t - grid[0].t));
    if (c.count) {
      if (c.text.trim()) out.push({ t: at(2 * beatsPerBar), text: c.text });
      // A spoken number lasts about 0.3 s; at a fast pulse only "1" and the half-bar fit.
      const spacing = at(1) - at(2);
      const every = spacing >= 0.33 ? 1 : spacing >= 0.17 ? 2 : beatsPerBar;
      for (let b = 0; b < beatsPerBar; b += every) out.push({ t: at(beatsPerBar - b), text: String(b + 1) });
    } else if (c.text.trim()) {
      out.push({ t: at(beatsPerBar), text: c.text });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Default spoken cues from the section list: every section announced, count-in before the first. */
export function cuesFromSections(sections: { start: number; label: string }[]): CueItem[] {
  const seen: Record<string, number> = {};
  return sections.map((s, i) => {
    const base = s.label.replace(/\s+\d+$/, "");
    seen[base] = (seen[base] ?? 0) + 1;
    const spoken = /^[A-Z]$/.test(base) ? `Part ${base}` : base;
    return { id: `cue-${i}-${Math.round(s.start * 1000)}`, t: s.start, text: spoken, count: i === 0 };
  });
}
