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
    expect(scaleShadowOptions({}, 1)).toEqual({
      stepSize: 0.5,
      bias: 0.5,
      reconstruction: { radius: 2, heightGate: 0.5 },
    });
    expect(DEFAULT_SHADOW_STEP_SIZE).toBe(0.5);
    expect(DEFAULT_SHADOW_BIAS).toBe(0.5);
  });

  it("scales every configured length by dpr (same CSS-space march)", () => {
    const scaled = scaleShadowOptions({ stepSize: 0.75, bias: 0.4, maxDistance: 120 }, 2);
    expect(scaled).toEqual({
      stepSize: 1.5,
      bias: 0.8,
      maxDistance: 240,
      reconstruction: { radius: 4, heightGate: 1 },
    });
    // At dpr 1 the values pass through unchanged.
    expect(scaleShadowOptions({ stepSize: 0.75, bias: 0.4, maxDistance: 120 }, 1)).toEqual({
      stepSize: 0.75,
      bias: 0.4,
      maxDistance: 120,
      reconstruction: { radius: 2, heightGate: 0.5 },
    });
  });

  it("omits maxDistance when not configured (renderer derives it from the scaled diagonal)", () => {
    expect(scaleShadowOptions({}, 3)).toEqual({
      stepSize: 1.5,
      bias: 1.5,
      reconstruction: { radius: 6, heightGate: 1.5 },
    });
    expect("maxDistance" in scaleShadowOptions({}, 3)).toBe(false);
  });

  it("falls back to the CSS-space defaults for invalid configured values", () => {
    expect(scaleShadowOptions({ stepSize: -1, bias: NaN, maxDistance: 0 }, 2)).toEqual({
      stepSize: 1,
      bias: 1,
      reconstruction: { radius: 4, heightGate: 1 },
    });
  });

  // #43 CSS-space contract: the layer is the SINGLE place the CSS-space
  // reconstruction policy is enforced (default radius 2 CSS px, clamp
  // [0, 4] CSS px, default gate 0.5 CSS px) and converted to scene units by
  // the dpr similarity transform — so the same CSS scene produces the same
  // CSS-space footprint and edge preservation at every devicePixelRatio.
  it("materializes the CSS-space reconstruction defaults scaled once by dpr", () => {
    // unspecified reconstruction -> the default radius (2 CSS px) and gate
    // (0.5 CSS px) are ALWAYS materialized in scene units (the renderer's
    // own scene-unit default would shrink with dpr if left to it).
    expect(scaleShadowOptions({}, 1)).toEqual({
      stepSize: 0.5,
      bias: 0.5,
      reconstruction: { radius: 2, heightGate: 0.5 },
    });
    expect(scaleShadowOptions({}, 1.5).reconstruction).toEqual({
      radius: 3,
      heightGate: 0.75,
    });
    expect(scaleShadowOptions({}, 2).reconstruction).toEqual({
      radius: 4,
      heightGate: 1,
    });
    // the supported display-DPR range extends to 4: defaults keep scaling
    // (the renderer's texel cap is sized to hold the CSS footprint there)
    expect(scaleShadowOptions({}, 3).reconstruction).toEqual({
      radius: 6,
      heightGate: 1.5,
    });
    expect(scaleShadowOptions({}, 4).reconstruction).toEqual({
      radius: 8,
      heightGate: 2,
    });
  });

  it("clamps the radius in CSS space BEFORE the single dpr scaling", () => {
    // radius 4 CSS px at DPR 2 must stay 4 CSS px: 8 scene units — NOT
    // clamped to 4 scene units (which would silently shrink to 2 CSS px).
    expect(scaleShadowOptions({ reconstruction: { radius: 4 } }, 2).reconstruction).toEqual({
      radius: 8,
      heightGate: 1,
    });
    expect(scaleShadowOptions({ reconstruction: { radius: 99 } }, 1.5).reconstruction).toEqual({
      radius: 6,
      heightGate: 0.75,
    });
    // the CSS-space footprint is DPR-invariant across the supported range
    // [1, 4]: radius/d == 2 at every supported dpr, and a maxed-out
    // 4-CSS-px request keeps its 4-CSS-px footprint too (the renderer's
    // round(4 * 4) = 16-texel cap exists exactly for this)
    for (const dpr of [1, 1.5, 2, 3, 4]) {
      const scaled = scaleShadowOptions({ reconstruction: { radius: 4 } }, dpr).reconstruction!;
      expect(scaled.radius / dpr).toBe(4);
    }
  });

  it("forwards enabled verbatim and falls back to the CSS defaults for invalid radii", () => {
    expect(
      scaleShadowOptions({ reconstruction: { enabled: false } }, 2).reconstruction,
    ).toEqual({ enabled: false, radius: 4, heightGate: 1 });
    expect(
      scaleShadowOptions({ reconstruction: { enabled: true, radius: 1.5 } }, 3).reconstruction,
    ).toEqual({ enabled: true, radius: 4.5, heightGate: 1.5 });
    // NaN / negative radii fall back to the CSS default 2 (scaled once)
    expect(scaleShadowOptions({ reconstruction: { radius: NaN } }, 2).reconstruction).toEqual({
      radius: 4,
      heightGate: 1,
    });
    expect(scaleShadowOptions({ reconstruction: { radius: -1 } }, 2).reconstruction).toEqual({
      radius: 4,
      heightGate: 1,
    });
  });
});
