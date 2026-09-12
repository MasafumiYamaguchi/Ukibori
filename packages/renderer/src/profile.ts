import { clamp } from "./math";
import type { HeightProfile } from "./scene";

/**
 * Evaluate a surface's local height profile at a signed distance from the
 * shape boundary.
 *
 * Returns the local height above the surface base in `[0, thickness]`; the
 * absolute scene z at a point is `elevation + evaluateProfile(...)`.
 *
 * - `distance`: signed distance from the shape boundary (negative inside,
 *   zero on boundary, positive outside)
 * - `bevelWidth`: width of the inward bevel band, from the nominal boundary
 *   (distance 0) to full thickness at distance `-bevelWidth` (scene units)
 * - `thickness`: the surface's profile height range (scene units)
 *
 * This is the CPU reference for the exact formulas the WebGPU/WGSL pipeline
 * will mirror; the math is deliberately not buried in shaders.
 */
export function evaluateProfile(
  profile: HeightProfile,
  distance: number,
  bevelWidth: number,
  thickness: number,
): number {
  switch (profile.kind) {
    case "flat":
    case "step":
      // Step at the shape boundary: full height inside, zero at/outside it.
      return distance < 0 ? thickness : 0;
    case "bevel":
    case "smooth": {
      // Inward silicone-like rise over the band [-bevelWidth, 0]:
      //   distance = -bevelWidth -> thickness (plateau inside)
      //   distance = -bevelWidth/2 -> thickness / 2
      //   distance = 0 (nominal boundary) -> 0 (surface base)
      // The bevel never extends outside the shape, so SurfaceNode.size is
      // the physical footprint (DOM rounded-rect semantics).
      // smoothstep is C1 (value and derivative match at both ends), so the
      // surface has no visible fold at the plateau or the boundary.
      if (bevelWidth <= 0) {
        return distance < 0 ? thickness : 0;
      }
      const u = clamp((distance + bevelWidth) / bevelWidth, 0, 1);
      const falloff = u * u * (3 - 2 * u);
      return thickness * (1 - falloff);
    }
    case "linear":
    case "convex":
    case "concave":
    case "power": {
      if (bevelWidth <= 0) return distance < 0 ? thickness : 0;
      const t = clamp(-distance / bevelWidth, 0, 1);
      if (t === 0 || t === 1) return thickness * t;
      let value: number;
      switch (profile.kind) {
        case "linear": value = t; break;
        case "convex": value = t * t; break;
        case "concave": value = 1 - (1 - t) * (1 - t); break;
        case "power": {
          const p = Math.fround(profile.exponent);
          if (!(p > 0) || !Number.isFinite(p)) throw new RangeError("power exponent must be positive finite f32");
          value = profile.bias === "out" ? 1 - Math.pow(1 - t, p) : Math.pow(t, p);
        }
      }
      return thickness * value;
    }
    default: {
      // Runtime data that bypassed validation (unknown kind) lands here.
      const kind = (profile as { kind: string }).kind;
      throw new Error(`profile kind not implemented: ${kind}`);
    }
  }
}

/** Absolute candidate height. Direction never changes the curve magnitude. */
export function profileSurfaceHeight(profile: HeightProfile, elevation: number, local: number): number {
  return profile.mode === "inset" ? Math.max(0, elevation - local) : elevation + local;
}
