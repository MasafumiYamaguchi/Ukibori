import { describe, expect, it } from "vitest";
import { computeRegion, renderTargetSize, sanitizeDpr, viewportRectToDocument } from "./coords";

describe("viewportRectToDocument", () => {
  it("adds page scroll offsets to a viewport rect", () => {
    expect(
      viewportRectToDocument({ left: 10, top: 20, width: 100, height: 40 }, 500, 1200),
    ).toEqual({ x: 510, y: 1220, w: 100, h: 40 });
  });

  it("throws on a non-finite viewport origin", () => {
    expect(() =>
      viewportRectToDocument(
        { left: NaN, top: 0, width: 1, height: 1 },
        0,
        0,
      ),
    ).toThrow(TypeError);
  });
});

describe("computeRegion", () => {
  it("unions boxes and inflates by the margin", () => {
    const region = computeRegion(
      [
        { x: 10, y: 10, w: 50, h: 20 },
        { x: 80, y: 40, w: 10, h: 10 },
      ],
      8,
    );
    expect(region).toEqual({ x: 2, y: 2, w: 96, h: 56 });
  });

  it("returns null when no valid boxes exist", () => {
    expect(computeRegion([], 8)).toBeNull();
    expect(computeRegion([{ x: 0, y: 0, w: 0, h: 10 }], 8)).toBeNull();
    expect(computeRegion([{ x: NaN, y: 0, w: 10, h: 10 }], 8)).toBeNull();
  });

  it("clamps a negative or non-finite margin to zero", () => {
    const box = [{ x: 0, y: 0, w: 10, h: 10 }];
    expect(computeRegion(box, -5)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    expect(computeRegion(box, NaN)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });
});

describe("renderTargetSize", () => {
  it("scales the region by dpr with floor", () => {
    expect(renderTargetSize({ x: 0, y: 0, w: 100.5, h: 60 }, 2)).toEqual({
      width: 201,
      height: 120,
    });
  });

  it("throws when the target would be empty", () => {
    expect(() => renderTargetSize({ x: 0, y: 0, w: 0.2, h: 10 }, 1)).toThrow(RangeError);
  });
});

describe("sanitizeDpr", () => {
  it("falls back to 1 for invalid values", () => {
    expect(sanitizeDpr(NaN)).toBe(1);
    expect(sanitizeDpr(0)).toBe(1);
    expect(sanitizeDpr(-2)).toBe(1);
    expect(sanitizeDpr(undefined)).toBe(1);
    expect(sanitizeDpr(1.5)).toBe(1.5);
  });
});
