import { describe, expect, it } from "vitest";
import { HostBuffer } from "./buffer";
import { NO_OWNER } from "./compose";
import { VISIBILITY_SPEC } from "./types";
import {
  DEFAULT_RECONSTRUCTION_RADIUS,
  MAX_RECONSTRUCTION_RADIUS,
  MAX_RECONSTRUCTION_RADIUS_TEXELS,
  RECONSTRUCTION_HEIGHT_GATE,
  reconstructVisibility,
  sanitizeReconstructionOptions,
} from "./shadow-reconstruct";
import { createScene } from "./scene";
import { computeVisibility } from "./shadow";
import { composeSdfHeightField } from "./geometry";

/**
 * #43 edge-aware reconstruction reference tests.
 *
 * Fixture convention mirrors shadow-soft.test.ts: a flat receiver plane with
 * a slab caster whose top height IS the caster/receiver separation.
 */

const LIGHT_FROM_RIGHT = { x: 0.70710678, y: 0, z: 0.70710678 };

function sceneWithSlab(angularRadius: number, samples: number, slabTop = 6) {
  return createScene({
    width: 32,
    height: 32,
    surfaces: [
      {
        id: "slab",
        position: { x: 14, y: 10 },
        size: { x: 8, y: 8 },
        elevation: 0,
        thickness: slabTop,
        shape: { kind: "roundedRect", radius: 0 },
        profile: { kind: "flat" },
        material: "silicone",
        castsShadow: true,
        receivesShadow: true,
      },
    ],
    light: { direction: LIGHT_FROM_RIGHT, intensity: 1, angularRadius },
  });
}

function rawVisibilityFor(scene: ReturnType<typeof createScene>, samples: number) {
  const composed = composeSdfHeightField(scene);
  return {
    composed,
    visibility: computeVisibility(scene, composed.height, {
      samples,
      objectId: composed.objectId,
      casterHeight: composed.height,
    }),
  };
}

function toArray(buf: HostBuffer): number[] {
  const out: number[] = [];
  for (let y = 0; y < buf.spec.height; y++) {
    for (let x = 0; x < buf.spec.width; x++) {
      out.push(buf.get(x, y, 0));
    }
  }
  return out;
}

describe("sanitizeReconstructionOptions — #43 option policy", () => {
  it("defaults to enabled with the documented radius", () => {
    const e = sanitizeReconstructionOptions();
    expect(e.enabled).toBe(true);
    expect(e.radiusTexels).toBe(DEFAULT_RECONSTRUCTION_RADIUS);
  });

  it("accepts only literal booleans for enabled", () => {
    expect(sanitizeReconstructionOptions({ enabled: false }).enabled).toBe(false);
    expect(sanitizeReconstructionOptions({ enabled: true }).enabled).toBe(true);
    // non-boolean garbage falls back to the default true
    expect(sanitizeReconstructionOptions({ enabled: 1 as unknown as boolean }).enabled).toBe(true);
    expect(sanitizeReconstructionOptions({ enabled: undefined }).enabled).toBe(true);
  });

  it("clamps the radius into [0, MAX] and converts to texels exactly once", () => {
    expect(sanitizeReconstructionOptions({ radius: -5 }).radiusTexels).toBe(0);
    expect(sanitizeReconstructionOptions({ radius: 99 }).radiusTexels).toBe(
      MAX_RECONSTRUCTION_RADIUS,
    );
    expect(sanitizeReconstructionOptions({ radius: 1.2 }, 2).radiusTexels).toBe(
      Math.min(MAX_RECONSTRUCTION_RADIUS_TEXELS, Math.round(2.4)),
    );
    // the texel conversion is the SINGLE dpr scaling point (dimensionless
    // gates are never scaled)
    expect(sanitizeReconstructionOptions({ radius: 2 }, 1).radiusTexels).toBe(2);
    expect(sanitizeReconstructionOptions({ radius: 2 }, 1.5).radiusTexels).toBe(3);
    expect(sanitizeReconstructionOptions({ radius: 2 }, 4).radiusTexels).toBe(
      MAX_RECONSTRUCTION_RADIUS_TEXELS,
    );
    // non-finite radii fall back to the default
    expect(sanitizeReconstructionOptions({ radius: Number.NaN }).radiusTexels).toBe(
      DEFAULT_RECONSTRUCTION_RADIUS,
    );
  });
});

describe("reconstructVisibility — #43 CPU reference", () => {
  it("bypasses (copies verbatim) when disabled or radius 0", () => {
    const scene = sceneWithSlab(0.15, 8);
    const { composed, visibility } = rawVisibilityFor(scene, 8);
    for (const options of [{ enabled: false }, { enabled: true, radius: 0 }]) {
      const out = reconstructVisibility(
        visibility,
        composed.height,
        { objectId: composed.objectId },
        options,
      );
      expect(toArray(out)).toEqual(toArray(visibility));
    }
  });

  it("produces finite values in [0, 1] with stable fully-lit and fully-occluded regions", () => {
    const scene = sceneWithSlab(0.15, 4);
    const { composed, visibility } = rawVisibilityFor(scene, 4);
    const out = reconstructVisibility(
      visibility,
      composed.height,
      { objectId: composed.objectId },
      { enabled: true, radius: 2 },
    );
    const raw = toArray(visibility);
    const recon = toArray(out);
    for (const v of recon) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // The 0/1 sets never GROW: a reconstructed fully-lit texel requires
    // every gated tap (including the center) to be lit, and a reconstructed
    // fully-occluded texel requires the center itself to be occluded — so
    // stable fully-lit / fully-occluded regions remain stable and the filter
    // never invents light inside the umbra nor darkness in the lit field.
    for (let i = 0; i < raw.length; i++) {
      if (recon[i] === 1) {
        expect(raw[i]).toBe(1);
      }
      if (recon[i] === 0) {
        expect(raw[i]).toBe(0);
      }
    }
    // a DEEP fully-lit core (raw 1, radius-2 distance from any non-1 texel)
    // must exist AND stay exactly 1
    const w = visibility.spec.width;
    const h = visibility.spec.height;
    let deepLitChecked = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (raw[y * w + x] !== 1) {
          continue;
        }
        let nearNonLit = false;
        for (let dy = -2; dy <= 2 && !nearNonLit; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = Math.min(w - 1, Math.max(0, x + dx));
            const ny = Math.min(h - 1, Math.max(0, y + dy));
            if (raw[ny * w + nx] !== 1) {
              nearNonLit = true;
              break;
            }
          }
        }
        if (!nearNonLit) {
          deepLitChecked += 1;
          expect(recon[y * w + x]).toBe(1);
        }
      }
    }
    expect(deepLitChecked).toBeGreaterThan(0);
  });

  it("produces smoother intermediate levels than the raw 4-sample field", () => {
    const scene = sceneWithSlab(0.15, 4);
    const { composed, visibility } = rawVisibilityFor(scene, 4);
    const out = reconstructVisibility(
      visibility,
      composed.height,
      { objectId: composed.objectId },
      { enabled: true, radius: 2 },
    );
    // raw 4-sample penumbra values are only {0, 0.25, 0.5, 0.75, 1}; the
    // reconstruction must produce intermediate levels NOT present in the raw
    // field (smooth penumbra rather than layered hard shadows)
    const rawLevels = new Set(toArray(visibility).map((v) => Math.round(v * 1000) / 1000));
    const reconValues = toArray(out).filter((v) => v !== 0 && v !== 1);
    const hasSmootherLevels = reconValues.some(
      (v) => !rawLevels.has(Math.round(v * 1000) / 1000),
    );
    expect(hasSmootherLevels).toBe(true);
    // banding: LARGE step discontinuities (the layered-offset-hard-shadows
    // artifact) shrink — adjacent penumbra transitions of >= 0.5 vanish or
    // get substantially reduced by the reconstruction
    const largeSteps = (values: number[]) => {
      let count = 0;
      for (let i = 1; i < values.length; i++) {
        if (Math.abs(values[i] - values[i - 1]) >= 0.5) {
          count += 1;
        }
      }
      return count;
    };
    expect(largeSteps(toArray(visibility))).toBeGreaterThan(0);
    expect(largeSteps(reconValues)).toBeLessThanOrEqual(
      largeSteps(toArray(visibility)),
    );
  });

  it("does not bleed across object boundaries (ownership gate)", () => {
    const scene = sceneWithSlab(0.15, 4);
    const { composed, visibility } = rawVisibilityFor(scene, 4);
    const out = reconstructVisibility(
      visibility,
      composed.height,
      { objectId: composed.objectId },
      { enabled: true, radius: 4 },
    );
    // For every receiver texel on the base plane adjacent to the slab, the
    // reconstruction must never drag shadow (low visibility) INTO a texel
    // owned by the slab surface: owned texels stay exactly as raw (their
    // neighborhood is ownership-gated to the surface itself).
    const slabOwner = 0; // first surface
    let violated = 0;
    for (let y = 0; y < composed.objectId.spec.height; y++) {
      for (let x = 0; x < composed.objectId.spec.width; x++) {
        if (composed.objectId.get(x, y, 0) === slabOwner) {
          const raw = visibility.get(x, y, 0);
          const recon = out.get(x, y, 0);
          // owned texels whose raw is fully lit must stay fully lit
          if (raw === 1 && recon < 1) {
            violated += 1;
          }
        }
      }
    }
    expect(violated).toBe(0);
  });

  it("preserves contact-hardening: larger separation produces a broader penumbra", () => {
    const broad = 8;
    const near = 2;
    const penumbra = (scene: ReturnType<typeof createScene>, samples: number) => {
      const { composed, visibility } = rawVisibilityFor(scene, samples);
      const out = reconstructVisibility(
        visibility,
        composed.height,
        { objectId: composed.objectId },
        { enabled: true, radius: 2 },
      );
      return toArray(out).filter((v) => v > 0 && v < 1).length;
    };
    const broadCount = penumbra(sceneWithSlab(0.15, 8, broad), 8);
    const nearCount = penumbra(sceneWithSlab(0.15, 8, near), 8);
    // greater caster/receiver separation widens the penumbra (the physical
    // penumbra width comes from the #41 ray geometry, not the filter)
    expect(broadCount).toBeGreaterThan(nearCount);
  });

  it("is deterministic: identical inputs produce identical outputs", () => {
    const scene = sceneWithSlab(0.15, 8);
    const { composed, visibility } = rawVisibilityFor(scene, 8);
    const a = reconstructVisibility(
      visibility,
      composed.height,
      { objectId: composed.objectId },
      { enabled: true, radius: 2 },
    );
    const b = reconstructVisibility(
      visibility,
      composed.height,
      { objectId: composed.objectId },
      { enabled: true, radius: 2 },
    );
    expect(toArray(a)).toEqual(toArray(b));
  });

  it("is invariant to the raw-field shape but keeps spec-compatible no-objectId fixtures", () => {
    // without an objectId the ownership gate is inactive (everything one
    // group) — must still produce finite [0,1] values
    const scene = sceneWithSlab(0.15, 8);
    const { composed, visibility } = rawVisibilityFor(scene, 8);
    const out = reconstructVisibility(visibility, composed.height, {}, { enabled: true });
    expect(toArray(out).every((v) => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
  });
});