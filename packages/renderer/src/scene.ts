import { isFiniteNumber, normalizeVec3 } from "./math";
import type { Vec2, Vec3 } from "./types";

/**
 * #13 scene contract — 2.5D scene model.
 *
 * Coordinate conventions (fixed here, shared by every later issue):
 *
 * - scene x/y are screen-space units that correspond 1:1 to CSS pixels
 * - +x = right
 * - +y = down
 * - +z = toward the viewer (out of the screen)
 * - geometry is a height field `z = H(x, y)` (see issue #12)
 * - elevation is absolute scene-space z (not parent-relative, not z-index)
 * - `devicePixelRatio` is a render-target concern and is never mixed into
 *   scene units; scene geometry stays in CSS-pixel space
 * - render-target pixel (x, y) samples the height field at the CONTINUOUS
 *   position `(x + 0.5, y + 0.5)` (pixel-center convention, fixed here)
 *
 * Light direction sign convention:
 *
 * `DirectionalLight.direction` points FROM the receiver surface TOWARD the
 * light source, in scene units. A light at upper-left-front of the screen is
 * `{ x: -0.6, y: -0.8, z: 1 }` (normalized). Cast-shadow rays (#17) travel
 * along `direction` from the receiver point.
 */

/**
 * Local height profile of a surface, as a SERIALIZABLE descriptor — plain
 * data, not a function — so the scene stays backend-agnostic and both CPU and
 * WebGPU paths interpret the same representation.
 *
 * Profile semantics (fixed here):
 *
 * - `evaluateProfile(profile, distance, bevelWidth, thickness)` returns the
 *   local height above the base, in `[0, thickness]`
 * - absolute scene z at a point is `elevation + localHeight`
 * - `distance` is the signed distance from the shape boundary (negative
 *   inside, zero on boundary, positive outside)
 *
 * Kinds:
 *
 * - `"flat"`: step at the shape boundary — local height `thickness` where the
 *   signed distance is negative (inside), `0` at/outside the boundary
 * - `"bevel"`: silicone-like smooth edge rise over the INWARD band
 *   `[-bevelWidth, 0]` (C1 smoothstep): full thickness at `-bevelWidth`,
 *   zero at the nominal boundary. The bevel never extends outside the shape,
 *   so `SurfaceNode.size` describes the physical footprint (DOM semantics)
 */
export type HeightProfile = { kind: "flat" } | { kind: "bevel" };

/**
 * Material is referenced by id. Physical BRDF parameters are fixed by the
 * material issue (#16); the scene only records which material a surface uses.
 */
export type MaterialRef = string;

/**
 * Shape source for a surface.
 *
 * `mask` is a future-compatible source (text/icon silhouettes, #19); the
 * scene contract does not define its fields yet.
 */
export type Shape = { kind: "roundedRect"; radius: number } | { kind: "mask" };

export interface SurfaceNode {
  /**
   * Unique string identifying the surface for debugging and user code.
   *
   * NOTE: the objectId buffer stores the surface INDEX into
   * `scene.surfaces`, not this string. `id` is not written to any buffer.
   */
  id: string;
  /** top-left corner in scene units (CSS pixels) */
  position: Vec2;
  /** width/height in scene units, > 0 */
  size: Vec2;
  /**
   * Absolute scene-space z of the surface BASE (the bottom of the surface's
   * solid). The top of the surface at a point is `elevation + localHeight`,
   * so the whole surface sits at z >= elevation. Finite and >= 0.
   */
  elevation: number;
  /**
   * Vertical extent of the local height profile above the base, i.e. the
   * maximum possible `localHeight`. Profile output is in `[0, thickness]`.
   * Finite and >= 0; defaults to 0.
   */
  thickness?: number;
  /**
   * Half-width of the smooth rise at shape edges, in scene units. The
   * surface's `profile` receives this as its `bevelWidth` argument.
   * Finite and >= 0; defaults to 0.
   */
  bevelWidth?: number;
  shape: Shape;
  /**
   * Local height profile as a serializable descriptor (see HeightProfile).
   * Evaluated with `evaluateProfile`; analytic kinds are added by #14.
   */
  profile: HeightProfile;
  material: MaterialRef;
  castsShadow: boolean;
  receivesShadow: boolean;
}

export interface DirectionalLight {
  /** unit vector from receiver toward the light (normalized on creation) */
  direction: Vec3;
  /** finite and >= 0; non-finite/negative falls back to 1 */
  intensity: number;
}

export interface Scene {
  /** render region in scene units (positive integers) */
  width: number;
  height: number;
  surfaces: SurfaceNode[];
  light: DirectionalLight;
}

export interface SceneInput {
  width: number;
  height: number;
  surfaces?: SurfaceNode[];
  light?: Partial<DirectionalLight>;
}

export const DEFAULT_LIGHT_DIRECTION: Vec3 = { x: 0, y: 0, z: 1 };

/**
 * Validation policy (fixed here):
 *
 * - structural invariants (dimensions, sizes, elevations, ids, flags) are
 *   programmer errors and THROW, so a bad scene cannot silently produce
 *   wrong shadows or ownership. Duplicate `SurfaceNode.id` values throw.
 * - `light.direction` and `light.intensity` are SANITIZED: invalid direction
 *   falls back to +z, invalid intensity falls back to 1
 */
export function createScene(input: SceneInput): Scene {
  assertPositiveInt(input.width, "scene width");
  assertPositiveInt(input.height, "scene height");
  const surfaces = (input.surfaces ?? []).map(validateSurface);
  const seenIds = new Set<string>();
  for (const surface of surfaces) {
    if (seenIds.has(surface.id)) {
      throw new TypeError(`duplicate surface id "${surface.id}"`);
    }
    seenIds.add(surface.id);
  }
  const direction = normalizeVec3(input.light?.direction ?? DEFAULT_LIGHT_DIRECTION);
  const intensity = sanitizeIntensity(input.light?.intensity);
  return {
    width: input.width,
    height: input.height,
    surfaces,
    light: { direction, intensity },
  };
}

function validateSurface(node: SurfaceNode): SurfaceNode {
  const label = node.id === undefined ? "(unnamed surface)" : `surface "${node.id}"`;
  if (typeof node.id !== "string" || node.id.length === 0) {
    throw new TypeError("surface id must be a non-empty string");
  }
  assertFiniteNumber(node.position.x, `${label} position.x`);
  assertFiniteNumber(node.position.y, `${label} position.y`);
  assertFiniteNumber(node.size.x, `${label} size.x`);
  assertFiniteNumber(node.size.y, `${label} size.y`);
  if (node.size.x <= 0 || node.size.y <= 0) {
    throw new RangeError(`${label} size must be > 0`);
  }
  assertFiniteNonNegative(node.elevation, `${label} elevation`);
  assertFiniteNonNegative(node.thickness ?? 0, `${label} thickness`);
  assertFiniteNonNegative(node.bevelWidth ?? 0, `${label} bevelWidth`);
  if (!isHeightProfile(node.profile)) {
    throw new TypeError(
      `${label} profile must be a profile descriptor (kind "flat"; analytic kinds come in #14)`,
    );
  }
  if (typeof node.material !== "string" || node.material.length === 0) {
    throw new TypeError(`${label} material must be a non-empty string`);
  }
  if (typeof node.castsShadow !== "boolean" || typeof node.receivesShadow !== "boolean") {
    throw new TypeError(`${label} castsShadow/receivesShadow must be booleans`);
  }
  if (!isShape(node.shape)) {
    throw new TypeError(
      `${label} shape must be a shape descriptor ({ kind: "roundedRect", radius } | { kind: "mask" })`,
    );
  }
  return { ...node, thickness: node.thickness ?? 0, bevelWidth: node.bevelWidth ?? 0 };
}

function sanitizeIntensity(v: unknown): number {
  return isFiniteNumber(v) && v >= 0 ? v : 1;
}

export function isHeightProfile(v: unknown): v is HeightProfile {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const kind = (v as HeightProfile).kind;
  return kind === "flat" || kind === "bevel";
}

/**
 * Runtime shape validation: `{ kind: "roundedRect", radius: finite >= 0 }` or
 * `{ kind: "mask" }`. Rejects unknown kinds, null, functions and malformed
 * objects, mirroring `isHeightProfile` for profiles.
 */
export function isShape(v: unknown): v is Shape {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const shape = v as Shape;
  if (shape.kind === "mask") {
    return true;
  }
  if (shape.kind === "roundedRect") {
    const radius = (shape as { kind: "roundedRect"; radius: unknown }).radius;
    return isFiniteNumber(radius) && radius >= 0;
  }
  return false;
}

function assertPositiveInt(v: unknown, label: string): void {
  if (!isFiniteNumber(v) || v <= 0 || !Number.isInteger(v)) {
    throw new TypeError(`${label} must be a positive integer, got ${String(v)}`);
  }
}

function assertFiniteNumber(v: unknown, label: string): void {
  if (!isFiniteNumber(v)) {
    throw new TypeError(`${label} must be a finite number, got ${String(v)}`);
  }
}

function assertFiniteNonNegative(v: unknown, label: string): void {
  if (!isFiniteNumber(v) || v < 0) {
    throw new TypeError(`${label} must be a finite non-negative number, got ${String(v)}`);
  }
}
