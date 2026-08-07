import { HostBuffer } from "./buffer";
import { clamp } from "./math";
import { composeSdfHeightField } from "./geometry";
import { computeVisibility } from "./shadow";
import { brdfDirect } from "./brdf";
import { BASE_MATERIAL, resolveMaterial } from "./material";
import type { Material } from "./material";
import { NO_OWNER } from "./compose";
import { COLOR_SPEC, NORMAL_SPEC } from "./types";
import type { LinearRgb } from "./types";
import type { ShadowOptions } from "./shadow";
import type { Scene } from "./scene";

/**
 * #15/#16 lighting: normal generation and shared directional-light shading.
 *
 * All coordinates, sampling and f32 semantics follow the #13/#14 contract:
 * heights are sampled at pixel centers, stored as f32, and the scene light
 * direction points FROM the receiver TOWARD the light.
 *
 * The camera is fixed: the viewer looks along +z, so `V = (0, 0, 1)`.
 *
 * The surface response is the #16 Cook-Torrance BRDF (GGX/Smith/Schlick,
 * metallic workflow) with the per-pixel material taken from the owning
 * surface (objectId buffer). The provisional Blinn-Phong response is gone.
 * Lighting stays in linear space and is sRGB-encoded on output.
 */

export interface NormalOptions {
  /** scales the x height-gradient before normalization (default 0.5) */
  scaleX?: number;
  /** scales the y height-gradient before normalization (default 0.5) */
  scaleY?: number;
  /** z component of the unnormalized normal (default 1) */
  normalScale?: number;
}

export interface LightingOptions {
  normal?: NormalOptions;
  /** ambient fill strength (default 0.08); scales baseColor, unaffected by light intensity */
  ambient?: number;
  /** cast-shadow pass options (#17) */
  shadow?: ShadowOptions;
}

export interface ShadeInput {
  /** f32 scalar: the composed height field */
  height: HostBuffer;
  /** u32 scalar: owning surface index per pixel (NO_OWNER = base plane) */
  objectId: HostBuffer;
  /** f32 scalar: hard cast-shadow visibility 0..1; omit to skip shadows (treated as 1) */
  visibility?: HostBuffer;
}

export interface LightingBuffers {
  /** f32 scalar: the input height field */
  height: HostBuffer;
  /** f32 x3: normalized surface normals (xyz -> +z is flat) */
  normal: HostBuffer;
  /** f32 scalar: raw N dot L, 0..1 (material-independent light response) */
  diffuse: HostBuffer;
  /** f32 scalar: specular direct contribution, luminance(Fr) * NdotL * visibility, clamped 0..1 (before light intensity) */
  specular: HostBuffer;
  /** f32 scalar: hard cast-shadow visibility, 0 or 1 (present when a shadow pass ran) */
  visibility?: HostBuffer;
  /** RGBA8: combined lit color, sRGB-encoded */
  color: HostBuffer;
}

const DEFAULT_NORMAL: Required<NormalOptions> = {
  scaleX: 0.5,
  scaleY: 0.5,
  normalScale: 1,
};

const DEFAULT_AMBIENT = 0.08;

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
 * Full lighting pass over a height field: normals -> BRDF -> combined sRGB
 * color.
 *
 * - diffuse: `max(N dot L, 0)` (L points toward the light, #13 convention)
 * - BRDF: Cook-Torrance with the owning surface's material per pixel
 *   (`objectId` -> `scene.surfaces[i].material`); pixels without an owner
 *   use the base-plane material
 * - cast-shadow visibility (#17) scales the DIRECT terms (diffuse +
 *   specular + the final direct contribution); the ambient fill is
 *   unaffected — a fully shadowed pixel keeps its ambient base color
 * - `scene.light.intensity` scales the direct terms as well; intensity 0
 *   leaves ambient only
 * - the degenerate half-vector `L = -V` (direction `{0, 0, -1}`) yields no
 *   half vector; specular resolves safely to 0 (no NaN)
 * - color = baseColor * ambient + visibility * intensity * NdotL *
 *   (diffuse + specular), encoded to sRGB8
 */
export function shadeHeightField(
  scene: Scene,
  input: ShadeInput,
  options: LightingOptions = {},
): LightingBuffers {
  const { height, objectId } = input;
  const visibility = input.visibility ?? null;
  const normal = computeNormals(height, options.normal);
  const ambient = clamp(sanitizeFinite(options.ambient, DEFAULT_AMBIENT), 0, 1);
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

  const materials = new Map<number, Material>();
  const materialFor = (owner: number): Material => {
    if (owner === NO_OWNER) {
      return BASE_MATERIAL;
    }
    let material = materials.get(owner);
    if (material === undefined) {
      material = resolveMaterial(scene.materials, scene.surfaces[owner].material);
      materials.set(owner, material);
    }
    return material;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < width; x++) {
      const nx = normal.get(x, y, 0);
      const ny = normal.get(x, y, 1);
      const nz = normal.get(x, y, 2);
      const nDotL = Math.max(nx * lx + ny * ly + nz * lz, 0);
      const nDotV = Math.max(nz, 0);
      const material = materialFor(objectId.get(x, y, 0));
      const vis = visibility === null ? 1 : clamp(visibility.get(x, y, 0), 0, 1);
      let brdf = { diffuse: ZERO_RGB, specular: ZERO_RGB };
      if (nDotL > 0 && nDotV > 0 && hLen > 0) {
        const nDotH = Math.max(nx * hx + ny * hy + nz * hz, 0);
        const nDotVH = hz; // V = (0,0,1) -> V·H == H.z
        brdf = brdfDirect(material, nDotL, nDotV, nDotH, nDotVH);
      }
      const cosine = nDotL;

      diffuse.set(x, y, 0, cosine);
      specular.set(x, y, 0, Math.min(luminance(brdf.specular) * cosine * vis, 1));

      const base = material.baseColor;
      const direct = intensity * cosine * vis;
      color.set(x, y, 0, srgbEncodeChannel(base.r * ambient + direct * (brdf.diffuse.r + brdf.specular.r)));
      color.set(x, y, 1, srgbEncodeChannel(base.g * ambient + direct * (brdf.diffuse.g + brdf.specular.g)));
      color.set(x, y, 2, srgbEncodeChannel(base.b * ambient + direct * (brdf.diffuse.b + brdf.specular.b)));
      color.set(x, y, 3, 255);
    }
  }
  return { height, normal, diffuse, specular, color, visibility: visibility ?? undefined };
}

/** Compose the SDF height field, ownership, cast shadows and light it. */
export function lightScene(scene: Scene, options: LightingOptions = {}): LightingBuffers {
  const composed = composeSdfHeightField(scene);
  const visibility = computeVisibility(scene, composed.height, options.shadow);
  return shadeHeightField(
    scene,
    { height: composed.height, objectId: composed.objectId, visibility },
    options,
  );
}

const ZERO_RGB: LinearRgb = { r: 0, g: 0, b: 0 };

function luminance(c: LinearRgb): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
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

/** sRGB encode a linear channel into [0, 255]. */
function srgbEncodeChannel(v: number): number {
  const c = clamp(v, 0, 1);
  const encoded = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}
