import { describe, expect, it } from "vitest";
import { HostBuffer } from "./buffer";
import { computeVisibility, prepareShadowContext } from "./shadow";
import {
  ALLOWED_SHADOW_SAMPLES,
  DEFAULT_SHADOW_SAMPLES,
  SHADOW_MAX_SAMPLES,
  computeSoftSampleDirections,
  sanitizeAngularRadius,
  sanitizeShadowSamples,
} from "./shadow-sampling";
import { createScene } from "./scene";
import type { Scene } from "./scene";

/**
 * #41 area-light soft-shadow tests.
 *
 * Fixture: a FLAT receiver plane (z = 0 everywhere) plus a synthetic caster
 * field with a raised slab. The slab height IS the caster/receiver
 * separation, so raising it widens the penumbra ring around the cast
 * shadow.
 */

const LIGHT_FROM_RIGHT = { x: 0.70710678, y: 0, z: 0.70710678 }; // 45 degrees, +x

function flatReceivers(size = 16): HostBuffer {
  // HostBuffer zero-fills by construction; the receiver plane stays z = 0.
  return new HostBuffer({ width: size, height: size, channels: 1, format: "f32" });
}

function slabCaster(size = 16, x0 = 8, x1 = 13, y0 = 6, y1 = 9, top = 6): HostBuffer {
  const buf = new HostBuffer({ width: size, height: size, channels: 1, format: "f32" });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      buf.set(x, y, 0, x >= x0 && x <= x1 && y >= y0 && y <= y1 ? top : 0);
    }
  }
  return buf;
}

function sceneWithLight(
  direction: { x: number; y: number; z: number },
  angularRadius?: number,
): Scene {
  return createScene({
    width: 16,
    height: 16,
    light: { direction, intensity: 1, angularRadius },
  });
}

function toArray(vis: HostBuffer): number[] {
  const out: number[] = [];
  for (let y = 0; y < vis.spec.height; y++) {
    for (let x = 0; x < vis.spec.width; x++) {
      out.push(vis.get(x, y, 0));
    }
  }
  return out;
}

function countPartial(vis: HostBuffer): number {
  return toArray(vis).filter((v) => v > 0 && v < 1).length;
}

describe("shadow-sampling — deterministic cone construction", () => {
  it("sanitizes sample counts to the documented candidates", () => {
    expect(sanitizeShadowSamples(undefined)).toBe(DEFAULT_SHADOW_SAMPLES);
    expect(sanitizeShadowSamples(Number.NaN)).toBe(DEFAULT_SHADOW_SAMPLES);
    expect(sanitizeShadowSamples(3)).toBe(DEFAULT_SHADOW_SAMPLES);
    expect(sanitizeShadowSamples(5.5)).toBe(DEFAULT_SHADOW_SAMPLES);
    expect(sanitizeShadowSamples(32)).toBe(DEFAULT_SHADOW_SAMPLES);
    expect(sanitizeShadowSamples(-8)).toBe(DEFAULT_SHADOW_SAMPLES);
    for (const allowed of ALLOWED_SHADOW_SAMPLES) {
      expect(sanitizeShadowSamples(allowed)).toBe(allowed);
    }
    expect(ALLOWED_SHADOW_SAMPLES).toContain(DEFAULT_SHADOW_SAMPLES);
    expect(Math.max(...ALLOWED_SHADOW_SAMPLES)).toBe(SHADOW_MAX_SAMPLES);
  });

  it("sanitizes the angular radius to a finite non-negative f32", () => {
    expect(sanitizeAngularRadius(undefined)).toBe(0);
    expect(sanitizeAngularRadius(Number.NaN)).toBe(0);
    expect(sanitizeAngularRadius(-1)).toBe(0);
    expect(sanitizeAngularRadius(Infinity)).toBe(0);
    expect(sanitizeAngularRadius(0)).toBe(0);
    expect(sanitizeAngularRadius(0.15)).toBe(Math.fround(0.15));
  });

  it("computes deterministic unit-length directions shared by both backends", () => {
    const dirs = computeSoftSampleDirections(LIGHT_FROM_RIGHT, Math.fround(0.15), 8);
    expect(dirs).toHaveLength(8 * 3);
    for (let i = 0; i < 8; i++) {
      const len = Math.hypot(dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2]);
      // f32 rounding of each component keeps the norm within ~1e-6 of 1.
      expect(Math.abs(len - 1)).toBeLessThan(1e-6);
    }
    const again = computeSoftSampleDirections(LIGHT_FROM_RIGHT, Math.fround(0.15), 8);
    expect(Array.from(dirs)).toEqual(Array.from(again));
  });

  it("collapses to the light direction itself when the radius is zero", () => {
    const dirs = computeSoftSampleDirections(LIGHT_FROM_RIGHT, 0, 4);
    for (let i = 0; i < 4; i++) {
      expect(dirs[i * 3]).toBe(Math.fround(LIGHT_FROM_RIGHT.x));
      expect(dirs[i * 3 + 1]).toBe(Math.fround(LIGHT_FROM_RIGHT.y));
      expect(dirs[i * 3 + 2]).toBe(Math.fround(LIGHT_FROM_RIGHT.z));
    }
  });
});

describe("hard-shadow compatibility (#17 semantics unchanged)", () => {
  it("keeps the hard path byte-identical regardless of the sample count", () => {
    const receivers = flatReceivers();
    const caster = slabCaster();
    const scene = sceneWithLight(LIGHT_FROM_RIGHT); // angularRadius absent -> 0
    const legacy = computeVisibility(scene, receivers, { casterHeight: caster });
    for (const samples of [undefined, 1, 4, 8, 16] as const) {
      const withSamples = computeVisibility(scene, receivers, {
        casterHeight: caster,
        samples,
      });
      expect(toArray(withSamples)).toEqual(toArray(legacy));
    }
    // every texel is exactly lit or occluded
    for (const v of toArray(legacy)) {
      expect(v === 0 || v === 1).toBe(true);
    }
  });

  it("selects the hard path whenever the prepared context has no cone", () => {
    const ctx = prepareShadowContext(sceneWithLight(LIGHT_FROM_RIGHT), flatReceivers(), {
      samples: 16,
    });
    expect(ctx.angularRadius).toBe(0);
    expect(ctx.sampleDirs).toBeNull();
    expect(ctx.samples).toBe(1);
    // an explicit positive radius arms the cone
    const soft = prepareShadowContext(
      sceneWithLight(LIGHT_FROM_RIGHT, 0.15),
      flatReceivers(),
      { samples: 8 },
    );
    expect(soft.angularRadius).toBe(Math.fround(0.15));
    expect(soft.samples).toBe(8);
    expect(soft.sampleDirs).not.toBeNull();
    expect(soft.sampleDirs).toHaveLength(8 * 3);
  });
});

describe("#41 soft visibility on the slab fixture", () => {
  it("produces continuous values in [0, 1] with a real penumbra ring", () => {
    const receivers = flatReceivers();
    const caster = slabCaster();
    const vis = computeVisibility(sceneWithLight(LIGHT_FROM_RIGHT, 0.2), receivers, {
      casterHeight: caster,
      samples: 8,
    });
    const values = toArray(vis);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // a genuine penumbra: strictly intermediate texels exist
    expect(countPartial(vis)).toBeGreaterThan(0);
    // fully occluded core pixels still exist near the caster
    expect(Math.min(...values)).toBe(0);
    // far-lit regions stay exactly lit
    expect(values).toContain(1);
  });

  it("widens the penumbra as the caster/receiver separation grows", () => {
    const receivers = flatReceivers();
    const low = computeVisibility(sceneWithLight(LIGHT_FROM_RIGHT, 0.25), receivers, {
      casterHeight: slabCaster(16, 8, 13, 6, 9, 4),
      samples: 8,
    });
    const high = computeVisibility(sceneWithLight(LIGHT_FROM_RIGHT, 0.25), receivers, {
      casterHeight: slabCaster(16, 8, 13, 6, 9, 10),
      samples: 8,
    });
    expect(countPartial(high)).toBeGreaterThan(countPartial(low));
  });

  it("is deterministic: identical inputs produce identical buffers", () => {
    const receivers = flatReceivers();
    const options = {
      casterHeight: slabCaster(),
      samples: 8 as const,
    };
    const a = computeVisibility(sceneWithLight(LIGHT_FROM_RIGHT, 0.2), receivers, options);
    const b = computeVisibility(sceneWithLight(LIGHT_FROM_RIGHT, 0.2), receivers, options);
    expect(toArray(b)).toEqual(toArray(a));
  });

  it("converges toward the hard result as the radius shrinks", () => {
    const receivers = flatReceivers();
    const caster = slabCaster();
    const sceneHard = sceneWithLight(LIGHT_FROM_RIGHT, 0);
    const hard = toArray(computeVisibility(sceneHard, receivers, { casterHeight: caster }));
    const tiny = toArray(
      computeVisibility(sceneWithLight(LIGHT_FROM_RIGHT, Math.fround(0.01)), receivers, {
        casterHeight: caster,
        samples: 8,
      }),
    );
    let differing = 0;
    for (let i = 0; i < hard.length; i++) {
      if (Math.abs(hard[i] - tiny[i]) > 1e-6) {
        differing += 1;
      }
    }
    // only the penumbra band may differ — most of the plane is identical
    expect(differing).toBeLessThan(hard.length / 4);
  });
});
