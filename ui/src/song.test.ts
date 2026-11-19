import { describe, expect, it } from "vitest";
import { fmtTime, sectionAt } from "./chart";
import { mergeChartWithAnalysis } from "./song";

describe("re-analysis merge", () => {
  it("keeps confirmed chords and fills gaps with new estimates", () => {
    const chart = {
      chords: [
        { start: 0, end: 4, chord: "G", confirmed: true },
        { start: 4, end: 8, chord: "Gm", confirmed: false },
      ],
      sections: [{ start: 0, end: 8, label: "A", suggested: true }],
    };
    const analysis: any = {
      chords: [
        { start: 0, end: 3, chord: "Em", confidence: 0.5 },
        { start: 3, end: 8, chord: "C", confidence: 0.6 },
      ],
      sections: [{ start: 0, end: 8, label: "Verse", suggested: true }],
    };
    const m = mergeChartWithAnalysis(chart, analysis);
    expect(m.chords.map((c) => [c.chord, c.start, c.end, !!c.confirmed])).toEqual([
      ["G", 0, 4, true],
      ["C", 4, 8, false],
    ]);
    expect(m.sections[0].label).toBe("Verse"); // all old sections were suggestions
  });

  it("keeps sections the user named", () => {
    const chart = { chords: [], sections: [{ start: 0, end: 8, label: "Chorus", suggested: false }] };
    const m = mergeChartWithAnalysis(chart, { chords: [], sections: [{ start: 0, end: 8, label: "A", suggested: true }] } as any);
    expect(m.sections[0].label).toBe("Chorus");
  });
});

describe("re-analysis merge keeps user work (audit MUSE-UX-03)", () => {
  it("keeps chords the user added or split, even before they are confirmed", () => {
    const chart = {
      chords: [
        { start: 0, end: 2, chord: "G", confirmed: false, user: true },
        { start: 2, end: 8, chord: "C", confirmed: false },
      ],
      sections: [],
    };
    const m = mergeChartWithAnalysis(chart, { chords: [{ start: 0, end: 8, chord: "Em", confidence: 0.5 }], sections: [] } as any);
    expect(m.chords.map((c) => [c.chord, c.start, c.end])).toEqual([
      ["G", 0, 2],
      ["Em", 2, 8],
    ]);
  });

  it("merges sections one by one: user sections stay, suggestions fill the rest", () => {
    const chart = {
      chords: [],
      sections: [
        { start: 0, end: 10, label: "Intro", suggested: true },
        { start: 10, end: 20, label: "Chorus", suggested: false },
      ],
    };
    const analysis: any = {
      chords: [],
      sections: [
        { start: 0, end: 12, label: "A", suggested: true },
        { start: 12, end: 30, label: "B", suggested: true },
      ],
    };
    const m = mergeChartWithAnalysis(chart, analysis);
    expect(m.sections.map((s) => [s.label, s.start, s.end])).toEqual([
      ["A", 0, 10],
      ["Chorus", 10, 20],
      ["B", 20, 30],
    ]);
  });
});

describe("time helpers", () => {
  it("never shows 60 seconds", () => {
    expect(fmtTime(59.96)).toBe("1:00.0");
    expect(fmtTime(119.97)).toBe("2:00.0");
    expect(fmtTime(-0.84)).toBe("-0:00.8");
  });
  it("finds the section a seek lands just before", () => {
    const secs = [{ start: 0, end: 160.102 }, { start: 160.102, end: 291 }];
    expect(sectionAt(secs, 160.07)).toBe(1);
    expect(sectionAt(secs, 100)).toBe(0);
  });
});
