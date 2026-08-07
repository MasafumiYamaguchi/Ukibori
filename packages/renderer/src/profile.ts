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
 * - `bevelWidth`: the surface's edge bevel width (scene units)
 * - `thickness`: the surface's profile height range (scene units)
 *
 * The analytic bevel profiles (smooth edge rise) are implemented by the
 * geometry issue (#14); only the degenerate `"flat"` profile exists here.
 */
export function evaluateProfile(
  profile: HeightProfile,
  distance: number,
  bevelWidth: number,
  thickness: number,
): number {
  switch (profile.kind) {
    case "flat":
      // Constant local height: a flat-topped surface. Whether a point is
      // covered is decided by the geometry (shape), not by this profile.
      return thickness;
    default: {
      // Runtime data that bypassed validation (unknown kind) lands here.
      const kind = (profile as { kind: string }).kind;
      throw new Error(`profile kind not implemented: ${kind}`);
    }
  }
}
