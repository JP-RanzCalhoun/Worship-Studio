import { describe, expect, it } from "vitest";
import { contextFor, describe as describeChord } from "../chart";
import { spellKey } from "../theory/notes";
import { cleanTitle, stallSeconds } from "./useGetSong";

describe("smoke-test fixes 2026-11-17", () => {
  it("spells keys the way a musician reads them", () => {
    expect(spellKey("D#")).toBe("Eb");
    expect(spellKey("A#")).toBe("Bb");
    expect(spellKey("F#")).toBe("F#");
    expect(spellKey("D#m")).toBe("D#m"); // relative of F#: sharps
    expect(spellKey("not a key")).toBe("not a key");
  });

  it("spells the shape label for the key it is played in", () => {
    const song = { key: "D#", transpose: 0, capo: 0, tuning: "Standard", simpleChords: false, nashvilleMinor: "relative-major" } as any;
    expect(describeChord("D#", contextFor(song, null)).shape).toBe("Eb");
    expect(describeChord("A#", contextFor(song, null)).shape).toBe("Bb");
    // capo 1 in Eb: D shapes, no accidentals
    expect(describeChord("D#", contextFor({ ...song, capo: 1 }, null)).shape).toBe("D");
  });

  it("removes YouTube's hidden direction marks from titles", () => {
    expect(cleanTitle("Mighty To Save (cover) by A & ‪jbobrienmusic‬ - YouTube")).toBe("Mighty To Save (cover) by A & jbobrienmusic");
    expect(cleanTitle("‎ - YouTube")).toBe("Song from video");
  });

  it("measures how long the video stood still while recording", () => {
    const steady = Array.from({ length: 20 }, () => -1.8);
    expect(stallSeconds(steady)).toBe(0);
    const stalled = [...Array(6).fill(-1.8), ...Array(14).fill(-9.6)];
    expect(stallSeconds(stalled)).toBeCloseTo(7.8, 5);
    expect(stallSeconds([-1, -9])).toBe(0); // too few readings to judge
  });
});

import { shownChords } from "../chart";

describe("shown chords", () => {
  const chords = [
    { start: 0, end: 2, chord: "G" },
    { start: 2, end: 4, chord: "C", user: true },
    { start: 4, end: 6, chord: "D", confirmed: true },
  ];
  it("hides detected guesses by default", () => {
    expect(shownChords(chords, false).map((c) => c.chord)).toEqual(["C", "D"]);
  });
  it("shows everything when guesses are asked for", () => {
    expect(shownChords(chords, true)).toHaveLength(3);
  });
});
