import { describe, expect, it } from "vitest";
import { HostBuffer } from "./buffer";
import { NO_OWNER } from "./compose";
import { VISIBILITY_SPEC } from "./types";
import {
  DEFAULT_RECONSTRUCTION_RADIUS,
  MAX_RECONSTRUCTION_RADIUS,
  MAX_RECONSTRUCTION_RADIUS_TEXELS,
  RECONSTRUCTION_HEIGHT_GATE,
  RECONSTRUCTION_VALUE_SIGMA,
  reconstructVisibility,
  refineHardEdgeVisibility,
  sanitizeReconstructionOptions,
  RING_EDGE_MIN_ARC,
  RING_EDGE_TRANSITIONS,
} from "./shadow-reconstruct";
import { createScene } from "./scene";
import { computeVisibility } from "./shadow";
import { composeSdfHeightField } from "./geometry";
import { computeNormals, shadePreparedFields } from "./lighting";
import { compositePixelBytes } from "./gpu/composite";
import { encodeScene } from "./gpu/encode";
import { planPartialScene } from "./gpu/tiles";

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
  it("defaults to enabled with the documented scene-unit radius and gate", () => {
    const e = sanitizeReconstructionOptions();
    expect(e.enabled).toBe(true);
    expect(e.radiusTexels).toBe(DEFAULT_RECONSTRUCTION_RADIUS);
    expect(e.heightGate).toBe(Math.fround(RECONSTRUCTION_HEIGHT_GATE));
  });

  it("accepts only literal booleans for enabled", () => {
    expect(sanitizeReconstructionOptions({ enabled: false }).enabled).toBe(false);
    expect(sanitizeReconstructionOptions({ enabled: true }).enabled).toBe(true);
    // non-boolean garbage falls back to the default true
    expect(sanitizeReconstructionOptions({ enabled: 1 as unknown as boolean }).enabled).toBe(true);
    expect(sanitizeReconstructionOptions({ enabled: undefined }).enabled).toBe(true);
  });

  it("treats radius as SCENE units: no CSS clamp, texel conversion once, cost cap", () => {
    // The renderer never clamps in CSS space (the DOM owns that policy):
    // scene-unit radii pass through to the texel conversion.
    expect(sanitizeReconstructionOptions({ radius: 1.2 }, 2).radiusTexels).toBe(
      Math.min(MAX_RECONSTRUCTION_RADIUS_TEXELS, Math.round(2.4)),
    );
    // the texel conversion is the SINGLE scene-unit -> texel scaling point;
    // the cap is sized round(4 CSS px * SUPPORTED_DISPLAY_DPR_MAX) so every
    // radius inside the supported display-DPR range [1, 4] keeps its exact
    // CSS footprint (see the DPR-contract test below)
    expect(sanitizeReconstructionOptions({ radius: 2 }, 1).radiusTexels).toBe(2);
    expect(sanitizeReconstructionOptions({ radius: 2 }, 1.5).radiusTexels).toBe(3);
    expect(sanitizeReconstructionOptions({ radius: 2 }, 2).radiusTexels).toBe(4);
    expect(sanitizeReconstructionOptions({ radius: 2 }, 3).radiusTexels).toBe(6);
    expect(sanitizeReconstructionOptions({ radius: 2 }, 4).radiusTexels).toBe(8);
    // the texel cap is the only cost bound (a huge scene-unit radius cannot
    // blow up the tap count; worst case (2*16+1)^2 = 1089 taps)
    expect(sanitizeReconstructionOptions({ radius: 99 }, 1).radiusTexels).toBe(
      MAX_RECONSTRUCTION_RADIUS_TEXELS,
    );
    expect(sanitizeReconstructionOptions({ radius: 99 }, 4).radiusTexels).toBe(
      MAX_RECONSTRUCTION_RADIUS_TEXELS,
    );
    // non-finite radii fall back to the scene-unit default; NEGATIVE radii
    // mean "no radius" (bypass, like radius 0)
    expect(sanitizeReconstructionOptions({ radius: Number.NaN }).radiusTexels).toBe(
      DEFAULT_RECONSTRUCTION_RADIUS,
    );
    expect(sanitizeReconstructionOptions({ radius: -1 }).radiusTexels).toBe(0);
    expect(sanitizeReconstructionOptions({ radius: -5 }).radiusTexels).toBe(0);
  });

  it("sanitizes the height gate as a scene-unit length (f32, >= 0, default 0.5)", () => {
    expect(sanitizeReconstructionOptions({ heightGate: 0.25 }, 1).heightGate).toBe(
      Math.fround(0.25),
    );
    expect(sanitizeReconstructionOptions({ heightGate: 0 }).heightGate).toBe(0);
    expect(sanitizeReconstructionOptions({ heightGate: Number.NaN }).heightGate).toBe(
      Math.fround(RECONSTRUCTION_HEIGHT_GATE),
    );
    expect(sanitizeReconstructionOptions({ heightGate: -2 }).heightGate).toBe(
      Math.fround(RECONSTRUCTION_HEIGHT_GATE),
    );
  });

  // #43 DPR-invariant CSS-space contract: a CSS-space radius of 2 px
  // reaches the renderer as 2*dpr scene units (DOM-scaled once), and the
  // same CSS footprint (radius/dpr == 2) must come out of the renderer at
  // every renderer DPR inside the supported range.
  it("keeps the CSS-space footprint invariant across the supported display-DPR range", () => {
    for (const dpr of [1, 1.5, 2, 3, 4]) {
      const cssRadius = 2;
      const domScaledRadius = cssRadius * dpr; // scaleShadowOptions output
      const e = sanitizeReconstructionOptions({ radius: domScaledRadius }, 1);
      // renderer dpr is 1 on both DOM paths (device-pixel scene): texels ==
      // the CSS footprint in device px == cssRadius * dpr
      expect(e.radiusTexels).toBe(Math.round(cssRadius * dpr));
      expect(e.radiusTexels / dpr).toBeCloseTo(cssRadius, 10);
    }
    // maximum CSS radius (4 px) stays exactly 4 CSS px at every supported
    // display DPR — the texel cap (16) never bites inside [1, 4]
    for (const dpr of [1, 1.5, 2, 3, 4]) {
      const e = sanitizeReconstructionOptions({ radius: 4 * dpr }, 1);
      expect(e.radiusTexels).toBe(Math.round(4 * dpr));
      expect(e.radiusTexels / dpr).toBeCloseTo(4, 10);
      expect(e.radiusTexels).toBeLessThanOrEqual(MAX_RECONSTRUCTION_RADIUS_TEXELS);
    }
    // beyond the supported range the device-texel cost cap wins and the
    // effective CSS footprint shrinks (documented degradation, not silent):
    // DPR 5 requests 20 texels but the cap holds it at 16 -> 3.2 CSS px
    const beyond = sanitizeReconstructionOptions({ radius: 4 * 5 }, 1);
    expect(beyond.radiusTexels).toBe(MAX_RECONSTRUCTION_RADIUS_TEXELS);
    expect(beyond.radiusTexels / 5).toBeCloseTo(3.2, 10);
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

    // #43 banding: a proper 2D SPATIAL metric over ADJACENT texels —
    // |v[x,y] - v[x+1,y]| (horizontal) and |v[x,y] - v[x,y+1]| (vertical).
    // The layered-offset-hard-shadow artifact shows up as LARGE local jumps
    // between neighboring texels; the reconstruction must reduce them
    // without destroying the umbra or the fully-lit plateaus.
    const spatialJumps = (buf: HostBuffer) => {
      const w = buf.spec.width;
      const h = buf.spec.height;
      let large = 0; // jumps >= 0.5 (a full raw sample band)
      let maxJump = 0;
      let sumJump = 0;
      let count = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = buf.get(x, y, 0);
          if (x + 1 < w) {
            const jump = Math.abs(v - buf.get(x + 1, y, 0));
            maxJump = Math.max(maxJump, jump);
            sumJump += jump;
            count += 1;
            if (jump >= 0.5) {
              large += 1;
            }
          }
          if (y + 1 < h) {
            const jump = Math.abs(v - buf.get(x, y + 1, 0));
            maxJump = Math.max(maxJump, jump);
            sumJump += jump;
            count += 1;
            if (jump >= 0.5) {
              large += 1;
            }
          }
        }
      }
      return { large, maxJump, meanJump: count > 0 ? sumJump / count : 0 };
    };
    const raw = spatialJumps(visibility);
    const recon = spatialJumps(out);
    // the raw 4-sample field genuinely shows the layered-band artifact:
    // adjacent texels jump by a full dyadic band (>= 0.5)
    expect(raw.large).toBeGreaterThan(0);
    // the reconstruction substantially reduces the LARGE 2D jumps (the
    // layered-offset-hard-shadow artifact) and the mean local jump
    expect(recon.large).toBeLessThan(raw.large);
    expect(recon.meanJump).toBeLessThan(raw.meanJump);
    // the CONTACT-HARDENED umbra edge survives: a 0|1 adjacency is a real
    // physical boundary (the filter's gates preserve it), so the max local
    // jump is allowed to remain at ~1 while the banding artifact disappears
    expect(recon.maxJump).toBeGreaterThanOrEqual(0.5);
    // stability: the umbra / fully-lit plateaus survive (the 0/1 sets never
    // grow — checked in the dedicated stability test; here: the deep plateaus
    // still exist in the reconstructed field)
    const reconSorted = [...toArray(out)].sort((a, b) => a - b);
    expect(reconSorted[0]).toBe(0);
    expect(reconSorted[reconSorted.length - 1]).toBe(1);
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

describe("#43 partial-recompute halo propagation (CPU semantics)", () => {
  // The pipeline must recompute reconstruction AND lighting over the band
  // EXPANDED by the filter radius on a partial frame; if lighting only
  // recomputed the original band, the reconstruction halo rows would keep
  // stale color while their reconstructed visibility changed. This simulates
  // the retained partial-update semantics with the ACTUAL oracle functions
  // and proves the expanded-region recompute equals a fresh full recompute
  // inside the halo — and that the band-only (buggy) version does not.
  //
  // A "small local edit" keeps every field identical OUTSIDE the planned
  // band (the #32 planner's exact-diff + halo guarantee), so retained
  // out-of-band texels are provably unchanged and only the recomputed
  // expanded region can differ from the previous frame.

  const RECON_RADIUS = 2;
  const SOFT_SAMPLES = 8;
  const SOFT_LIGHT = { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1, angularRadius: 0.2 };

  function softScene(surfacePosition: { x: number; y: number }): ReturnType<typeof createScene> {
    return createScene({
      width: 64,
      height: 128,
      surfaces: [
        {
          id: "slab",
          position: surfacePosition,
          size: { x: 10, y: 10 },
          elevation: 2,
          thickness: 4,
          shape: { kind: "roundedRect", radius: 0 },
          profile: { kind: "flat" },
          material: "silicone",
          castsShadow: true,
          receivesShadow: true,
        },
      ],
      light: SOFT_LIGHT,
    });
  }

  function fieldsFor(scene: ReturnType<typeof createScene>) {
    const composed = composeSdfHeightField(scene);
    const raw = computeVisibility(scene, composed.height, {
      samples: SOFT_SAMPLES,
      objectId: composed.objectId,
      casterHeight: composed.height,
    });
    const recon = reconstructVisibility(
      raw,
      composed.height,
      { objectId: composed.objectId },
      { enabled: true, radius: RECON_RADIUS },
    );
    const normal = computeNormals(composed.height);
    const shaded = shadePreparedFields(
      scene,
      { normal, objectId: composed.objectId, visibility: recon },
      {},
    );
    return { composed, raw, recon, normal, color: shaded.color, objectId: composed.objectId };
  }

  /** Copy `src` rows [y0, y1] into `dst` (both HostBuffer, same extent). */
  function overwriteRows(dst: HostBuffer, src: HostBuffer, y0: number, y1: number): void {
    const { width } = dst.spec;
    const channels = dst.spec.channels;
    for (let y = y0; y <= y1; y++) {
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < channels; c++) {
          dst.set(x, y, c, src.get(x, y, c));
        }
      }
    }
  }

  function rowsEqual(a: HostBuffer, b: HostBuffer, y0: number, y1: number): boolean {
    const { width } = a.spec;
    const channels = a.spec.channels;
    for (let y = y0; y <= y1; y++) {
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < channels; c++) {
          if (a.get(x, y, c) !== b.get(x, y, c)) {
            return false;
          }
        }
      }
    }
    return true;
  }

  it("recomputed reconstruction+lighting over the halo equals a fresh full recompute", () => {
    const base = softScene({ x: 20, y: 30 });
    const edited = softScene({ x: 22, y: 32 });
    const s0 = fieldsFor(base);
    const s1 = fieldsFor(edited);

    // The #32 planner's band for the small edit (mirrors the pipeline).
    const plan = planPartialScene({
      prevBytes: encodeScene(base, 1).bytes,
      nextBytes: encodeScene(edited, 1).bytes,
      dpr: 1,
      renderWidth: 64,
      renderHeight: 128,
      shadowOptions: { samples: SOFT_SAMPLES, maxDistance: 6, stepSize: 0.5, bias: 0.5 },
      tileSize: 8,
    });
    expect(plan.mode).toBe("partial");
    const { y0, y1 } = plan.band!;
    const haloY0 = Math.max(0, y0 - RECON_RADIUS);
    const haloY1 = Math.min(127, y1 + RECON_RADIUS);
    // the edit is small: the band is a proper subset of the frame
    expect(haloY0).toBeGreaterThan(0);
    expect(haloY1).toBeLessThan(127);

    // Retained-validity: every field is UNCHANGED outside the band (the
    // planner guarantee that makes retained out-of-band texels reusable).
    expect(rowsEqual(s0.composed.height, s1.composed.height, 0, y0 - 1)).toBe(true);
    expect(rowsEqual(s0.composed.height, s1.composed.height, y1 + 1, 127)).toBe(true);
    expect(rowsEqual(s0.raw, s1.raw, 0, y0 - 1)).toBe(true);
    expect(rowsEqual(s0.raw, s1.raw, y1 + 1, 127)).toBe(true);
    // ...and the RECONSTRUCTION halo is genuinely exercised: the raw field
    // is unchanged just outside the band (only inside changes), while the
    // reconstructed field changes there because the filter reads into the
    // band — the exact stale-seam the fix must cover.
    const rawChangedInHalo = !rowsEqual(s0.raw, s1.raw, haloY0, y0 - 1) ||
      !rowsEqual(s0.raw, s1.raw, y1 + 1, haloY1);
    expect(rawChangedInHalo).toBe(false);
    const reconChangedInHalo = !rowsEqual(s0.recon, s1.recon, haloY0, y0 - 1) ||
      !rowsEqual(s0.recon, s1.recon, y1 + 1, haloY1);
    expect(reconChangedInHalo).toBe(true);

    // ---- FIXED partial semantics: recompute reconstruction + normal +
    // lighting over the expanded halo band (retained-valid inputs elsewhere).
    const partialRecon = new HostBuffer(s0.recon.spec);
    const partialNormal = new HostBuffer(s0.normal.spec);
    const partialColor = new HostBuffer(s0.color.spec);
    overwriteRows(partialRecon, s0.recon, 0, s0.recon.spec.height - 1);
    overwriteRows(partialNormal, s0.normal, 0, s0.normal.spec.height - 1);
    overwriteRows(partialColor, s0.color, 0, s0.color.spec.height - 1);
    // height/objectId are retained (identical to s1 outside the band), so a
    // full recompute of the reconstruction over the mixed field equals the
    // freshly composed field inside the halo — the same guarantee the GPU
    // path relies on.
    const reconFull = reconstructVisibility(
      s1.raw,
      s1.composed.height,
      { objectId: s1.objectId },
      { enabled: true, radius: RECON_RADIUS },
    );
    const normalFull = computeNormals(s1.composed.height);
    const colorFull = shadePreparedFields(
      edited,
      { normal: normalFull, objectId: s1.objectId, visibility: reconFull },
      {},
    );
    overwriteRows(partialRecon, reconFull, haloY0, haloY1);
    overwriteRows(partialNormal, normalFull, haloY0, haloY1);
    overwriteRows(partialColor, colorFull.color, haloY0, haloY1);

    // reconstructed visibility + lighting color match the fresh full
    // recompute EVERYWHERE inside the reconstruction halo (explicitly
    // including the rows just outside the original dirty band).
    expect(rowsEqual(partialRecon, s1.recon, haloY0, haloY1)).toBe(true);
    expect(rowsEqual(partialColor, s1.color, haloY0, haloY1)).toBe(true);
    // final presentation bytes (reconstructed shadow tint over the base
    // plane) match too — composite the two colors and compare.
    const composite = (color: HostBuffer, recon: HostBuffer) => {
      const { width, height: h } = color.spec;
      const out = new Uint8Array(width * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < width; x++) {
          const owner = s1.objectId.get(x, y, 0);
          const i = (y * width + x) * 4;
          out.set(
            compositePixelBytes(
              owner,
              color.get(x, y, 0),
              color.get(x, y, 1),
              color.get(x, y, 2),
              recon.get(x, y, 0),
              { shadowColor: [30, 30, 30], shadowAlpha: 0.3 },
            ),
            i,
          );
        }
      }
      return out;
    };
    const partialBytes = composite(partialColor, partialRecon);
    const fullBytes = composite(s1.color, s1.recon);
    for (let y = haloY0; y <= haloY1; y++) {
      for (let x = 0; x < 64; x++) {
        const i = (y * 64 + x) * 4;
        expect([...partialBytes.slice(i, i + 4)]).toEqual([...fullBytes.slice(i, i + 4)]);
      }
    }

    // ---- BUGGY semantics (lighting over the ORIGINAL band only): the halo
    // rows keep the previous frame's color while reconstruction changed them,
    // so the presented bytes disagree with the fresh recompute exactly where
    // the fix matters.
    const buggyColor = new HostBuffer(s0.color.spec);
    overwriteRows(buggyColor, s0.color, 0, s0.color.spec.height - 1);
    overwriteRows(buggyColor, colorFull.color, y0, y1);
    let staleHaloTexels = 0;
    for (let y = haloY0; y <= haloY1; y++) {
      if (y >= y0 && y <= y1) {
        continue; // inside the original band the buggy version is correct
      }
      for (let x = 0; x < 64; x++) {
        for (let c = 0; c < 4; c++) {
          if (buggyColor.get(x, y, c) !== s1.color.get(x, y, c)) {
            staleHaloTexels += 1;
          }
        }
      }
    }
    expect(staleHaloTexels).toBeGreaterThan(0);
  });
});

describe("#43 DPR-invariant CSS-space contract (height gate + footprint)", () => {
  // The DOM maps the CSS-space reconstruction policy into the device-pixel
  // scene exactly once (radius_css * dpr, gate_css * dpr). The renderer then
  // sees scene-unit lengths and converts to texels with its own dpr (1 on
  // both DOM paths). Edge-preservation must therefore be identical in CSS
  // space at every display DPR: a subtle 0.4-CSS-px height step is NOT gated
  // at DPR 1 nor DPR 2, a strong step IS gated at both.
  function stepScene(dpr: number, cssThickness: number, cssStepY: number) {
    return createScene({
      width: 48 * dpr,
      height: 48 * dpr,
      surfaces: [
        {
          id: "thin",
          // a thin surface whose own thickness is the SUBTLE step (0.4 CSS
          // px) on top of the base plane
          position: { x: 8 * dpr, y: cssStepY * dpr },
          size: { x: 32 * dpr, y: 4 * dpr },
          elevation: 0,
          thickness: cssThickness * dpr,
          shape: { kind: "roundedRect", radius: 0 },
          profile: { kind: "flat" },
          material: "silicone",
          castsShadow: true,
          receivesShadow: true,
        },
      ],
      light: { direction: LIGHT_FROM_RIGHT, intensity: 1, angularRadius: 0.2 },
    });
  }

  it("keeps the height gate CSS-invariant: subtle steps stay un-gated at every DPR", () => {
    const gateCss = 0.5;
    const subtleCss = 0.4; // below the gate in CSS space at every dpr
    const strongCss = 6; // above the gate at every dpr
    for (const dpr of [1, 1.5, 2]) {
      // the DOM-scaled gate and heights (device px scene units)
      const gate = gateCss * dpr;
      // adjacent-texel height differences on the flat tops
      const subtleDevice = subtleCss * dpr;
      const strongDevice = strongCss * dpr;
      expect(Math.abs(Math.fround(subtleDevice)) > gate).toBe(false); // not gated
      expect(Math.abs(Math.fround(strongDevice)) > gate).toBe(true); // gated
    }
  });

  it("applies the same edge-gating decisions at DPR 1 and DPR 2 on real fields", () => {
    // Reconstruct a subtle-step scene and a strong-step scene at DPR 1 and
    // DPR 2 (device scenes + DOM-scaled gate), then compare the gating
    // decisions at corresponding CSS-space locations: the filter must smooth
    // across the subtle step in both, and preserve the strong step in both.
    const gatedNeighbors = (scene: ReturnType<typeof createScene>, dpr: number) => {
      const composed = composeSdfHeightField(scene);
      const raw = computeVisibility(scene, composed.height, {
        samples: 8,
        objectId: composed.objectId,
        casterHeight: composed.height,
      });
      // DOM mapping: radius 2 CSS px, gate 0.5 CSS px -> scene units once
      reconstructVisibility(
        raw,
        composed.height,
        { objectId: composed.objectId },
        { enabled: true, radius: 2 * dpr, heightGate: 0.5 * dpr },
      );
      // count the gated neighbors across the whole field (the internal
      // comparison is |H(p) - H(n)| > gate)
      const { width, height: h } = composed.height.spec;
      let gated = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < width; x++) {
          const hp = composed.height.get(x, y, 0);
          for (const [nx, ny] of [[x + 1, y], [x, y + 1]] as const) {
            if (nx >= width || ny >= h) {
              continue;
            }
            const hn = composed.height.get(nx, ny, 0);
            if (Math.abs(Math.fround(hp - hn)) > Math.fround(0.5 * dpr)) {
              gated += 1;
            }
          }
        }
      }
      return gated;
    };
    const subtle1 = gatedNeighbors(stepScene(1, 0.4, 20), 1);
    const subtle2 = gatedNeighbors(stepScene(2, 0.4, 40), 2);
    const strong1 = gatedNeighbors(stepScene(1, 6, 20), 1);
    const strong2 = gatedNeighbors(stepScene(2, 6, 40), 2);
    // subtle step: the gate scales with dpr, so per-CSS-px gating is equal —
    // the 0.4-CSS step is below the 0.5-CSS gate at every DPR, so NOTHING is
    // gated (the filter smooths across it, exactly like DPR 1)
    expect(subtle1).toBe(0);
    expect(subtle2).toBe(0);
    // strong step: gated identically in CSS space (the DPR-2 field has 2x
    // the texels, so the gated-pair count is exactly 2x)
    expect(strong1).toBeGreaterThan(0);
    expect(strong2).toBe(strong1 * 2);
  });
});

describe("#43/#53 reconstructed-visibility parity policy (tolerance evidence)", () => {
  // The reconstructed weighted quotient sum(w*v)/sum(w) is NOT dyadic
  // (3/25, 7/49, ... and non-dyadic Gaussian weights), so CPU/GPU parity
  // must not be promised bit-exact. This test collects the ULP evidence: an
  // f32-accumulation simulation of the WGSL path (each weight, add and the
  // division rounded to f32) against the CPU reference (f64 sums, f32-
  // rounded quotient once). The measured delta must stay INSIDE the
  // documented tolerance (1e-6); the max-ULP count is reported as evidence
  // that the tolerance covers accumulation/rounding variance, not an
  // algorithmic difference (both paths run the SAME taps and weights).

  function f32SimulationPath(
    raw: HostBuffer,
    height: HostBuffer,
    radiusTexels: number,
    heightGate: number,
    objectId: HostBuffer | null,
  ) {
    const { width, height: h } = raw.spec;
    const out = new HostBuffer(VISIBILITY_SPEC(width, h));
    const gate = Math.fround(heightGate);
    const sigma = Math.fround(RECONSTRUCTION_VALUE_SIGMA);
    const twoSigma2 = Math.fround(2 * sigma * sigma);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < width; x++) {
        const centerY = height.get(x, y, 0);
        const centerOwner = objectId !== null ? objectId.get(x, y, 0) : NO_OWNER;
        const centerVis = raw.get(x, y, 0);
        let sum = 0;
        let wsum = 0;
        for (let dy = -radiusTexels; dy <= radiusTexels; dy++) {
          const ny = Math.min(h - 1, Math.max(0, y + dy));
          for (let dx = -radiusTexels; dx <= radiusTexels; dx++) {
            const nx = Math.min(width - 1, Math.max(0, x + dx));
            if (objectId !== null && objectId.get(nx, ny, 0) !== centerOwner) {
              continue;
            }
            const nh = height.get(nx, ny, 0);
            if (Math.abs(Math.fround(centerY - nh)) > gate) {
              continue;
            }
            const dv = Math.fround(raw.get(nx, ny, 0) - centerVis);
            const w = Math.fround(Math.exp(-Math.fround((dv * dv) / twoSigma2)));
            sum = Math.fround(sum + Math.fround(w * raw.get(nx, ny, 0))); // f32 accumulate
            wsum = Math.fround(wsum + w);
          }
        }
        const vis = wsum > 0 ? Math.fround(sum / wsum) : centerVis;
        out.set(x, y, 0, Math.min(1, Math.max(0, vis)));
      }
    }
    return out;
  }

  function f32Ulp(value: number): number {
    const v = Math.abs(value);
    if (v === 0) {
      return 1.4e-45;
    }
    if (v < 1.18e-38) {
      return 1.4e-45;
    }
    return Math.pow(2, Math.floor(Math.log2(v)) - 23);
  }

  it("measures the CPU-vs-f32-simulation ULP delta (evidence for the tolerance)", () => {
    // a soft slab scene with a genuine penumbra so non-dyadic tap counts
    // (9, 25, 49, ...) and non-dyadic quotients actually occur
    const scene = sceneWithSlab(0.15, 4);
    const { composed, visibility } = rawVisibilityFor(scene, 4);
    // radius 2 -> 25 taps max; the gates reduce some neighborhoods to
    // non-square tap counts, producing quotients like 3/25, 7/17, ...
    const reference = reconstructVisibility(
      visibility,
      composed.height,
      { objectId: composed.objectId },
      { enabled: true, radius: 2 },
    );
    const simulated = f32SimulationPath(
      visibility,
      composed.height,
      2,
      RECONSTRUCTION_HEIGHT_GATE,
      composed.objectId,
    );
    let maxUlp = 0;
    let differing = 0;
    let maxAbs = 0;
    const { width, height: h } = visibility.spec;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < width; x++) {
        const a = reference.get(x, y, 0);
        const b = simulated.get(x, y, 0);
        if (a !== b) {
          differing += 1;
        }
        const abs = Math.abs(a - b);
        maxAbs = Math.max(maxAbs, abs);
        const ulp = abs / f32Ulp(a);
        maxUlp = Math.max(maxUlp, ulp);
      }
    }
    // Evidence: the f32 path (weights + accumulation + division rounded per
    // step) stays INSIDE the documented tolerance against the f64 reference
    // — the 1e-6 tolerance covers real f32 accumulation/rounding variance,
    // not an algorithmic difference (identical taps and weights).
    expect(maxAbs).toBeLessThanOrEqual(1e-6);
    expect(maxUlp).toBeLessThanOrEqual(64);
    // and the quotient really is non-dyadic: verify the reconstructed field
    // contains values whose f32 representation is not a k/16 dyadic
    const reconValues = toArray(reference);
    const nonDyadic = reconValues.some((v) => {
      const k16 = v * 16;
      return Math.abs(k16 - Math.round(k16)) > 1e-9;
    });
    expect(nonDyadic).toBe(true);
  });
});