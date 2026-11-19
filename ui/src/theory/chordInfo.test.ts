import { describe, expect, it } from "vitest";
import { chordTones, isKnownChord, simplify } from "./chordInfo";

describe("chord knowledge (tonal)", () => {
  it("knows worship chord names and refuses typos", () => {
    for (const c of ["C2", "Cadd9", "Dsus", "Dsus4", "Asus2", "G/B", "D/F#", "Em7", "F#m7b5", "Bbmaj7", "C6", "A7sus4", "C5", "Cm(add9)", "B♭"])
      expect(isKnownChord(c), c).toBe(true);
    for (const c of ["Gfoo", "H7", "", "N.C."]) expect(isKnownChord(c), c).toBe(false);
  });

  it("names a chord's tones", () => {
    expect(chordTones("Cadd9")).toEqual(["C", "E", "G", "D"]);
    expect(chordTones("D/F#")).toContain("F#");
  });

  it("simplifies to the triad the musical way", () => {
    expect(simplify("Cadd9")).toBe("C");
    expect(simplify("Em7")).toBe("Em");
    expect(simplify("F#m7b5")).toBe("F#dim");
    expect(simplify("Dsus4")).toBe("Dsus4");
    expect(simplify("Asus2")).toBe("Asus2");
    expect(simplify("D/F#")).toBe("D/F#");
    expect(simplify("G7/B")).toBe("G/B");
    expect(simplify("C5")).toBe("C5");
    expect(simplify("Gfoo")).toBe("Gfoo");
  });
});
