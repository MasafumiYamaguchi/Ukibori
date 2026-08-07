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
 * - `bevelWidth`: half-width of the smooth edge band (scene units)
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
      // Step at the shape boundary: full height inside, zero at/outside it.
      return distance < 0 ? thickness : 0;
    case "bevel": {
      // Silicone-like rise over [-bevelWidth, +bevelWidth]:
      //   distance = -bevelWidth -> thickness (plateau inside)
      //   distance = 0          -> thickness / 2 (boundary)
      //   distance = +bevelWidth -> 0 (base outside)
      // smoothstep is C1 (value and derivative match at both ends), so the
      // surface has no visible fold at the plateau or the base.
      if (bevelWidth <= 0) {
        return distance < 0 ? thickness : 0;
      }
      const u = clamp((distance + bevelWidth) / (2 * bevelWidth), 0, 1);
      const falloff = u * u * (3 - 2 * u);
      return thickness * (1 - falloff);
    }
    default: {
      // Runtime data that bypassed validation (unknown kind) lands here.
      const kind = (profile as { kind: string }).kind;
      throw new Error(`profile kind not implemented: ${kind}`);
    }
  }
}
