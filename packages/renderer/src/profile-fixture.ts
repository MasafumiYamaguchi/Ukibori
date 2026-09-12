import { createScene } from "./scene";
import type { HeightProfile, Scene, Shape, SurfaceNode } from "./scene";

export const PROFILE_PRESETS = ["step", "linear", "smooth", "convex", "concave"] as const;

/** Deterministic raised/inset comparison: identical silhouette, pigment and light. */
export function createProfileComparisonScene(shape: Shape = { kind: "roundedRect", radius: 8 }): Scene {
  const surfaces: SurfaceNode[] = [];
  const surface = (id: string, x: number, y: number, profile: HeightProfile): SurfaceNode => ({
    id, position: { x, y }, size: { x: 56, y: 56 },
    elevation: profile.mode === "inset" ? 10 : 0,
    thickness: 8, bevelWidth: 14, shape, profile,
    material: "silicone", castsShadow: true, receivesShadow: true,
  });
  PROFILE_PRESETS.forEach((kind, i) => surfaces.push(surface(`raised-${kind}`, 12 + i * 72, 12, { kind })));
  surfaces.push({
    ...surface("chassis", 4, 88, { kind: "step" }),
    size: { x: 360, y: 72 }, thickness: 10,
    shape: { kind: "roundedRect", radius: 4 },
  });
  PROFILE_PRESETS.forEach((kind, i) => surfaces.push(surface(`inset-${kind}`, 12 + i * 72, 96, { kind, mode: "inset" })));
  return createScene({ width: 368, height: 172, surfaces,
    light: { direction: { x: -0.6, y: -0.4, z: 1 }, intensity: 1 },
  });
}
