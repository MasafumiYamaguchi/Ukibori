import { HostBuffer } from "./buffer";
import { clamp } from "./math";
import { composeSdfHeightField } from "./geometry";
import { COLOR_SPEC, NORMAL_SPEC } from "./types";
import type { Scene } from "./scene";

/**
 * #15 lighting: normal generation and shared directional-light shading.
 *
 * All coordinates, sampling and f32 semantics follow the #13/#14 contract:
 * heights are sampled at pixel centers, stored as f32, and the scene light
 * direction points FROM the receiver TOWARD the light.
 *
 * The camera is fixed: the viewer looks along +z, so `V = (0, 0, 1)`.
 *
 * This is a provisional surface response (diffuse + simple Blinn-Phong
 * specular + ambient). The physically meaningful material model replaces it
 * in #16; lighting stays in linear space and is sRGB-encoded on output.
 */

export interface LinearRgb {
  r: number;
  g: number;
  b: number;
}

export interface NormalOptions {
  /** scales the x height-gradient before normalization (default 0.5) */
  scaleX?: number;
  /** scales the y height-gradient before normalization (default 0.5) */
  scaleY?: number;
  /** z component of the unnormalized normal (default 1) */
  normalScale?: number;
}

export interface ShadingOptions {
  /** base surface color in LINEAR space (default mid-gray) */
  baseColor?: LinearRgb;
  /** ambient fill strength (default 0.08) */
  ambient?: number;
  /** diffuse response strength (default 0.85) */
  diffuseStrength?: number;
  /** Blinn-Phong specular strength (default 0.25) */
  specularStrength?: number;
  /** Blinn-Phong specular power (default 24) */
  specularPower?: number;
}

export interface LightingOptions {
  normal?: NormalOptions;
  shading?: ShadingOptions;
}

export interface LightingBuffers {
  /** f32 scalar: the input height field */
  height: HostBuffer;
  /** f32 x3: normalized surface normals (xyz -> +z is flat) */
  normal: HostBuffer;
  /** f32 scalar: N dot L, 0..1 */
  diffuse: HostBuffer;
  /** f32 scalar: Blinn-Phong specular term, clamped 0..1 */
  specular: HostBuffer;
  /** RGBA8: combined lit color, sRGB-encoded */
  color: HostBuffer;
}

const DEFAULT_NORMAL: Required<NormalOptions> = {
  scaleX: 0.5,
  scaleY: 0.5,
  normalScale: 1,
};

const DEFAULT_SHADING: Required<ShadingOptions> = {
  baseColor: { r: 0.55, g: 0.55, b: 0.55 },
  ambient: 0.08,
  diffuseStrength: 0.85,
  specularStrength: 0.25,
  specularPower: 24,
};

/**
 * Generate a normal buffer from a height field with finite differences.
 *
 *     dx = H(x + 1, y) - H(x - 1, y)      (2px span)
 *     dy = H(x, y + 1) - H(x, y - 1)
 *     N  = normalize(-dx * scaleX, -dy * scaleY, normalScale)
 *
 * - CENTRAL difference is used because it is symmetric (no directional bias
 *   from the gradient side). At the buffer border the outer sample is clamped
 *   to the edge pixel (replicate) instead of inventing data outside the
 *   buffer; the resulting halved edge gradient only affects the outermost
 *   scene pixels.
 * - The default `scaleX = scaleY = 0.5` converts the 2px difference into the
 *   slope per scene unit, so `normalScale = 1` gives the geometrically exact
 *   normal of the height field. Raising the scales exaggerates slopes.
 * - `normalScale` is sanitized to a finite STRICTLY POSITIVE value (zero or
 *   negative would break the unit-normal invariant; non-finite too).
 * - Normalization is overflow-safe: components are scaled by the largest
 *   component first, so extreme scale values still produce finite, unit
 *   normals.
 * - On a flat plateau `dx = dy = 0`, so `N = (0, 0, 1)` (+z = viewer).
 */
export function computeNormals(height: HostBuffer, options: NormalOptions = {}): HostBuffer {
  const scaleX = sanitizeFinite(options.scaleX, DEFAULT_NORMAL.scaleX);
  const scaleY = sanitizeFinite(options.scaleY, DEFAULT_NORMAL.scaleY);
  const normalScale = sanitizeStrictPositive(options.normalScale, DEFAULT_NORMAL.normalScale);
  const { width, height: h } = height.spec;
  const normal = new HostBuffer(NORMAL_SPEC(width, h));
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(y - 1, 0);
    const y1 = Math.min(y + 1, h - 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(x - 1, 0);
      const x1 = Math.min(x + 1, width - 1);
      const dx = height.get(x1, y, 0) - height.get(x0, y, 0);
      const dy = height.get(x, y1, 0) - height.get(x, y0, 0);
      const nx = -dx * scaleX;
      const ny = -dy * scaleY;
      const nz = normalScale;
      // overflow-safe normalize: scale by the largest component first
      const m = Math.max(Math.abs(nx), Math.abs(ny), Math.abs(nz));
      const inv = 1 / m;
      const len = Math.hypot(nx * inv, ny * inv, nz * inv);
      normal.set(x, y, 0, nx * inv / len);
      normal.set(x, y, 1, ny * inv / len);
      normal.set(x, y, 2, nz * inv / len);
    }
  }
  return normal;
}

/**
 * Full lighting pass over a height field: normals -> diffuse/specular ->
 * combined sRGB color.
 *
 * - diffuse: `max(N dot L, 0)` (L points toward the light, #13 convention)
 * - specular: Blinn-Phong `pow(max(N dot H, 0), power)` with
 *   `H = normalize(L + V)`, `V = (0, 0, 1)`
 * - `scene.light.intensity` scales the DIRECT terms (diffuse + specular);
 *   the ambient fill is unaffected — intensity 0 leaves ambient only
 * - the degenerate half-vector `L = -V` (direction `{0, 0, -1}`) yields no
 *   half vector; specular resolves safely to 0 (no NaN)
 * - color = baseColor * (ambient + intensity * diffuse) + intensity * spec,
 *   encoded to sRGB8. Provisional until the #16 material model.
 */
export function shadeHeightField(
  scene: Scene,
  height: HostBuffer,
  options: LightingOptions = {},
): LightingBuffers {
  const normal = computeNormals(height, options.normal);
  const s = { ...DEFAULT_SHADING, ...normalizeShading(options.shading) };
  const intensity = sanitizeNonNegative(scene.light.intensity, 1);
  const { width, height: h } = height.spec;
  const diffuse = new HostBuffer({ width, height: h, channels: 1, format: "f32" });
  const specular = new HostBuffer({ width, height: h, channels: 1, format: "f32" });
  const color = new HostBuffer(COLOR_SPEC(width, h));

  const lx = scene.light.direction.x;
  const ly = scene.light.direction.y;
  const lz = scene.light.direction.z;
  const hLen = Math.hypot(lx, ly, lz + 1);
  const hx = lx / hLen;
  const hy = ly / hLen;
  const hz = (lz + 1) / hLen;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < width; x++) {
      const nx = normal.get(x, y, 0);
      const ny = normal.get(x, y, 1);
      const nz = normal.get(x, y, 2);
      const nDotL = Math.max(nx * lx + ny * ly + nz * lz, 0);
      let spec = 0;
      if (hLen > 0) {
        const nDotH = Math.max(nx * hx + ny * hy + nz * hz, 0);
        spec = Math.min(Math.pow(nDotH, s.specularPower) * s.specularStrength, 1);
      }

      diffuse.set(x, y, 0, nDotL);
      specular.set(x, y, 0, spec);

      const directDiffuse = intensity * s.diffuseStrength * nDotL;
      const directSpecular = intensity * spec;
      color.set(x, y, 0, srgbEncodeChannel(s.baseColor.r * (s.ambient + directDiffuse) + directSpecular));
      color.set(x, y, 1, srgbEncodeChannel(s.baseColor.g * (s.ambient + directDiffuse) + directSpecular));
      color.set(x, y, 2, srgbEncodeChannel(s.baseColor.b * (s.ambient + directDiffuse) + directSpecular));
      color.set(x, y, 3, 255);
    }
  }
  return { height, normal, diffuse, specular, color };
}

/** Compose the SDF height field and light it in one call. */
export function lightScene(scene: Scene, options: LightingOptions = {}): LightingBuffers {
  return shadeHeightField(scene, composeSdfHeightField(scene).height, options);
}

function normalizeShading(options: ShadingOptions = {}): ShadingOptions {
  const out: ShadingOptions = {};
  const base = options.baseColor;
  if (base !== undefined && isFiniteLinearRgb(base)) {
    out.baseColor = { ...base };
  }
  out.ambient = sanitizeClamped(options.ambient, DEFAULT_SHADING.ambient, 0, 1);
  out.diffuseStrength = sanitizeClamped(options.diffuseStrength, DEFAULT_SHADING.diffuseStrength, 0, 1);
  out.specularStrength = sanitizeClamped(options.specularStrength, DEFAULT_SHADING.specularStrength, 0, 1);
  out.specularPower = sanitizeFiniteNonNegative(options.specularPower, DEFAULT_SHADING.specularPower);
  return out;
}

function isFiniteLinearRgb(v: LinearRgb): boolean {
  return (
    Number.isFinite(v.r) && Number.isFinite(v.g) && Number.isFinite(v.b) && v.r >= 0 && v.g >= 0 && v.b >= 0
  );
}

function sanitizeFinite(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function sanitizeStrictPositive(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

function sanitizeNonNegative(v: number, fallback: number): number {
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function sanitizeFiniteNonNegative(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

function sanitizeClamped(v: number | undefined, fallback: number, min: number, max: number): number {
  const value = sanitizeFiniteNonNegative(v, fallback);
  return clamp(value, min, max);
}

/** sRGB encode a linear channel into [0, 255]. Provisional (full color management in #16). */
function srgbEncodeChannel(v: number): number {
  const c = clamp(v, 0, 1);
  const encoded = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}
