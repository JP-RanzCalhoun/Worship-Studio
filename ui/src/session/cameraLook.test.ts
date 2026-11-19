import { describe, expect, it } from "vitest";
import { BUILT_IN_LOOKS, builtInLut, neutralGains, parseCube } from "./cameraLook";

const NL = String.fromCharCode(10);

describe("camera looks", () => {
  it("reads a .cube LUT (red fastest, domain scaled to 0..1)", () => {
    const lines = ['TITLE "test"', "LUT_3D_SIZE 2", "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1"];
    for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) lines.push(`${r} ${g} ${b}`);
    const lut = parseCube(lines.join(NL));
    expect(lut.size).toBe(2);
    expect(Array.from(lut.data.slice(3, 6))).toEqual([1, 0, 0]); // second entry = red only
    expect(Array.from(lut.data.slice(21, 24))).toEqual([1, 1, 1]);
  });

  it("refuses files that are not 3D LUTs", () => {
    expect(() => parseCube(["LUT_1D_SIZE 4", "0 0 0"].join(NL))).toThrow(/1D/);
    expect(() => parseCube("hello")).toThrow(/3D/);
    expect(() => parseCube(["LUT_3D_SIZE 2", "0 0 0"].join(NL))).toThrow(/8 colours/);
  });

  it("builds every built-in look inside 0..1, keeping white and greys sensible", () => {
    for (const l of BUILT_IN_LOOKS) {
      const lut = builtInLut(l.id, 9);
      expect(lut.data.length).toBe(9 ** 3 * 3);
      expect(Math.min(...lut.data)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...lut.data)).toBeLessThanOrEqual(1);
    }
    const none = builtInLut("none", 9);
    expect(Array.from(none.data.slice(-3))).toEqual([1, 1, 1]); // identity: white stays white
    const bw = builtInLut("bw", 9);
    const i = (4 + 0 * 9 + 8 * 81) * 3; // a strong blue becomes a grey
    expect(bw.data[i]).toBeCloseTo(bw.data[i + 1], 5);
    expect(bw.data[i + 1]).toBeCloseTo(bw.data[i + 2], 5);
  });

  it("colour fix: a pink frame gets more green and less red/blue; blown and dark pixels are ignored", () => {
    const px = new Uint8ClampedArray(4 * 400);
    for (let i = 0; i < 400; i++) {
      const [r, g, b] = i < 300 ? [130, 105, 120] : i < 350 ? [255, 250, 240] : [5, 5, 5];
      px.set([r, g, b, 255], i * 4);
    }
    const [gr, gg, gb] = neutralGains(px);
    expect(gg).toBeGreaterThan(1);
    expect(gr).toBeLessThan(gg);
    expect(gb).toBeLessThan(gg);
    expect(0.2126 * gr + 0.7152 * gg + 0.0722 * gb).toBeCloseTo(1, 2); // same brightness
  });
});
