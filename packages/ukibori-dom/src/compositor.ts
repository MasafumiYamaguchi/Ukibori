import {
  NO_OWNER,
  compositePixelBytes,
  sanitizeCompositeOptions as sharedSanitize,
} from "ukibori-renderer";
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
 * - base-plane pixels: the translucent `shadowColor` tint scales with the
 *   #41 CONTINUOUS occlusion strength `clamp(1 - visibility, 0, 1)` —
 *   fully lit (vis 1) is fully transparent, fully shadowed (vis 0) gets the
 *   full `shadowAlpha`, and partial visibilities get a proportional overlay,
 *   a faithful approximation of the cast shadow drawn over whatever the page
 *   shows underneath (hard {0, 1} inputs reproduce the historical bytes)
 *
 * This reinterpretation lives ONLY in the compositor; the renderer buffers
 * (SDF / height / normal / visibility / color) are generated unchanged by the
 * #13–#19 pipeline and remain available for debug views.
 *
 * #29: the per-pixel semantics and the sanitization are the narrow shared
 * helpers in `ukibori-renderer` (`gpu/composite.ts`) — the SAME code the GPU
 * presentation stage mirrors in WGSL. The results here are byte-identical to
 * the previous inline formulas (the DOM tests pin the exact bytes).
 */

export const DEFAULT_SHADOW_COLOR: readonly [number, number, number] = [12, 16, 28];
export const DEFAULT_SHADOW_ALPHA = 0.3;

export function sanitizeCompositeOptions(
  options: CompositeOptions,
): Required<CompositeOptions> {
  const effective = sharedSanitize(options);
  return {
    shadowColor: effective.shadowColor,
    shadowAlpha: effective.shadowAlpha,
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
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      // #29 shared per-pixel semantics (gpu/composite.ts): opaque surface,
      // lit transparent base plane, or translucent shadow tint. `opts` is
      // already sanitized, so `compositePixelBytes` re-sanitization is a
      // no-op and the bytes are identical to the previous inline loop.
      const [r, g, b, a] = compositePixelBytes(
        objectId.get(x, y, 0),
        color.get(x, y, 0),
        color.get(x, y, 1),
        color.get(x, y, 2),
        visibility === null ? null : visibility.get(x, y, 0),
        opts,
      );
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = a;
    }
  }
  return { width, height, data };
}
