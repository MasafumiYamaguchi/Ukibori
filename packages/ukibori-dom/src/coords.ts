import {
  DEFAULT_RECONSTRUCTION_RADIUS,
  MAX_RECONSTRUCTION_RADIUS,
  RECONSTRUCTION_HEIGHT_GATE,
} from "ukibori-renderer";
import type { Region } from "./types";

/**
 * Coordinate helpers for the DOM integration layer (#20).
 *
 * The layer uses DOCUMENT-relative CSS pixels (see `types.ts`): element
 * geometry is read as a viewport-relative `getBoundingClientRect()` and moved
 * into document space by adding the current page scroll offsets. Keeping the
 * retained scene in document space means ordinary page scroll does not change
 * scene geometry — the overlay is positioned at the document origin and moves
 * with the page, so scroll does not force a re-render (sticky / transformed /
 * nested-scroll cases are handled by re-measuring on scroll, see dom-layer).
 *
 * DPR invariance: the renderer scene is the dpr-scaled similarity image of
 * the CSS-space scene (every length x dpr, light direction unchanged). All
 * length-valued pipeline parameters must be mapped through the SAME
 * transform, otherwise dpr would change the physical result. The renderer's
 * shadow pass (#17) takes `stepSize` / `bias` / `maxDistance` in SCENE units,
 * so the DOM layer scales them by dpr (including the renderer's defaults for
 * step/bias, which the layer therefore makes explicit). `maxDistance` is
 * omitted when not configured: the renderer default is derived from the
 * (already dpr-scaled) scene diagonal, so it is invariant on its own.
 */

export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Convert a viewport-relative rect into a document-space rect. */
export function viewportRectToDocument(
  rect: ViewportRect,
  scrollX: number,
  scrollY: number,
): { x: number; y: number; w: number; h: number } {
  const x = rect.left + scrollX;
  const y = rect.top + scrollY;
  const w = rect.width;
  const h = rect.height;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError(`non-finite viewport rect origin: ${rect.left}, ${rect.top}`);
  }
  return { x, y, w, h };
}

/**
 * Union of the given document-space boxes inflated by `margin` on every side.
 * Returns null when there are no valid boxes (nothing to render).
 *
 * `margin` reserves room for cast shadows that extend past the surfaces
 * themselves (#17); shadowed base-plane pixels are clipped at the region
 * boundary.
 */
export function computeRegion(
  boxes: readonly { x: number; y: number; w: number; h: number }[],
  margin: number,
): Region | null {
  const m = sanitizeMargin(margin);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    if (!isFiniteRect(box) || box.w <= 0 || box.h <= 0) {
      continue;
    }
    if (box.x < minX) minX = box.x;
    if (box.y < minY) minY = box.y;
    if (box.x + box.w > maxX) maxX = box.x + box.w;
    if (box.y + box.h > maxY) maxY = box.y + box.h;
  }
  if (!Number.isFinite(minX)) {
    return null;
  }
  return {
    x: minX - m,
    y: minY - m,
    w: (maxX - minX) + 2 * m,
    h: (maxY - minY) + 2 * m,
  };
}

function isFiniteRect(
  box: { x: number; y: number; w: number; h: number },
): boolean {
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.w) &&
    Number.isFinite(box.h)
  );
}

function sanitizeMargin(margin: number): number {
  return Number.isFinite(margin) && margin >= 0 ? margin : 0;
}

/**
 * Render-target texel size for a region at a given dpr, mirroring the
 * renderer's resolution contract (`floor(sceneSize * dpr)` texels).
 */
export function renderTargetSize(
  region: Region,
  dpr: number,
): { width: number; height: number } {
  const width = Math.floor(region.w * dpr);
  const height = Math.floor(region.h * dpr);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new RangeError(
      `render target must be positive: ${width}x${height} for region ${region.w}x${region.h} at dpr ${dpr}`,
    );
  }
  return { width, height };
}

/** Sanitize a device-pixel-ratio value to a finite number >= 1. */
export function sanitizeDpr(dpr: number | undefined): number {
  return typeof dpr === "number" && Number.isFinite(dpr) && dpr >= 1 ? dpr : 1;
}

/** CSS-space shadow march step (renderer default 0.5 scene units at dpr 1). */
export const DEFAULT_SHADOW_STEP_SIZE = 0.5;
/** CSS-space self-shadow bias (renderer default 0.5 scene units at dpr 1). */
export const DEFAULT_SHADOW_BIAS = 0.5;

export interface ScaledShadowOptions {
  stepSize: number;
  bias: number;
  maxDistance?: number;
  /** #41 area-light sample count, forwarded UNSCALED */
  samples?: 1 | 4 | 8 | 16;
  /** #43 reconstruction options mapped to scene units (see `scaleShadowOptions`) */
  reconstruction?: { enabled?: boolean; radius: number; heightGate: number };
}

/**
 * CSS-space reconstruction policy (#43): the public `radius` is clamped into
 * `[0, MAX_RECONSTRUCTION_RADIUS]` CSS px and defaults to
 * `DEFAULT_RECONSTRUCTION_RADIUS` CSS px; the height gate defaults to
 * `RECONSTRUCTION_HEIGHT_GATE` CSS px. These numeric values are the
 * renderer's documented constants — this layer is the SINGLE place the
 * CSS-space contract is enforced and converted to scene units.
 */

/**
 * Map CSS-space shadow options (#17/#41/#43) through the dpr similarity transform.
 *
 * The renderer's shadow pass interprets `stepSize` / `bias` / `maxDistance`
 * in SCENE units, and the scene is dpr-scaled by `buildScene`. To keep the
 * cast-shadow geometry identical in CSS space at any dpr, every configured
 * LENGTH is multiplied by dpr AND the renderer's defaults for step/bias are
 * materialized here (0.5 CSS px) instead of being left to the renderer —
 * the renderer default is a fixed scene-unit value, so it would silently
 * shrink with dpr. `maxDistance` is only forwarded when configured; the
 * renderer default derives from the dpr-scaled scene diagonal and is already
 * invariant. Invalid configured values fall back to the CSS-space defaults,
 * mirroring the renderer's sanitization.
 *
 * #41: `samples` is a COUNT, not a length — it is forwarded through
 * UNSCALED (a sample count must never change with devicePixelRatio).
 *
 * #43: the reconstruction options are LENGTHS in the renderer's SCENE units
 * (device px here), so THIS function is the single CSS-space -> scene-unit
 * conversion point: the public CSS-px `radius` (clamped into
 * `[0, MAX_RECONSTRUCTION_RADIUS]` CSS px, default 2 CSS px) is multiplied
 * by dpr exactly once, and the CSS-space height gate (0.5 CSS px) is scaled
 * the same way — the renderer then converts the scene-unit radius to texels
 * with its own dpr (1 on both DOM paths), keeping the CSS-space footprint
 * and edge-preservation identical at every display DPR. The defaults are
 * ALWAYS materialized so an unspecified option cannot silently fall back to
 * the renderer's scene-unit default (which would shrink with dpr).
 */
export function scaleShadowOptions(
  options: {
    stepSize?: number;
    bias?: number;
    maxDistance?: number;
    samples?: 1 | 4 | 8 | 16;
    reconstruction?: { enabled?: boolean; radius?: number; heightGate?: number };
  },
  dpr: number,
): ScaledShadowOptions {
  const d = sanitizeDpr(dpr);
  const stepSize =
    (isFiniteStrictPositive(options.stepSize) ? options.stepSize! : DEFAULT_SHADOW_STEP_SIZE) * d;
  const bias =
    (isFiniteNonNegative(options.bias) ? options.bias! : DEFAULT_SHADOW_BIAS) * d;
  const maxDistance = isFiniteStrictPositive(options.maxDistance)
    ? options.maxDistance! * d
    : undefined;
  // #43 CSS-space policy applied ONCE here, then converted to scene units:
  // radius clamps into [0, MAX_RECONSTRUCTION_RADIUS] CSS px (default 2), the
  // height gate defaults to 0.5 CSS px, and both are scaled by dpr exactly
  // like every other shadow length. `enabled` is forwarded verbatim.
  const rawRadius = isFiniteNonNegative(options.reconstruction?.radius)
    ? options.reconstruction!.radius!
    : DEFAULT_RECONSTRUCTION_RADIUS;
  const radius = Math.min(MAX_RECONSTRUCTION_RADIUS, rawRadius) * d;
  const rawGate = isFiniteNonNegative(options.reconstruction?.heightGate)
    ? options.reconstruction!.heightGate!
    : RECONSTRUCTION_HEIGHT_GATE;
  const heightGate = rawGate * d;
  return {
    stepSize,
    bias,
    ...(maxDistance !== undefined ? { maxDistance } : {}),
    ...(options.samples !== undefined ? { samples: options.samples } : {}),
    reconstruction: {
      ...(options.reconstruction?.enabled !== undefined
        ? { enabled: options.reconstruction.enabled }
        : {}),
      radius,
      heightGate,
    },
  };
}

function isFiniteStrictPositive(v: number | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function isFiniteNonNegative(v: number | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}
