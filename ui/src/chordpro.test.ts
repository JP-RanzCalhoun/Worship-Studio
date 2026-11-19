import { describe, expect, it } from "vitest";
import { alignChart, parseChart } from "./chordpro";

describe("chart import", () => {
  it("reads ChordPro with sections and metadata", () => {
    const c = parseChart(`{title: Way Maker}\n{key: E}\n{ccli: 7115744}\n{start_of_verse: Verse 1}\n[E]You are here, [B]moving in our [C#m]midst\n{end_of_verse}\n{start_of_chorus}\n[A]Way maker\n{end_of_chorus}`);
    expect(c.title).toBe("Way Maker");
    expect(c.key).toBe("E");
    expect(c.ccli).toBe("7115744");
    expect(c.sections.map((s) => s.label)).toEqual(["Verse 1", "chorus"]);
    expect(c.sections[0].lines[0]).toEqual({ lyrics: "You are here, moving in our midst", chords: ["E", "B", "C#m"] });
  });

  it("reads chords written over the lyrics", () => {
    const c = parseChart("[Chorus]\nG        D/F#     Em7\nHow great is our God\nC2   Dsus4\nSing with me");
    expect(c.sections[0].label).toBe("Chorus");
    expect(c.sections[0].lines).toEqual([
      { lyrics: "How great is our God", chords: ["G", "D/F#", "Em7"] },
      { lyrics: "Sing with me", chords: ["C2", "Dsus4"] },
    ]);
  });

  it("lines a capo chart up with the detected chords and names them", () => {
    // chart written in G with capo 2 = sounding A
    const chart = parseChart("Verse\nG   Dsus4   Em7\nLine one\nChorus\nC2\nLine two");
    const det = [
      { start: 0, end: 2, chord: "A" },
      { start: 2, end: 4, chord: "E" },
      { start: 4, end: 6, chord: "F#m" },
      { start: 6, end: 8, chord: "D" },
    ];
    const r = alignChart(chart, det as any);
    expect(r.shift).toBe(2);
    expect(r.chords.map((c) => c.chord)).toEqual(["A", "Esus4", "F#m7", "D2"]);
    expect(r.lyrics).toEqual([
      { t: 0, text: "Line one", section: "Verse" },
      { t: 6, text: "Line two", section: "Chorus" },
    ]);
    expect(r.sections.map((s) => [s.label, s.start])).toEqual([
      ["Verse", 0],
      ["Chorus", 6],
    ]);
  });

  it("keeps lyric lines whose chords did not match, placed between their neighbours", () => {
    // the bridge chords (Bb F) are not in the recording: its line is kept, timed between verse and chorus
    const chart = parseChart(`Verse
G   D
Line one
Bridge
Bb   F
Bridge line
Chorus
C   G
Line two`);
    const det = [
      { start: 0, end: 2, chord: "G" },
      { start: 2, end: 4, chord: "D" },
      { start: 8, end: 10, chord: "C" },
      { start: 10, end: 12, chord: "G" },
    ];
    const r = alignChart(chart, det as any);
    expect(r.lyrics.map((l) => l.text)).toEqual(["Line one", "Bridge line", "Line two"]);
    expect(r.estimated).toBe(1);
    expect(r.lyrics[1].t).toBeGreaterThan(0);
    expect(r.lyrics[1].t).toBeLessThan(8);
  });
});
