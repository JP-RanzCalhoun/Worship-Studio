import { describe, expect, it } from "vitest";
import { fromNashville, nashville, parseChord, transposeSymbol, chordName } from "./chords";
import { cagedPositions, cagedShapes, parseTuning, shapeFor, suggestCapos, TUNINGS, uniformShift } from "./guitar";
import { keyName, parseKey } from "./notes";

const key = (k: string) => parseKey(k)!;
const chord = (c: string) => parseChord(c)!;
const STD = TUNINGS[0];

describe("chords", () => {
  it("parses slash chords and suffixes", () => {
    expect(chord("D/F#")).toEqual({ root: 2, suffix: "", bass: 6 });
    expect(chord("Bbmaj7")).toEqual({ root: 10, suffix: "maj7", bass: null });
    expect(parseChord("H7")).toBeNull();
  });

  it("transposes with key-appropriate spelling", () => {
    expect(transposeSymbol("G", 3, key("Bb"))).toBe("Bb");
    expect(transposeSymbol("D/F#", 2, key("E"))).toBe("E/G#");
    expect(transposeSymbol("Em7", 1, key("F"))).toBe("Fm7");
  });
});

describe("nashville", () => {
  it("numbers major-key chords", () => {
    const k = key("G");
    expect(["G", "C", "D", "Em", "D/F#", "Cmaj7", "F"].map((c) => nashville(chord(c), k))).toEqual([
      "1", "4", "5", "6m", "5/7", "4Δ7", "b7",
    ]);
  });

  it("numbers minor keys from the relative major by default", () => {
    expect(nashville(chord("Am"), key("Am"))).toBe("6m");
    expect(nashville(chord("Am"), key("Am"), "minor-tonic")).toBe("1m");
  });

  it("round-trips numbers to chords", () => {
    const k = key("Eb");
    for (const c of ["Eb", "Ab", "Bb/D", "Cm7", "Db"]) {
      expect(chordName(fromNashville(nashville(chord(c), k), k)!, true)).toBe(c);
    }
  });
});

describe("guitar", () => {
  it("finds the shape to play under a capo", () => {
    // Song in A, capo 2 -> G shapes.
    expect(shapeFor(chord("A"), 2, STD)!.shapeName).toBe("G");
    expect(shapeFor(chord("F#m"), 2, STD)!.shapeName).toBe("Em");
    expect(shapeFor(chord("E/G#"), 2, STD)!.shapeName).toBe("D/F#");
  });

  it("treats Eb tuning like a capo of -1", () => {
    const eb = TUNINGS[1];
    expect(uniformShift(eb)).toBe(-1);
    expect(shapeFor(chord("Eb"), 0, eb)!.shapeName).toBe("E");
  });

  it("re-frets standard shapes for non-uniform tunings", () => {
    const dropD = TUNINGS.find((t) => t.name.startsWith("Drop D"))!;
    const d = shapeFor(chord("D"), 0, dropD)!;
    expect(d.adapted).toBe(false); // xx0232 does not use the low string: same shape, not "adapted"
    expect(d.shape!.frets).toEqual([-1, -1, 0, 2, 3, 2]);
    const g = shapeFor(chord("G"), 0, dropD)!;
    expect(g.adapted).toBe(true);
    expect(g.shape!.frets).toEqual([5, 2, 0, 0, 0, 3]); // low D string fretted 2 higher to stay G
  });

  it("ranks capo options by open shapes", () => {
    // Song in Bb: capo 3 -> G shapes is the classic answer.
    const opts = suggestCapos(["Bb", "Eb", "F", "Gm"], key("Bb"), STD);
    expect(opts[0]).toMatchObject({ capo: 3, shapeKey: "G", openCount: 4 });
  });

  it("lists CAGED positions", () => {
    expect(cagedPositions(chord("G"))).toEqual([
      { form: "G", fret: 0 },
      { form: "E", fret: 3 },
      { form: "D", fret: 5 },
      { form: "C", fret: 7 },
      { form: "A", fret: 10 },
    ]);
  });

  it("parses custom tunings", () => {
    expect(parseTuning("D A D G B E")!.strings).toEqual([38, 45, 50, 55, 59, 64]);
    expect(parseTuning("C G C F A D")!.strings).toEqual([36, 43, 48, 53, 57, 62]);
    expect(keyName(key("f#m"))).toBe("F#m");
  });

  it("builds CAGED diagrams moved up the neck", () => {
    const a = cagedShapes(chord("A"));
    expect(a.find((x) => x.form === "A")!.shape.frets).toEqual([-1, 0, 2, 2, 2, 0]);
    expect(a.find((x) => x.form === "E")!.shape.frets).toEqual([5, 7, 7, 6, 5, 5]);
    expect(a.find((x) => x.form === "G")!.shape.frets).toEqual([5, 4, 2, 2, 2, 5]);
    const bm = cagedShapes(chord("Bm7"));
    expect(bm.every((x) => x.triadOnly)).toBe(true);
    expect(bm.find((x) => x.form === "A")!.shape.frets).toEqual([-1, 2, 4, 4, 3, 2]);
  });
});

describe("sharp keys (audit MUSE-UX-05)", () => {
  it("writes F# major and D#m with sharps, Db with flats", () => {
    expect(keyName({ tonic: 6, minor: false })).toBe("F#");
    expect(keyName({ tonic: 1, minor: false })).toBe("Db");
    expect(keyName({ tonic: 1, minor: true })).toBe("C#m");
  });
});
