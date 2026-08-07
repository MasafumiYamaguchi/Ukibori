import { describe, expect, it } from "vitest";
import { computeMaskSdf, getMaskSdf, maskFromAscii, sampleMaskSdfAt } from "./mask";

/** read the sdf at an ORIGINAL mask pixel (the grid is padded) */
const at = (sdf: ReturnType<typeof computeMaskSdf>, x: number, y: number): number =>
  sdf.sdf[(y + sdf.pad) * (sdf.width + 2 * sdf.pad) + (x + sdf.pad)];

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
    // hole pixels adjacent to ink are at +0.5
    expect(at(sdf, 2, 1)).toBeCloseTo(0.5, 6);
    expect(at(sdf, 3, 1)).toBeCloseTo(0.5, 6);
    // ink adjacent to the hole is at -0.5
    expect(at(sdf, 1, 1)).toBeCloseTo(-0.5, 6);
    // a solid block's interior is deeper than the edge: the center of a 4x4
    // solid mask is 1.5 from the raster edge
    const deep = computeMaskSdf(maskFromAscii(["####", "####", "####", "####"]));
    expect(at(deep, 1, 1)).toBeCloseTo(-1.5, 6);
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
    const holeX = p.alpha.indexOf(0) % p.width;
    const holeY = Math.floor(p.alpha.indexOf(0) / p.width);
    expect(at(sdf, holeX, holeY)).toBeGreaterThan(0);
    // the stem stays inside (negative)
    expect(at(sdf, 0, 5)).toBeLessThan(0);
  });

  it("handles empty and fully-inked masks without non-finite values", () => {
    const empty = computeMaskSdf(maskFromAscii(["....", "...."]));
    for (let y = 0; y < empty.height; y++) {
      for (let x = 0; x < empty.width; x++) {
        const v = at(empty, x, y);
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
      }
    }
    const solid = computeMaskSdf(maskFromAscii(["###", "###"]));
    for (let y = 0; y < solid.height; y++) {
      for (let x = 0; x < solid.width; x++) {
        const v = at(solid, x, y);
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeLessThan(0);
      }
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

  it("reproduces d = 0 exactly at the raster edges (virtual padding preserved)", () => {
    // a 1x1 ink mask must drop to d = 0 at the footprint edge, not stay at
    // d = -0.5 all the way to the edge
    const sdf = computeMaskSdf(maskFromAscii(["#"]));
    expect(sampleMaskSdfAt(sdf, 0.5, 0.5)).toBeCloseTo(-0.5, 6); // ink center
    expect(sampleMaskSdfAt(sdf, 0.0, 0.5)).toBeCloseTo(0, 6); // left raster edge
    expect(sampleMaskSdfAt(sdf, 1.0, 0.5)).toBeCloseTo(0, 6); // right raster edge
    expect(sampleMaskSdfAt(sdf, 0.5, 0.0)).toBeCloseTo(0, 6); // top raster edge
    expect(sampleMaskSdfAt(sdf, 0.5, 1.0)).toBeCloseTo(0, 6); // bottom raster edge
    expect(sampleMaskSdfAt(sdf, 2.0, 0.5)).toBeGreaterThan(0); // beyond the edge
    expect(sampleMaskSdfAt(sdf, -0.5, 0.5)).toBeGreaterThan(0); // into the padding
  });

  it("computes exact distances to the boundary for corner configurations", () => {
    // (1,1) ink with its cardinals ink and its diagonals empty: the nearest
    // boundary feature is the corner at the diagonal cells' intersection ->
    // sqrt(1/2). The old "nearest opposite-center - 0.5" estimate gave
    // sqrt(2) - 0.5 here.
    const mask = maskFromAscii([".#.", "###", ".#."]);
    const sdf = computeMaskSdf(mask);
    expect(at(sdf, 1, 1)).toBeCloseTo(-Math.SQRT1_2, 6);
    // an edge-adjacent ink pixel stays at -0.5
    expect(at(sdf, 1, 0)).toBeCloseTo(-0.5, 6);
  });
});
