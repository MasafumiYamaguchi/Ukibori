import { HostBuffer } from "./buffer";
import type { Scene, SurfaceNode } from "./scene";

/**
 * CPU reference composition (issue #13) — the semantics that GPU passes must
 * reproduce, not a fast path.
 *
 * Geometry contract for `surfaceHeightAt`:
 *
 * - a pixel where the surface has no geometry returns `-Infinity`
 * - a pixel covered by geometry returns a finite `>= 0` height (the surface's
 *   absolute scene-space z at that pixel)
 * - any other non-finite value (NaN / +/-Infinity) is treated as "no
 *   geometry", so a bad geometry function cannot corrupt the scene height
 *
 * Sampling convention (fixed here):
 *
 * pixel (x, y) samples the height field at the continuous position
 * `(x + 0.5, y + 0.5)` (pixel centers), matching the scene contract.
 *
 * f32 semantics (fixed here):
 *
 * `surfaceHeightAt` results are rounded to f32 with `Math.fround` before the
 * max/equality comparison. GPU compute pipelines store heights as f32, so the
 * CPU reference must make the same tie decisions and store the same values.
 *
 * Composition rule (fixed here, shared by #18):
 *
 *     Hscene(x, y) = max(0, max_i surfaceHeightAt_i(x, y))
 *
 * The base plane is z = 0 and has no owner. `objectId` is the INDEX into
 * `scene.surfaces` of the surface that provides the maximum height at that
 * pixel (it is NOT the surface `id` string). On exact f32-equality ties the
 * default `"last"` rule lets the later surface (higher array index) win,
 * mirroring DOM paint order where later elements render on top.
 */

/** surface index into `scene.surfaces`; `NO_OWNER` when no surface covers the pixel */
export const NO_OWNER = 0xffffffff;

/**
 * Absolute scene z of the surface at a CONTINUOUS scene position.
 *
 * `composeHeightField` calls this at pixel centers `(x + 0.5, y + 0.5)`.
 * Returns `-Infinity` where the surface has no geometry.
 */
export type SurfaceHeightAt = (surface: SurfaceNode, x: number, y: number) => number;

export type TieBreak = "first" | "last";

export interface ComposeOptions {
  tieBreak?: TieBreak;
}

export interface ComposeResult {
  /** f32 scalar: absolute scene-space z, `max(0, ...)` of surface heights */
  height: HostBuffer;
  /** u32 scalar: topmost owning surface index, or NO_OWNER */
  objectId: HostBuffer;
  /** u32 scalar: material index into `materials`, or NO_OWNER */
  materialId: HostBuffer;
  /** unique material ids in first-appearance order across `scene.surfaces` */
  materials: string[];
}

export function sceneMaterials(scene: Scene): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const surface of scene.surfaces) {
    if (!seen.has(surface.material)) {
      seen.add(surface.material);
      out.push(surface.material);
    }
  }
  return out;
}

export function composeHeightField(
  scene: Scene,
  surfaceHeightAt: SurfaceHeightAt,
  options: ComposeOptions = {},
): ComposeResult {
  const tieBreak = options.tieBreak ?? "last";
  const width = scene.width;
  const height = scene.height;
  const heightBuf = new HostBuffer({ width, height, channels: 1, format: "f32" });
  const objectBuf = new HostBuffer({ width, height, channels: 1, format: "u32" });
  const materialBuf = new HostBuffer({ width, height, channels: 1, format: "u32" });
  const materials = sceneMaterials(scene);
  const materialIndex = new Map(materials.map((m, i) => [m, i]));

  heightBuf.fill(0);
  objectBuf.fill(NO_OWNER);
  materialBuf.fill(NO_OWNER);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = x + 0.5;
      const sy = y + 0.5;
      let best = 0;
      let owner = NO_OWNER;
      for (let i = 0; i < scene.surfaces.length; i++) {
        const h = Math.fround(surfaceHeightAt(scene.surfaces[i], sx, sy));
        const hOk = Number.isFinite(h) && h >= 0;
        if (!hOk) {
          continue;
        }
        if (h > best || (h === best && tieBreak === "last")) {
          best = h;
          owner = i;
        }
      }
      if (owner !== NO_OWNER) {
        heightBuf.set(x, y, 0, best);
        objectBuf.set(x, y, 0, owner);
        materialBuf.set(x, y, 0, materialIndex.get(scene.surfaces[owner].material)!);
      }
    }
  }

  return {
    height: heightBuf,
    objectId: objectBuf,
    materialId: materialBuf,
    materials,
  };
}

/**
 * Fixture geometry for ownership/composition tests only.
 *
 * A flat-top rounded rectangle: `elevation + thickness` inside the shape,
 * `-Infinity` outside. `x`/`y` are continuous scene positions (the caller,
 * e.g. `composeHeightField`, samples at pixel centers). This deliberately
 * does NOT implement the smooth distance-profile from issue #14 — it exists
 * so composition rules can be verified with exact integer heights.
 */
export function flatRoundedRectHeight(surface: SurfaceNode, x: number, y: number): number {
  if (surface.shape.kind !== "roundedRect") {
    throw new Error(
      `flatRoundedRectHeight supports only roundedRect shapes, got ${surface.shape.kind}`,
    );
  }
  return roundRectContains(surface, x, y) ? surface.elevation + (surface.thickness ?? 0) : -Infinity;
}

function roundRectContains(surface: SurfaceNode, x: number, y: number): boolean {
  const shape = surface.shape;
  if (shape.kind !== "roundedRect") {
    return false;
  }
  const halfW = surface.size.x / 2;
  const halfH = surface.size.y / 2;
  const radius = Math.min(shape.radius, halfW, halfH);
  const cx = surface.position.x + halfW;
  const cy = surface.position.y + halfH;
  const dx = Math.max(Math.abs(x - cx) - (halfW - radius), 0);
  const dy = Math.max(Math.abs(y - cy) - (halfH - radius), 0);
  return Math.hypot(dx, dy) <= radius;
}
