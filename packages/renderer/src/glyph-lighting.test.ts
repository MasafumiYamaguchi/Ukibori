import { describe, expect, it } from "vitest";
import {
  composeSdfHeightField,
  computeNormals,
  createScene,
  lightScene,
  maskFromAscii,
} from "./index";
import type { MaskSource, Scene, SurfaceNode } from "./scene";

/**
 * #52 glyph lighting characterization (root-cause evidence, CPU reference).
 *
 * Before any production change, this pins the structural facts that decide
 * which candidate cause dominates "the physical glyph relief does not visibly
 * respond to directional light":
 *
 * 1. the glyph height profile is the GENERIC SDF + smoothstep bevel: the
 *    interior is a flat plateau (zero gradient) and all directional shading
 *    lives in the narrow bevel band;
 * 2. the directional response EXISTS and flips with the light direction (the
 *    physical layer is not broken) — but it lives almost entirely on bevel /
 *    edge texels;
 * 3. thin strokes (≈1 mask px) have a much weaker response than thick ones;
 * 4. the mask-px resolution contract is DPR-invariant by design: scaling the
 *    footprint and every length by the DPR keeps the bevel band at the same
 *    MASK-pixel width (the silhouette stays a CSS-px raster — this is the
 *    documented #19/#20 contract, not an accident).
 *
 * The DOM-side covering (visible DOM text painting OVER the physical relief)
 * is a stacking fact that cannot exist in Node; it is characterized by the
 * real-browser ablation harness
 * (`packages/ukibori-dom/test-browser/glyph-lighting.mjs` and its committed
 * artifacts).
 */

/** "P" glyph with a bowl counter, stroke ≈ 0.2 × scale mask px. */
function pGlyph(scale: number): MaskSource {
  const stroke = Math.max(1, Math.round(scale * 0.2));
  const w = scale * 4;
  const h = scale * 5;
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let row = "";
    for (let x = 0; x < w; x++) {
      const stem = x < stroke;
      const bowlX = x >= w - stroke;
      const bowlY = y < Math.round(h * 0.55);
      const topArm = y < stroke;
      const midBar = y >= Math.round(h * 0.55) - stroke && y < Math.round(h * 0.55);
      const ink = stem || (bowlY && (topArm || bowlX || (midBar && x > stroke))) || topArm;
      row += ink ? "#" : ".";
    }
    rows.push(row);
  }
  return maskFromAscii(rows);
}

/** Thin-stroke "L" (1 mask px stroke). */
function thinL(scale: number): MaskSource {
  const rows: string[] = [];
  for (let y = 0; y < 5 * scale; y++) {
    let row = "";
    for (let x = 0; x < 4 * scale; x++) {
      row += x === 0 || y === 5 * scale - 1 ? "#" : ".";
    }
    rows.push(row);
  }
  return maskFromAscii(rows);
}

/** Thick-stroke "H" (stroke ≈ 0.6 × scale mask px). */
function thickH(scale: number): MaskSource {
  const stroke = Math.max(1, Math.round(scale * 0.6));
  const rows: string[] = [];
  for (let y = 0; y < 5 * scale; y++) {
    let row = "";
    for (let x = 0; x < 5 * scale; x++) {
      row +=
        x < stroke ||
        x >= 5 * scale - stroke ||
        (y >= Math.floor((5 * scale - stroke) / 2) && y < Math.floor((5 * scale - stroke) / 2) + stroke)
          ? "#"
          : ".";
    }
    rows.push(row);
  }
  return maskFromAscii(rows);
}

interface GlyphOptions {
  elevation?: number;
  thickness?: number;
  bevelWidth?: number;
  /** DPR simulation: scales the footprint and every scene length (scene-builder contract). */
  dpr?: number;
  withPanel?: boolean;
}

function glyphSurface(mask: MaskSource, options: GlyphOptions): SurfaceNode {
  const dpr = options.dpr ?? 1;
  return {
    id: "glyph",
    position: { x: 10 * dpr, y: 10 * dpr },
    size: { x: mask.width * dpr, y: mask.height * dpr },
    elevation: (options.elevation ?? 3) * dpr,
    thickness: (options.thickness ?? 0.8) * dpr,
    bevelWidth: (options.bevelWidth ?? 1.1) * dpr,
    shape: { kind: "mask", mask },
    profile: { kind: "bevel" },
    material: "metal",
    castsShadow: true,
    receivesShadow: true,
  };
}

function sceneFor(mask: MaskSource, options: GlyphOptions, lightX: number): Scene {
  const dpr = options.dpr ?? 1;
  return createScene({
    width: mask.width * dpr + 20 * dpr,
    height: mask.height * dpr + 20 * dpr,
    surfaces: [
      ...(options.withPanel
        ? [
            {
              id: "panel",
              position: { x: 1 * dpr, y: 1 * dpr },
              size: { x: (mask.width + 18) * dpr, y: (mask.height + 18) * dpr },
              elevation: 0,
              thickness: 3 * dpr,
              bevelWidth: 5 * dpr,
              shape: { kind: "roundedRect", radius: 6 * dpr },
              profile: { kind: "bevel" },
              material: "matte",
              castsShadow: true,
              receivesShadow: true,
            } satisfies SurfaceNode,
          ]
        : []),
      glyphSurface(mask, options),
    ],
    light: { direction: { x: lightX, y: -0.1, z: 1 }, intensity: 1 },
    environment: { intensity: 0.5, diffuseIntensity: 1, specularIntensity: 1 },
  });
}

/** Fraction of 3x3-interior ink texels whose normal is essentially vertical. */
function interiorFlatNormalPercent(mask: MaskSource, options: GlyphOptions): number {
  const composed = composeSdfHeightField(sceneFor(mask, options, -0.6));
  const normals = computeNormals(composed.height);
  const base = (options.elevation ?? 3) * (options.dpr ?? 1);
  const { width, height } = composed.height.spec;
  const inkAt = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const v = composed.height.get(x, y, 0);
    return Number.isFinite(v) && v > base + 1e-6;
  };
  let interior = 0;
  let flat = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!inkAt(x, y)) continue;
      let all = true;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!inkAt(x + dx, y + dy)) all = false;
        }
      }
      if (!all) continue;
      interior++;
      const mag = Math.hypot(normals.get(x, y, 0), normals.get(x, y, 1));
      if (mag < 0.1) flat++;
    }
  }
  return interior > 0 ? (100 * flat) / interior : 0;
}

/** Mean |diffuse delta| over ink texels between ±x lights (0..1 f32 domain). */
function directionalResponse(mask: MaskSource, options: GlyphOptions): number {
  const a = lightScene(sceneFor(mask, options, -0.6));
  const b = lightScene(sceneFor(mask, options, 0.6));
  const base = (options.elevation ?? 3) * (options.dpr ?? 1);
  const { width, height } = a.diffuse.spec;
  const inkAt = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const v = a.height.get(x, y, 0);
    return Number.isFinite(v) && v > base + 1e-6;
  };
  let n = 0;
  let sum = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!inkAt(x, y)) continue;
      n++;
      sum += Math.abs(a.diffuse.get(x, y, 0) - b.diffuse.get(x, y, 0));
    }
  }
  return n > 0 ? sum / n : 0;
}

describe("#52 glyph lighting characterization (CPU reference)", () => {
  const P_MEDIUM = pGlyph(8);

  it("keeps the glyph interior a flat plateau: no plateau exists while the bevel band covers the stroke", () => {
    // The smoothstep bevel reaches full thickness only at the band's inner
    // edge; a stroke a couple of mask px wide is band, not plateau.
    const composed = composeSdfHeightField(sceneFor(P_MEDIUM, {}, -0.6));
    const base = 3;
    const thickness = 0.8;
    let ink = 0;
    let plateau = 0;
    for (let y = 0; y < composed.height.spec.height; y++) {
      for (let x = 0; x < composed.height.spec.width; x++) {
        const v = composed.height.get(x, y, 0);
        if (Number.isFinite(v) && v > base + 1e-6) {
          ink++;
          if (v - base > thickness - 1e-4) plateau++;
        }
      }
    }
    expect(ink).toBeGreaterThan(100);
    expect(plateau / ink).toBeLessThan(0.05);
  });

  it("flattens the interior for large glyphs (plateau dominates; normals vertical)", () => {
    // At a larger glyph the bevel band is a small fraction of the ink and the
    // interior is a flat plateau with (0,0,1) normals.
    const large = pGlyph(16);
    expect(interiorFlatNormalPercent(large, {})).toBeGreaterThan(90);
  });

  it("has a real, user-visible directional response in the final color (panel + glyph)", () => {
    // Panel + glyph (the demo context), final sRGB color. The response lives
    // in the normal-dependent BRDF (a metal's direct term is essentially all
    // specular), so the user-visible metric is the COLOR delta between
    // opposite light directions. The SPATIAL flip (which side highlights) is
    // carried by the browser ablation artifacts; here we pin that the
    // physical glyph color genuinely depends on the light direction.
    const a = lightScene(sceneFor(P_MEDIUM, { withPanel: true }, -0.6));
    const b = lightScene(sceneFor(P_MEDIUM, { withPanel: true }, 0.6));
    const { width, height } = a.color.spec;
    let n = 0;
    let sum = 0;
    let max = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = a.height.get(x, y, 0);
        if (!Number.isFinite(v) || v <= 3 + 1e-6) continue;
        n++;
        let d = 0;
        for (let c = 0; c < 3; c++) d += Math.abs(a.color.get(x, y, c) - b.color.get(x, y, c));
        d /= 3;
        sum += d;
        if (d > max) max = d;
      }
    }
    expect(n).toBeGreaterThan(100);
    expect(sum / n).toBeGreaterThan(15);
    expect(max).toBeGreaterThan(40);
  });

  it("makes thin strokes much less responsive than thick ones", () => {
    const thin = directionalResponse(thinL(8), { thickness: 0.8, bevelWidth: 1.1 });
    const thick = directionalResponse(thickH(8), { thickness: 0.8, bevelWidth: 1.1 });
    expect(thick).toBeGreaterThan(0.2);
    expect(thin).toBeLessThan(thick * 0.2);
  });

  it("keeps the bevel band mask-px width DPR-invariant (resolution contract, not resolution gain)", () => {
    // The DOM scene scales the footprint and every length by the DPR while
    // the mask stays the same raster, so the band occupies the same number of
    // MASK pixels at every DPR — scaling the raster (supersampling) would be
    // a contract change, not a rendering detail.
    const bandMaskPx = (dpr: number): number => {
      const composed = composeSdfHeightField(
        sceneFor(P_MEDIUM, { dpr, thickness: 0.8, bevelWidth: 1.1 }, -0.6),
      );
      const base = 3 * dpr;
      const thickness = 0.8 * dpr;
      let ink = 0;
      let plateau = 0;
      for (let y = 0; y < composed.height.spec.height; y++) {
        for (let x = 0; x < composed.height.spec.width; x++) {
          const v = composed.height.get(x, y, 0);
          if (Number.isFinite(v) && v > base + 1e-6) {
            ink++;
            if (v - base > thickness - 1e-4) plateau++;
          }
        }
      }
      // band texels in MASK px units (each mask px covers dpr render texels)
      return (ink - plateau) / (dpr * dpr);
    };
    const band1 = bandMaskPx(1);
    const band2 = bandMaskPx(2);
    expect(band1).toBeGreaterThan(0);
    expect(Math.abs(band2 - band1) / band1).toBeLessThan(0.15);
  });
});
