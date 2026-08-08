import { NO_OWNER } from "ukibori-renderer";
import type { HostBuffer } from "ukibori-renderer";
import type { CompositeOptions, SurfaceImage } from "./types";

/**
 * Compositor (#20): maps the renderer's intermediate buffers onto the DOM
 * overlay.
 *
 * The renderer's `color` buffer is opaque everywhere (including the base
 * plane), which is correct for a self-contained scene but wrong on a DOM
 * page: the page background IS the base plane and must show through. The
 * `objectId` and `visibility` buffers disambiguate:
 *
 * - surface pixels (owner != NO_OWNER): renderer color, opaque
 * - lit base-plane pixels: fully transparent
 * - shadowed base-plane pixels: translucent `shadowColor` at `shadowAlpha`,
 *   a faithful-on-average approximation of the hard #17 visibility mask drawn
 *   over whatever the page shows underneath
 *
 * This reinterpretation lives ONLY in the compositor; the renderer buffers
 * (SDF / height / normal / visibility / color) are generated unchanged by the
 * #13–#19 pipeline and remain available for debug views.
 */

export const DEFAULT_SHADOW_COLOR: readonly [number, number, number] = [12, 16, 28];
export const DEFAULT_SHADOW_ALPHA = 0.3;

export function sanitizeCompositeOptions(
  options: CompositeOptions,
): Required<CompositeOptions> {
  const color = options.shadowColor ?? DEFAULT_SHADOW_COLOR;
  const shadowColor: readonly [number, number, number] = [
    clampByte(color[0]),
    clampByte(color[1]),
    clampByte(color[2]),
  ];
  const alpha =
    typeof options.shadowAlpha === "number" && Number.isFinite(options.shadowAlpha)
      ? clamp01(options.shadowAlpha)
      : DEFAULT_SHADOW_ALPHA;
  return {
    shadowColor,
    shadowAlpha: alpha === 0 ? DEFAULT_SHADOW_ALPHA : alpha,
  };
}

export interface CompositeInput {
  /** RGBA8 color buffer from the renderer (opaque) */
  color: HostBuffer;
  /** u32 scalar owning-surface index per pixel (NO_OWNER = base plane) */
  objectId: HostBuffer;
  /** f32 scalar hard cast-shadow visibility 0..1 (optional; 1 = lit) */
  visibility: HostBuffer | null;
}

/**
 * Composite the renderer output into a DOM overlay image. Both buffers must
 * share the same width/height.
 */
export function compositeSurfaceImage(
  input: CompositeInput,
  options: CompositeOptions = {},
): SurfaceImage {
  const { color, objectId, visibility } = input;
  const spec = color.spec;
  const oidSpec = objectId.spec;
  if (oidSpec.width !== spec.width || oidSpec.height !== spec.height) {
    throw new RangeError(
      `compositor: objectId ${oidSpec.width}x${oidSpec.height} does not match color ${spec.width}x${spec.height}`,
    );
  }
  if (visibility !== null) {
    const vSpec = visibility.spec;
    if (vSpec.width !== spec.width || vSpec.height !== spec.height) {
      throw new RangeError(
        `compositor: visibility ${vSpec.width}x${vSpec.height} does not match color ${spec.width}x${spec.height}`,
      );
    }
  }
  const opts = sanitizeCompositeOptions(options);
  const { width, height } = spec;
  const data = new Uint8ClampedArray(width * height * 4);
  const sr = opts.shadowColor[0];
  const sg = opts.shadowColor[1];
  const sb = opts.shadowColor[2];
  const sa = Math.round(opts.shadowAlpha * 255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      if (objectId.get(x, y, 0) !== NO_OWNER) {
        data[p] = color.get(x, y, 0);
        data[p + 1] = color.get(x, y, 1);
        data[p + 2] = color.get(x, y, 2);
        data[p + 3] = 255;
        continue;
      }
      const vis = visibility === null ? 1 : visibility.get(x, y, 0);
      if (vis >= 0.5) {
        data[p] = 0;
        data[p + 1] = 0;
        data[p + 2] = 0;
        data[p + 3] = 0;
        continue;
      }
      data[p] = sr;
      data[p + 1] = sg;
      data[p + 2] = sb;
      data[p + 3] = sa;
    }
  }
  return { width, height, data };
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
