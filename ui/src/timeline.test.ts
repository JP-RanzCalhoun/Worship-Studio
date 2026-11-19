import { describe, expect, it } from "vitest";
import { DEFAULT_CLICK } from "./song";
import { beatGrid, clickEvents, countIn, expandCues } from "./timeline";

const fixed = { ...DEFAULT_CLICK, source: "fixed" as const, bpm: 120, offset: 1.0, beatsPerBar: 4 };

describe("beat grid", () => {
  it("builds a fixed grid with bar positions and a count-in area before 0", () => {
    const g = beatGrid(null, fixed, 4);
    const at1 = g.find((b) => Math.abs(b.t - 1.0) < 1e-6)!;
    expect(at1.pos).toBe(0);
    expect(g.find((b) => Math.abs(b.t - 1.5) < 1e-6)!.pos).toBe(1);
    // extrapolated: 0.5 s before 1.0 is the last beat of the previous bar
    expect(g.find((b) => Math.abs(b.t - 0.5) < 1e-6)!.pos).toBe(3);
    expect(g[0].t).toBeLessThan(-19);
  });

  it("adds subdivisions and accents", () => {
    const g = beatGrid(null, fixed, 3).filter((b) => b.t >= 1 && b.t <= 2.01);
    const ev = clickEvents(g, 2);
    expect(ev.map((e) => e.k)).toEqual([0, 2, 1, 2, 1]);
  });

  it("uses detected downbeats for accents", () => {
    const analysis: any = { rhythm: { beats: [0.5, 1, 1.5, 2, 2.5, 3], downbeats: [1, 3] } };
    const g = beatGrid(analysis, { ...DEFAULT_CLICK, beatsPerBar: 4 }, 3.2, 0);
    expect(g.filter((b) => b.t >= 0.5 && b.t <= 3).map((b) => b.pos)).toEqual([3, 0, 1, 2, 3, 0]);
  });
});

describe("count-in and cues", () => {
  const g = beatGrid(null, fixed, 20);

  it("computes pre-roll for one bar", () => {
    const c = countIn(g, 5.02, 1, 4);
    expect(c.from).toBeCloseTo(5.0);
    expect(c.preRoll).toBeCloseTo(2.0);
  });

  it("places the label two bars before and the count on the bar before", () => {
    const words = expandCues([{ id: "a", t: 5, text: "Verse", count: true }], g, 4);
    expect(words.map((w) => [w.text, +w.t.toFixed(2)])).toEqual([
      ["Verse", 1],
      ["1", 3],
      ["2", 3.5],
      ["3", 4],
      ["4", 4.5],
    ]);
  });
});
