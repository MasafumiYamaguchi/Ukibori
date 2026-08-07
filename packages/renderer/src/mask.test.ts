import { describe, expect, it } from "vitest";
import { computeMaskSdf, getMaskSdf, maskFromAscii, sampleMaskSdfAt } from "./mask";

describe("maskFromAscii", () => {
  it("builds binary alpha from '#' ink", () => {
    const mask = maskFromAscii(["#.", ".#"]);
    expect(mask.width).toBe(2);
    expect(mask.height).toBe(2);
    expect(Array.from(mask.alpha)).toEqual([1, 0, 0, 1]);
  });
});

describe("computeMaskSdf", () => {
  it("is negative inside, positive outside, zero near the boundary", () => {
    // solid 4x4 block with a 2x2 hole: rows "########", "##..####", ...
    const mask = maskFromAscii(["########", "##..####", "##..####", "########"]);
    const sdf = computeMaskSdf(mask);
    // the hole pixels are outside (positive)
    expect(sdf.sdf[1 * 8 + 2]).toBeGreaterThan(0);
    expect(sdf.sdf[1 * 8 + 3]).toBeGreaterThan(0);
    // solid corners are negative
    expect(sdf.sdf[0]).toBeLessThan(0);
    expect(sdf.sdf[3 * 8 + 7]).toBeLessThan(0);
    // ink adjacent to the hole is close to the boundary (small magnitude)
    expect(sdf.sdf[1 * 8 + 1]).toBeLessThan(0);
    expect(Math.abs(sdf.sdf[1 * 8 + 1])).toBeLessThan(1.5);
  });

  it("reflects counters (holes) as positive distances in the P bowl", () => {
    const p = maskFromAscii([
      "#####",
      "#...#",
      "#...#",
      "#####",
      "#....",
      "#....",
    ]);
    const sdf = computeMaskSdf(p);
    const hole = p.alpha.indexOf(0); // first empty pixel = the bowl counter
    expect(sdf.sdf[hole]).toBeGreaterThan(0);
    // the stem stays inside (negative)
    expect(sdf.sdf[5 * p.width + 0]).toBeLessThan(0);
  });

  it("handles empty and fully-inked masks without non-finite values", () => {
    const empty = computeMaskSdf(maskFromAscii(["....", "...."]));
    for (const v of empty.sdf) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
    const solid = computeMaskSdf(maskFromAscii(["###", "###"]));
    for (const v of solid.sdf) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeLessThan(0);
    }
  });

  it("is deterministic and cached per mask object", () => {
    const mask = maskFromAscii(["###", "#.#", "###"]);
    const a = getMaskSdf(mask);
    const b = getMaskSdf(mask);
    expect(a).toBe(b); // same object via the cache
    expect(Array.from(computeMaskSdf(mask).sdf)).toEqual(Array.from(a.sdf));
  });
});

describe("sampleMaskSdfAt", () => {
  it("bilinearly interpolates between mask pixel centers", () => {
    // left column ink, right column empty -> sdf rises across the boundary
    const mask = maskFromAscii(["#.", "#."]);
    const sdf = computeMaskSdf(mask);
    // mask pixel centers at px = 0.5 and 1.5
    expect(sampleMaskSdfAt(sdf, 0.5, 0.5)).toBeLessThan(0);
    expect(sampleMaskSdfAt(sdf, 1.5, 0.5)).toBeGreaterThan(0);
    expect(sampleMaskSdfAt(sdf, 1.0, 0.5)).toBeCloseTo(0, 5);
  });

  it("clamps outside the mask", () => {
    const mask = maskFromAscii(["#."]);
    const sdf = computeMaskSdf(mask);
    expect(Number.isFinite(sampleMaskSdfAt(sdf, -10, 0.5))).toBe(true);
    expect(Number.isFinite(sampleMaskSdfAt(sdf, 50, 0.5))).toBe(true);
  });
});
