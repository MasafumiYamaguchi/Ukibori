import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHADOW_BIAS,
  DEFAULT_SHADOW_STEP_SIZE,
  computeRegion,
  renderTargetSize,
  sanitizeDpr,
  scaleShadowOptions,
  viewportRectToDocument,
} from "./coords";

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

describe("scaleShadowOptions", () => {
  it("materializes the renderer defaults for step/bias at 0.5 CSS px", () => {
    expect(scaleShadowOptions({}, 1)).toEqual({ stepSize: 0.5, bias: 0.5 });
    expect(DEFAULT_SHADOW_STEP_SIZE).toBe(0.5);
    expect(DEFAULT_SHADOW_BIAS).toBe(0.5);
  });

  it("scales every configured length by dpr (same CSS-space march)", () => {
    const scaled = scaleShadowOptions({ stepSize: 0.75, bias: 0.4, maxDistance: 120 }, 2);
    expect(scaled).toEqual({ stepSize: 1.5, bias: 0.8, maxDistance: 240 });
    // At dpr 1 the values pass through unchanged.
    expect(scaleShadowOptions({ stepSize: 0.75, bias: 0.4, maxDistance: 120 }, 1)).toEqual({
      stepSize: 0.75,
      bias: 0.4,
      maxDistance: 120,
    });
  });

  it("omits maxDistance when not configured (renderer derives it from the scaled diagonal)", () => {
    expect(scaleShadowOptions({}, 3)).toEqual({ stepSize: 1.5, bias: 1.5 });
    expect("maxDistance" in scaleShadowOptions({}, 3)).toBe(false);
  });

  it("falls back to the CSS-space defaults for invalid configured values", () => {
    expect(scaleShadowOptions({ stepSize: -1, bias: NaN, maxDistance: 0 }, 2)).toEqual({
      stepSize: 1,
      bias: 1,
    });
  });

  // #43: the reconstruction radius is a CSS-pixel LENGTH — scaled once by
  // dpr exactly like step/bias/maxDistance; `enabled` is a boolean forwarded
  // verbatim and the dimensionless edge gates are never scaled.
  it("scales the reconstruction radius by dpr exactly once", () => {
    expect(scaleShadowOptions({ reconstruction: { enabled: true, radius: 2 } }, 1)).toEqual({
      stepSize: 0.5,
      bias: 0.5,
      reconstruction: { enabled: true, radius: 2 },
    });
    expect(
      scaleShadowOptions({ reconstruction: { enabled: true, radius: 2 } }, 2),
    ).toEqual({
      stepSize: 1,
      bias: 1,
      reconstruction: { enabled: true, radius: 4 },
    });
    expect(
      scaleShadowOptions({ reconstruction: { enabled: false, radius: 1.5 } }, 3),
    ).toEqual({
      stepSize: 1.5,
      bias: 1.5,
      reconstruction: { enabled: false, radius: 4.5 },
    });
    // no reconstruction -> no reconstruction key at all (full-replacement
    // option state stays clean)
    expect("reconstruction" in scaleShadowOptions({}, 2)).toBe(false);
  });

  it("forwards only finite non-negative reconstruction radii", () => {
    expect(
      scaleShadowOptions({ reconstruction: { radius: NaN } }, 2).reconstruction,
    ).toEqual({ enabled: undefined, radius: undefined });
    expect(
      scaleShadowOptions({ reconstruction: { radius: -1 } }, 2).reconstruction,
    ).toEqual({ enabled: undefined, radius: undefined });
    expect(
      scaleShadowOptions({ reconstruction: { enabled: false } }, 2).reconstruction,
    ).toEqual({ enabled: false, radius: undefined });
  });
});
