import { parseHeader } from "./encode";
import {
  HEADER_SIZE,
  MASK_OFFSET_ALPHA_BYTE_LENGTH,
  MASK_OFFSET_PIXEL_OFFSET,
  MASK_STRIDE,
  MATERIAL_STRIDE,
  SURFACE_OFFSET_BOUNDS,
  SURFACE_OFFSET_MASK_INDEX,
  SURFACE_STRIDE,
  sceneSectionLayout,
} from "./layout";
import { sanitizeShadowOptions } from "./shadow-pass";
import type { ShadowOptions } from "../shadow";
import {
  computeSoftSampleDirectionVariants,
  sanitizeAngularRadius,
} from "../shadow-sampling";

/**
 * #32 conservative tile planner — the standalone, deterministic region
 * planner for tile binning, dirty-region computation, culling and the
 * partial/full dispatch decision. This module is PURE: no WebGPU calls, no
 * DOM, no timing; every function is a deterministic function of its inputs,
 * so the whole planner is unit-testable in Node.
 *
 * ## Tile grid
 *
 * `computeTileGrid(width, height, tileSize)` lays a fixed-size grid over
 * the encoded render extent. Tile size is explicit, bounded to
 * `[TILE_SIZE_MIN, TILE_SIZE_MAX]` (clamped, never silently accepted
 * outside) and defaults to `TILE_SIZE_DEFAULT = 64` texels. Right/bottom
 * edge tiles are CLIPPED to the extent (`tileRectAt`), so every tile rect
 * stays inside the render bounds and every shader buffer access from a tile
 * dispatch remains bounds-safe. Tile membership is a pure function of the
 * texel coordinates — deterministic binning by construction.
 *
 * ## Conservative raster footprints
 *
 * `surfaceTexelFootprint` converts a surface's ABI scene-space bounds into
 * the texel set it can affect using the texel-cell overlap rule
 * (`tx/dpr <= x < (tx+1)/dpr`), then expands by `PROFILE_HALO_TEXELS` (1):
 * the half-texel-center boundary, bevel/profile boundary support and the
 * f32 rounding of the ABI bounds are all covered, so culling can never omit
 * a contributing surface. Footprints are clipped to the render extent;
 * surfaces entirely outside the extent yield `null` (no tile membership).
 *
 * ## Dirty regions
 *
 * `diffEncodedScenes(prev, next)` compares the two effective encoded scenes
 * EXACTLY (per-surface record bytes, mask records, mask alpha blobs) — never
 * through hashes — and returns either a conservative dirty scene-space rect
 * (the union of old+new footprints of added/removed/changed surfaces plus
 * surfaces referencing content-changed masks) or a full-recompute fallback
 * with a deterministic reason when locality cannot be proven:
 *
 * - viewport/DPR change, light direction/intensity, exposure,
 *   environment, material-table change -> conservative full recompute
 * - changed bytes with no detected surface/known-global change ->
 *   `unknown-mutation` full recompute (a hash collision must never
 *   silently preserve wrong output; the hash is only an accelerator gate,
 *   the diff itself is exact)
 *
 * The dirty rect is then expanded by the DOWNSTREAM KERNEL FOOTPRINTS:
 *
 * - `shadowHalo` / `sampledShadowHaloUnion` expand the scene rect
 *   up-shadow (down-light of every changed region) per axis by
 *   `maxDistance * |D.xy|`: exactly the set of receivers whose cast-shadow
 *   ray can pass through a changed region, so a changed caster can never
 *   leave a stale shadow texel outside the dirty region. `maxDistance` is
 *   the SANITIZED effective shadow option (ONE shared scalar for every ray).
 *   The direction set is the ShadowPass's REAL march set: the CENTER light
 *   direction on the hard path (#17/#27), and the UNION of every #41/#43
 *   area-light sample direction (all kernel variants x samples, the exact
 *   canonical `computeSoftSampleDirectionVariants` arrays) on the soft path —
 *   a center-only halo would miss receivers reached only by slanted sample
 *   rays and leave stale soft-shadow texels outside the partial region.
 * - `expandTexelRect` applies the 1-texel halo that covers the normal
 *   kernel (central difference reads `H(T +/- 1)`) and the bevel/profile
 *   boundary support.
 *
 * ## Partial/full policy
 *
 * `planPartialScene` converts the expanded dirty scene rect into the dirty
 * texel rect, computes the dirty tile set and the DISPATCH BAND — the
 * conservative full-width row band covering every dirty tile (the passes
 * dispatch one contiguous 1D texel range `[y0*width, (y1+1)*width)`, which
 * keeps every buffer access bounds-safe with the existing in-shader
 * guards) — and decides:
 *
 *     partial iff bandTexels / totalTexels <= PARTIAL_DISPATCH_RATIO (0.5)
 *
 * The threshold is a DETERMINISTIC coverage ratio, not a timing: a noisy
 * microbenchmark can never flip the decision. Above half the frame the
 * per-pass fixed costs (encoder, bind group, uniform upload, submission)
 * dominate and the full path wins automatically. The decision and its
 * reason are always exposed; binning overhead (the planner itself) is
 * measured by the pipeline as host wall-clock `planningHostMs` and reported
 * separately from GPU work.
 *
 * The `candidateSurfaceCount` / `culledSurfaceCount` fields are ACTUAL for
 * the height composition stage: `candidateIndices` lists the ORIGINAL
 * surface indices the compose shaders genuinely iterate on a partial frame
 * (surfaces whose conservative texel footprint intersects the dispatch
 * band — the whole band is overwritten, so the band, not the narrow dirty
 * rect, is the binning region). Culled surfaces are genuinely excluded
 * from the per-texel compose loops. The normal/shadow/lighting stages
 * perform no per-texel surface iteration at all. On full frames every
 * surface is a candidate (the compose shaders iterate all original
 * indices).
 */

/** Default tile size (texels) — explicit, bounded, configurable. */
export const TILE_SIZE_DEFAULT = 64;

/** Smallest accepted tile size (texels). */
export const TILE_SIZE_MIN = 8;

/** Largest accepted tile size (texels). */
export const TILE_SIZE_MAX = 512;

/**
 * Deterministic partial/full threshold: partial only when the dispatch band
 * covers at most half the frame's texels. Documented policy — the optimized
 * path is never selected because a microbenchmark is noisy; it is a pure
 * coverage ratio.
 */
export const PARTIAL_DISPATCH_RATIO = 0.5;

/**
 * Conservative raster halo (texels) added to every surface footprint:
 * covers the half-texel-center boundary sampling, bevel/profile boundary
 * support (the profile never extends outside the shape, but the boundary
 * band is fully inside this halo) and the f32 rounding of the ABI bounds.
 */
export const PROFILE_HALO_TEXELS = 1;

/** Texel-space axis-aligned rect (clipped to the render extent). */
export interface TileRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Deterministic tile grid over an encoded render extent. */
export interface TileGrid {
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  /** ceil(width / tileSize); the right-edge tile is clipped */
  readonly tilesX: number;
  /** ceil(height / tileSize); the bottom-edge tile is clipped */
  readonly tilesY: number;
  readonly tileCount: number;
  /** Clipped texel rect of tile (tileX, tileY). Throws out of range. */
  tileRectAt(tileX: number, tileY: number): TileRect;
}

/** The conservative dispatch region: inclusive texel rows. */
export interface BandRegion {
  readonly y0: number;
  readonly y1: number;
}

/** Scene-space axis-aligned rect. */
export interface SceneRect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Per-axis conservative shadow receiver expansion (scene units). */
export interface ShadowHalo {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * Exact per-surface/mask diff of two encoded scenes. `fullFallback` is set
 * with a deterministic `fullFallbackReason` when locality cannot be proven
 * (viewport/DPR, light/environment/exposure, material table, or an unknown
 * byte mutation); otherwise `dirtySceneRect` is the union of old+new
 * footprints of every added/removed/changed surface plus the footprints of
 * surfaces referencing content-changed masks.
 */
export interface SceneDiffResult {
  readonly fullFallback: boolean;
  readonly fullFallbackReason: string | null;
  /** null when nothing changed (or on a full fallback) */
  readonly dirtySceneRect: SceneRect | null;
  /** surface indices whose record bytes differ (index-stable array order) */
  readonly changedSurfaceIndices: readonly number[];
  /** surface indices added or removed (index >= the shared prefix) */
  readonly addedOrRemovedSurfaceIndices: readonly number[];
}

/** The full deterministic planning report for one frame. */
export interface PartialPlan {
  readonly mode: "full" | "partial";
  /** deterministic decision reason (never a timing) */
  readonly reason: string;
  readonly tileSize: number;
  readonly totalTileCount: number;
  readonly dirtyTileCount: number;
  /** texels inside the true 2D dirty rect (diagnostics; not the dispatch size) */
  readonly dirtyTexels: number;
  /** texels the partial dispatch would actually recompute (the band) */
  readonly dispatchTexels: number;
  readonly totalTexels: number;
  /**
   * ACTUAL for the height composition stage: ORIGINAL surface indices the
   * compose shaders genuinely iterate on a partial frame (surfaces whose
   * conservative footprint intersects the dispatch band). Full frames carry
   * every index (`0..surfaceCount-1`). Empty on a zero-candidate band (the
   * compose shaders then write the cleared/background outputs directly).
   */
  readonly candidateIndices: readonly number[];
  /**
   * ACTUAL for the height composition stage: `candidateIndices.length`
   * (== surfaceCount on full frames).
   */
  readonly candidateSurfaceCount: number;
  /** ACTUAL: surfaces genuinely excluded from the compose loops. */
  readonly culledSurfaceCount: number;
  /** the true 2D dirty texel rect (with all halos), clipped; null on full plans without a region */
  readonly dirtyRect: TileRect | null;
  /** the conservative dispatch band; non-null exactly when mode === "partial" */
  readonly band: BandRegion | null;
}

/** Inputs to the partial planner (all effective/deterministic values). */
export interface PlanPartialInput {
  /** exact bytes of the previous successful frame's encoded scene */
  readonly prevBytes: Uint8Array;
  /** exact bytes of the current encoded scene */
  readonly nextBytes: Uint8Array;
  readonly dpr: number;
  readonly renderWidth: number;
  readonly renderHeight: number;
  /** CPU-compatible shadow options; sanitized exactly like the shadow pass */
  readonly shadowOptions?: ShadowOptions;
  readonly tileSize?: number;
}

/**
 * Build the deterministic tile grid for a render extent. The tile size is
 * clamped into `[TILE_SIZE_MIN, TILE_SIZE_MAX]` (documented policy), so an
 * explicit out-of-range request degrades deterministically instead of
 * failing at dispatch time.
 */
export function computeTileGrid(width: number, height: number, tileSize?: number): TileGrid {
  assertPositiveInt(width, "render width");
  assertPositiveInt(height, "render height");
  const size = clampTileSize(tileSize ?? TILE_SIZE_DEFAULT);
  const tilesX = Math.ceil(width / size);
  const tilesY = Math.ceil(height / size);
  return {
    width,
    height,
    tileSize: size,
    tilesX,
    tilesY,
    tileCount: tilesX * tilesY,
    tileRectAt(tileX: number, tileY: number): TileRect {
      if (
        !Number.isInteger(tileX) ||
        !Number.isInteger(tileY) ||
        tileX < 0 ||
        tileY < 0 ||
        tileX >= tilesX ||
        tileY >= tilesY
      ) {
        throw new RangeError(
          `tile (${tileX}, ${tileY}) out of range for a ${tilesX}x${tilesY} grid`,
        );
      }
      const x = tileX * size;
      const y = tileY * size;
      return {
        x,
        y,
        width: Math.min(size, width - x),
        height: Math.min(size, height - y),
      };
    },
  };
}

export function clampTileSize(tileSize: number): number {
  if (!Number.isFinite(tileSize)) {
    return TILE_SIZE_DEFAULT;
  }
  const rounded = Math.round(tileSize);
  if (!Number.isSafeInteger(rounded) || rounded < TILE_SIZE_MIN) {
    return TILE_SIZE_MIN;
  }
  if (rounded > TILE_SIZE_MAX) {
    return TILE_SIZE_MAX;
  }
  return rounded;
}

/**
 * Conservative texel footprint of a scene-space AABB at a DPR: texels whose
 * cell `[tx/dpr, (tx+1)/dpr)` overlaps the AABB, expanded by
 * `PROFILE_HALO_TEXELS` on every side (bevel/profile boundary support and
 * the half-texel-center sampling), clipped to the render extent. Returns
 * `null` when the footprint does not intersect the extent (empty or
 * entirely out-of-view bounds).
 */
export function sceneRectToTexelRect(
  rect: SceneRect,
  dpr: number,
  renderWidth: number,
  renderHeight: number,
): TileRect | null {
  if (!Number.isFinite(dpr) || dpr <= 0) {
    throw new RangeError(`dpr must be finite and > 0, got ${dpr}`);
  }
  const x0 = Math.floor(rect.minX * dpr);
  const y0 = Math.floor(rect.minY * dpr);
  const x1 = Math.ceil(rect.maxX * dpr) - 1;
  const y1 = Math.ceil(rect.maxY * dpr) - 1;
  if (!(x1 >= x0 && y1 >= y0)) {
    return null;
  }
  const clippedX0 = Math.max(0, x0);
  const clippedY0 = Math.max(0, y0);
  const clippedX1 = Math.min(renderWidth - 1, x1);
  const clippedY1 = Math.min(renderHeight - 1, y1);
  if (clippedX1 < clippedX0 || clippedY1 < clippedY0) {
    return null;
  }
  return {
    x: clippedX0,
    y: clippedY0,
    width: clippedX1 - clippedX0 + 1,
    height: clippedY1 - clippedY0 + 1,
  };
}

/** Expand a texel rect by `haloTexels` on every side, clipped to the extent. */
export function expandTexelRect(
  rect: TileRect,
  haloTexels: number,
  renderWidth: number,
  renderHeight: number,
): TileRect | null {
  const halo = Math.max(0, Math.floor(haloTexels));
  const x0 = Math.max(0, rect.x - halo);
  const y0 = Math.max(0, rect.y - halo);
  const x1 = Math.min(renderWidth - 1, rect.x + rect.width - 1 + halo);
  const y1 = Math.min(renderHeight - 1, rect.y + rect.height - 1 + halo);
  if (x1 < x0 || y1 < y0) {
    return null;
  }
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/**
 * Conservative down-light shadow expansion of a scene rect for ONE march
 * direction: receivers whose cast-shadow ray (marching along the normalized
 * direction `D.xy`) can pass through the rect are exactly
 * `rect - D.xy * t` for `t in [0, maxDistance]`, whose axis-aligned bound is:
 *
 *     left   += maxDistance * max( D.x, 0)
 *     right  += maxDistance * max(-D.x, 0)
 *     top    += maxDistance * max( D.y, 0)
 *     bottom += maxDistance * max(-D.y, 0)
 *
 * `maxDistance` is the SANITIZED effective shadow option (default
 * `sceneDiagonal / |L.xy|` of the CENTER light direction — the ONE shared
 * value every #41 sample ray also marches; see `sanitizeShadowOptions`). The
 * shadow pass's early-exit bound (`rayZ > maxCasterHeight + bias`) cannot
 * flip a retained texel outside this expansion: beyond the bound no
 * unchanged sample can exceed `rayZ + bias`, and any sample that newly
 * occludes lies in the changed region itself (whose footprint is inside the
 * dirty rect).
 */
export function shadowHalo(lightX: number, lightY: number, maxDistance: number): ShadowHalo {
  if (!Number.isFinite(maxDistance) || maxDistance < 0) {
    throw new RangeError(`maxDistance must be finite and >= 0, got ${maxDistance}`);
  }
  return {
    left: maxDistance * Math.max(lightX, 0),
    right: maxDistance * Math.max(-lightX, 0),
    top: maxDistance * Math.max(lightY, 0),
    bottom: maxDistance * Math.max(-lightY, 0),
  };
}

/**
 * #43 conservative shadow halo of the SOFT path: the component-wise UNION of
 * `shadowHalo(dir.x, dir.y, maxDistance)` over EVERY area-light sample
 * direction the ShadowPass actually marches on a soft frame — all
 * `SHADOW_KERNEL_VARIANTS` kernel variants x `samples` Vogel-disk cone
 * directions, computed by the EXACT canonical host helper the pass uses
 * (`computeSoftSampleDirectionVariants`; identical f32 components), never a
 * planner-local approximation. The CENTER direction's halo is included as
 * the baseline, so the result is always a superset of the historical
 * hard-path `shadowHalo(L)` — a soft plan can only widen the dirty region,
 * never shrink it.
 *
 * `maxDistance` semantics match the ShadowPass exactly: the pass packs ONE
 * sanitized scalar (the center-direction default `sceneDiagonal / |L.xy|`
 * when unconfigured) and every sample ray marches that SAME distance, so the
 * union reuses it verbatim instead of deriving per-sample defaults.
 *
 * Pure and deterministic: the same canonical direction inputs always produce
 * the same halo. Cost is bounded (<= SHADOW_KERNEL_VARIANTS * 16 directions,
 * host-only, per partial planning call).
 */
export function sampledShadowHaloUnion(
  lightDirection: { x: number; y: number; z: number },
  angularRadius: number,
  samples: number,
  maxDistance: number,
): ShadowHalo {
  if (!Number.isFinite(maxDistance) || maxDistance < 0) {
    throw new RangeError(`maxDistance must be finite and >= 0, got ${maxDistance}`);
  }
  // Conservative baseline: the center direction itself.
  const center = shadowHalo(lightDirection.x, lightDirection.y, maxDistance);
  const union = {
    left: center.left,
    right: center.right,
    top: center.top,
    bottom: center.bottom,
  };
  // The EXACT canonical per-variant direction arrays the ShadowPass packs
  // into its uniform (same f32 components, same variant rotations).
  const variants = computeSoftSampleDirectionVariants(
    lightDirection,
    angularRadius,
    samples,
  );
  for (const dirs of variants) {
    for (let i = 0; i + 2 < dirs.length; i += 3) {
      const dx = dirs[i]!;
      const dy = dirs[i + 1]!;
      if (dx > 0) {
        union.left = Math.max(union.left, maxDistance * dx);
      } else if (dx < 0) {
        union.right = Math.max(union.right, maxDistance * -dx);
      }
      if (dy > 0) {
        union.top = Math.max(union.top, maxDistance * dy);
      } else if (dy < 0) {
        union.bottom = Math.max(union.bottom, maxDistance * -dy);
      }
    }
  }
  return union;
}

/** Expand a scene rect by a shadow halo (returns a fresh rect). */
export function expandSceneRect(rect: SceneRect, halo: ShadowHalo): SceneRect {
  return {
    minX: rect.minX - halo.left,
    minY: rect.minY - halo.top,
    maxX: rect.maxX + halo.right,
    maxY: rect.maxY + halo.bottom,
  };
}

/**
 * The conservative dispatch band: the full-width row range covering every
 * tile overlapping the dirty rect (from the first dirty tile row through the
 * last), clipped to the render height. The passes dispatch the contiguous
 * 1D texel range `[y0 * width, (y1 + 1) * width)`.
 */
export function bandForDirtyRect(
  dirtyRect: TileRect,
  tileSize: number,
  renderHeight: number,
): BandRegion {
  const firstRow = Math.floor(dirtyRect.y / tileSize);
  const lastRow = Math.floor((dirtyRect.y + dirtyRect.height - 1) / tileSize);
  const y0 = firstRow * tileSize;
  const y1 = Math.min((lastRow + 1) * tileSize, renderHeight) - 1;
  return { y0, y1 };
}

/** Tile rects overlapping a texel rect, in row-major tile order. */
export function tilesOverlappingRect(grid: TileGrid, rect: TileRect): TileRect[] {
  const out: TileRect[] = [];
  const firstRow = Math.floor(rect.y / grid.tileSize);
  const lastRow = Math.floor((rect.y + rect.height - 1) / grid.tileSize);
  const firstCol = Math.floor(rect.x / grid.tileSize);
  const lastCol = Math.floor((rect.x + rect.width - 1) / grid.tileSize);
  for (let ty = firstRow; ty <= lastRow; ty++) {
    for (let tx = firstCol; tx <= lastCol; tx++) {
      out.push(grid.tileRectAt(tx, ty));
    }
  }
  return out;
}

/**
 * Conservative texel footprint of one ABI surface record (bounds f32s at
 * SURFACE_OFFSET_BOUNDS) at a DPR: cell overlap + PROFILE_HALO_TEXELS,
 * clipped to the extent; `null` for fully out-of-view bounds.
 */
export function surfaceTexelFootprint(
  record: Uint8Array,
  dpr: number,
  renderWidth: number,
  renderHeight: number,
): TileRect | null {
  if (record.byteLength < SURFACE_STRIDE) {
    throw new RangeError(`surface record too short: ${record.byteLength} < ${SURFACE_STRIDE}`);
  }
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const rect: SceneRect = {
    minX: view.getFloat32(SURFACE_OFFSET_BOUNDS + 0, true),
    minY: view.getFloat32(SURFACE_OFFSET_BOUNDS + 4, true),
    maxX: view.getFloat32(SURFACE_OFFSET_BOUNDS + 8, true),
    maxY: view.getFloat32(SURFACE_OFFSET_BOUNDS + 12, true),
  };
  const raw = sceneRectToTexelRect(rect, dpr, renderWidth, renderHeight);
  if (raw === null) {
    return null;
  }
  return expandTexelRect(raw, PROFILE_HALO_TEXELS, renderWidth, renderHeight);
}

/**
 * Exact comparison of two encoded scenes (never hash-based). See the module
 * docs for the fallback rules.
 */
export function diffEncodedScenes(prev: Uint8Array, next: Uint8Array): SceneDiffResult {
  const prevHeader = parseHeader(prev);
  const nextHeader = parseHeader(next);
  const full = (fullFallbackReason: string): SceneDiffResult => ({
    fullFallback: true,
    fullFallbackReason,
    dirtySceneRect: null,
    changedSurfaceIndices: [],
    addedOrRemovedSurfaceIndices: [],
  });
  if (
    prevHeader.renderWidth !== nextHeader.renderWidth ||
    prevHeader.renderHeight !== nextHeader.renderHeight ||
    prevHeader.dpr !== nextHeader.dpr
  ) {
    return full("viewport-change");
  }
  const light = prevHeader.lightDirection;
  const nextLight = nextHeader.lightDirection;
  if (
    light.x !== nextLight.x ||
    light.y !== nextLight.y ||
    light.z !== nextLight.z ||
    prevHeader.lightIntensity !== nextHeader.lightIntensity ||
    prevHeader.exposure !== nextHeader.exposure ||
    prevHeader.environment.intensity !== nextHeader.environment.intensity ||
    prevHeader.environment.diffuseIntensity !== nextHeader.environment.diffuseIntensity ||
    prevHeader.environment.specularIntensity !== nextHeader.environment.specularIntensity
  ) {
    return full("light-or-environment-change");
  }
  const surfacesOffset = HEADER_SIZE;
  const prevLayout = sceneSectionLayout(prevHeader);
  const nextLayout = sceneSectionLayout(nextHeader);
  const materialBytes = nextHeader.materialCount * MATERIAL_STRIDE;
  if (prevHeader.materialCount !== nextHeader.materialCount) {
    return full("material-table-change");
  }
  if (
    prevHeader.surfaceCount === nextHeader.surfaceCount &&
    prevHeader.maskCount === nextHeader.maskCount &&
    !bytesEqual(
      prev.subarray(prevLayout.materialsOffset, prevLayout.materialsOffset + materialBytes),
      next.subarray(nextLayout.materialsOffset, nextLayout.materialsOffset + materialBytes),
    )
  ) {
    return full("material-table-change");
  }

  const changed = new Set<number>();
  const addedOrRemoved: number[] = [];
  const shared = Math.min(prevHeader.surfaceCount, nextHeader.surfaceCount);
  const total = Math.max(prevHeader.surfaceCount, nextHeader.surfaceCount);
  for (let i = 0; i < shared; i++) {
    const prevRecord = prev.subarray(surfacesOffset + i * SURFACE_STRIDE, surfacesOffset + (i + 1) * SURFACE_STRIDE);
    const nextRecord = next.subarray(surfacesOffset + i * SURFACE_STRIDE, surfacesOffset + (i + 1) * SURFACE_STRIDE);
    if (!bytesEqual(prevRecord, nextRecord)) {
      changed.add(i);
    }
  }
  for (let i = shared; i < total; i++) {
    addedOrRemoved.push(i);
  }

  // Content-changed masks (record bytes or alpha blob bytes). Index shifts
  // from mask add/remove are covered by the surface-record comparison (the
  // ABI maskIndex field of every affected surface changes).
  const changedMasks = new Set<number>();
  const sharedMasks = Math.min(prevHeader.maskCount, nextHeader.maskCount);
  for (let i = 0; i < sharedMasks; i++) {
    const prevRecord = prev.subarray(
      prevLayout.masksOffset + i * MASK_STRIDE,
      prevLayout.masksOffset + (i + 1) * MASK_STRIDE,
    );
    const nextRecord = next.subarray(
      nextLayout.masksOffset + i * MASK_STRIDE,
      nextLayout.masksOffset + (i + 1) * MASK_STRIDE,
    );
    if (!bytesEqual(prevRecord, nextRecord)) {
      changedMasks.add(i);
      continue;
    }
    const view = new DataView(prevRecord.buffer, prevRecord.byteOffset, prevRecord.byteLength);
    const pixelOffset = view.getUint32(MASK_OFFSET_PIXEL_OFFSET, true);
    const alphaBytes = view.getUint32(MASK_OFFSET_ALPHA_BYTE_LENGTH, true);
    const prevBlob = prev.subarray(pixelOffset, pixelOffset + alphaBytes);
    const nextBlob = next.subarray(pixelOffset, pixelOffset + alphaBytes);
    if (prevBlob.byteLength !== nextBlob.byteLength || !bytesEqual(prevBlob, nextBlob)) {
      changedMasks.add(i);
    }
  }
  const maskAffected = new Set<number>();
  if (changedMasks.size > 0) {
    const view = new DataView(next.buffer, next.byteOffset, next.byteLength);
    for (let i = 0; i < nextHeader.surfaceCount; i++) {
      const record = next.subarray(surfacesOffset + i * SURFACE_STRIDE, surfacesOffset + (i + 1) * SURFACE_STRIDE);
      const recordView = new DataView(record.buffer, record.byteOffset, record.byteLength);
      const maskIndex = recordView.getUint32(SURFACE_OFFSET_MASK_INDEX, true);
      if (changedMasks.has(maskIndex)) {
        maskAffected.add(i);
      }
    }
  }

  if (changed.size === 0 && addedOrRemoved.length === 0 && maskAffected.size === 0) {
    if (bytesEqual(prev, next)) {
      // byte-identical scenes: nothing to diff (the scheduler never routes
      // an identical frame here, but the planner stays self-consistent)
      return {
        fullFallback: false,
        fullFallbackReason: null,
        dirtySceneRect: null,
        changedSurfaceIndices: [],
        addedOrRemovedSurfaceIndices: [],
      };
    }
    return full("unknown-mutation");
  }

  const affected = new Set<number>([...changed, ...addedOrRemoved, ...maskAffected]);
  const boundsAt = (bytes: Uint8Array, index: number): SceneRect => {
    const record = bytes.subarray(surfacesOffset + index * SURFACE_STRIDE, surfacesOffset + (index + 1) * SURFACE_STRIDE);
    const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
    return {
      minX: view.getFloat32(SURFACE_OFFSET_BOUNDS + 0, true),
      minY: view.getFloat32(SURFACE_OFFSET_BOUNDS + 4, true),
      maxX: view.getFloat32(SURFACE_OFFSET_BOUNDS + 8, true),
      maxY: view.getFloat32(SURFACE_OFFSET_BOUNDS + 12, true),
    };
  };
  let dirty: SceneRect | null = null;
  const union = (rect: SceneRect): void => {
    if (dirty === null) {
      dirty = {
        minX: rect.minX,
        minY: rect.minY,
        maxX: rect.maxX,
        maxY: rect.maxY,
      };
      return;
    }
    dirty = {
      minX: Math.min(dirty.minX, rect.minX),
      minY: Math.min(dirty.minY, rect.minY),
      maxX: Math.max(dirty.maxX, rect.maxX),
      maxY: Math.max(dirty.maxY, rect.maxY),
    };
  };
  for (const index of affected) {
    // changed surfaces: union of the OLD and NEW footprints (a moved or
    // removed surface leaves its previous footprint dirty too)
    if (index < prevHeader.surfaceCount) {
      union(boundsAt(prev, index));
    }
    if (index < nextHeader.surfaceCount) {
      union(boundsAt(next, index));
    }
  }
  return {
    fullFallback: false,
    fullFallbackReason: null,
    dirtySceneRect: dirty,
    changedSurfaceIndices: [...changed].sort((a, b) => a - b),
    addedOrRemovedSurfaceIndices: addedOrRemoved,
  };
}

/**
 * The full deterministic partial/full decision for one frame. See the
 * module docs for the halo rules and the documented coverage threshold.
 *
 * `candidateIndices` are ACTUAL for the height composition stage and are
 * derived from the DISPATCH BAND (not the narrow dirty rect): the band's
 * texels are all overwritten by the compose passes, so every surface whose
 * conservative footprint intersects the band must be iterated. Full frames
 * carry the identity list `0..surfaceCount-1` (the compose shaders use the
 * full-frame sentinel and iterate all original indices).
 */
export function planPartialScene(input: PlanPartialInput): PartialPlan {
  const grid = computeTileGrid(input.renderWidth, input.renderHeight, input.tileSize);
  const totalTexels = input.renderWidth * input.renderHeight;
  const header = parseHeader(input.nextBytes);
  const allIndices = Array.from({ length: header.surfaceCount }, (_, i) => i);
  const candidatesFor = (rect: TileRect): readonly number[] =>
    binSurfaceIndices(input.nextBytes, rect, input.dpr, input.renderWidth, input.renderHeight);
  const base: PartialPlan = {
    mode: "full",
    reason: "no-scene-change",
    tileSize: grid.tileSize,
    totalTileCount: grid.tileCount,
    dirtyTileCount: 0,
    dirtyTexels: 0,
    dispatchTexels: totalTexels,
    totalTexels,
    candidateIndices: allIndices,
    candidateSurfaceCount: header.surfaceCount,
    culledSurfaceCount: 0,
    dirtyRect: null,
    band: null,
  };
  const diff = diffEncodedScenes(input.prevBytes, input.nextBytes);
  if (diff.fullFallback) {
    return { ...base, reason: diff.fullFallbackReason ?? "unknown-mutation" };
  }
  if (diff.dirtySceneRect === null) {
    return base;
  }
  const sceneDiagonal = Math.hypot(
    header.renderWidth / header.dpr,
    header.renderHeight / header.dpr,
  );
  const lightXYLength = Math.hypot(header.lightDirection.x, header.lightDirection.y);
  const effective = sanitizeShadowOptions(input.shadowOptions, {
    sceneDiagonal,
    lightXYLength,
  });
  // #43 the shadow dirty halo must cover EVERY direction the ShadowPass
  // actually marches. On the soft path (positive sanitized angular radius
  // AND samples > 1) that is the full kernel-variant x sample cone — the
  // union of all canonical sample-direction halos; on the hard path it stays
  // exactly the historical center-direction expansion. Both branches share
  // the ONE sanitized effective maxDistance the pass packs for every ray.
  const angularRadius = sanitizeAngularRadius(header.lightAngularRadius);
  const halo =
    angularRadius > 0 && effective.samples > 1
      ? sampledShadowHaloUnion(
          header.lightDirection,
          angularRadius,
          effective.samples,
          effective.maxDistance,
        )
      : shadowHalo(header.lightDirection.x, header.lightDirection.y, effective.maxDistance);
  const expanded = expandSceneRect(diff.dirtySceneRect, halo);
  const raw = sceneRectToTexelRect(expanded, input.dpr, input.renderWidth, input.renderHeight);
  if (raw === null) {
    return { ...base, reason: "fallback:empty-dirty-region" };
  }
  const dirtyRect = expandTexelRect(raw, PROFILE_HALO_TEXELS, input.renderWidth, input.renderHeight);
  if (dirtyRect === null) {
    return { ...base, reason: "fallback:empty-dirty-region" };
  }
  const dirtyTiles = tilesOverlappingRect(grid, dirtyRect);
  const band = bandForDirtyRect(dirtyRect, grid.tileSize, input.renderHeight);
  const dispatchTexels = input.renderWidth * (band.y1 - band.y0 + 1);
  const dirtyTexels = dirtyRect.width * dirtyRect.height;
  const coverage = dispatchTexels / totalTexels;
  const withDiagnostics: PartialPlan = {
    ...base,
    dirtyTileCount: dirtyTiles.length,
    dirtyTexels,
    dispatchTexels,
    dirtyRect,
  };
  if (dispatchTexels >= totalTexels || coverage > PARTIAL_DISPATCH_RATIO) {
    return {
      ...withDiagnostics,
      mode: "full",
      reason: `band-coverage ${coverage.toFixed(3)} > ${PARTIAL_DISPATCH_RATIO}`,
      band: null,
    };
  }
  // ACTUAL height-stage culling: the compose passes overwrite the WHOLE
  // band, so candidates are binned against the band rect (a zero-candidate
  // band — e.g. an isolated surface deletion — stays partial: the compose
  // shaders write the cleared/background outputs directly).
  const candidateIndices = candidatesFor({
    x: 0,
    y: band.y0,
    width: input.renderWidth,
    height: band.y1 - band.y0 + 1,
  });
  return {
    ...withDiagnostics,
    mode: "partial",
    reason: `band ${band.y0}..${band.y1} coverage ${coverage.toFixed(3)}`,
    candidateIndices,
    candidateSurfaceCount: candidateIndices.length,
    culledSurfaceCount: header.surfaceCount - candidateIndices.length,
    band,
  };
}

/**
 * Deterministic conservative surface binning: the ORIGINAL surface indices
 * whose conservative texel footprint (cell overlap + PROFILE_HALO_TEXELS,
 * clipped) intersects `rect`, in ascending index order. This is the
 * candidate list the height compose passes genuinely iterate on a partial
 * frame; every other surface is culled (its footprint cannot cover any
 * texel of `rect`, so no band texel can depend on it).
 */
export function binSurfaceIndices(
  bytes: Uint8Array,
  rect: TileRect,
  dpr: number,
  renderWidth: number,
  renderHeight: number,
): number[] {
  const header = parseHeader(bytes);
  const surfacesOffset = HEADER_SIZE;
  const out: number[] = [];
  for (let i = 0; i < header.surfaceCount; i++) {
    const record = bytes.subarray(surfacesOffset + i * SURFACE_STRIDE, surfacesOffset + (i + 1) * SURFACE_STRIDE);
    const footprint = surfaceTexelFootprint(record, dpr, renderWidth, renderHeight);
    if (footprint !== null && texelRectsOverlap(footprint, rect)) {
      out.push(i);
    }
  }
  return out;
}

/** True when two clipped texel rects share at least one texel. */
export function texelRectsOverlap(a: TileRect, b: TileRect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/**
 * Validate a dispatch band against the render height: inclusive rows within
 * `[0, height - 1]` with `y0 <= y1`. Returns the band (or null for a full
 * frame). Throws on any invalid region before a device call.
 */
export function assertBandRegion(region: BandRegion | undefined, height: number): BandRegion | null {
  if (region === undefined || region === null) {
    return null;
  }
  const { y0, y1 } = region;
  if (!Number.isInteger(y0) || !Number.isInteger(y1)) {
    throw new RangeError(`region rows must be integers, got y0=${y0} y1=${y1}`);
  }
  if (y0 < 0 || y1 < y0 || y1 >= height) {
    throw new RangeError(
      `region rows ${y0}..${y1} outside the render extent 0..${height - 1}`,
    );
  }
  return { y0, y1 };
}

/**
 * One chunk of a limit-split 1D dispatch: contiguous inclusive texel rows
 * (a full-width band, exactly like a #32 partial dispatch region).
 */
export interface DispatchChunk {
  readonly y0: number;
  readonly y1: number;
  /** `renderWidth * rows` in this chunk */
  readonly texels: number;
  /** `ceil(texels / workgroupSize)`; never above the split budget */
  readonly workgroups: number;
}

/**
 * Split the full-width row range `[startRow..endRow]` into contiguous row
 * chunks whose LINEAR workgroup count stays within
 * `maxComputeWorkgroupsPerDimension`. The WebGPU limit applies PER
 * DIMENSION, so a 1D dispatch above it is illegal even though the total
 * invocation grid is representable; the passes therefore issue several
 * sequential band dispatches instead — every chunk re-packs its
 * yOffset/regionEnd params and submits before the next chunk's uniform
 * write lands (queue operations execute in issue order), so each texel row
 * is computed by exactly one chunk with its own params.
 *
 * Returns null when the whole range fits ONE dispatch (the historical
 * single-dispatch path, byte-for-byte unchanged). Throws only when a
 * SINGLE row already exceeds the budget (render width >
 * maxWorkgroups * workgroupSize texels) — no chunking can help there.
 * Pure function: deterministic in every input, no device calls.
 */
export function planDispatchChunks(
  startRow: number,
  endRow: number,
  renderWidth: number,
  workgroupSize: number,
  maxWorkgroups: number,
): DispatchChunk[] | null {
  const totalTexels = renderWidth * (endRow - startRow + 1);
  if (Math.ceil(totalTexels / workgroupSize) <= maxWorkgroups) {
    return null;
  }
  // Largest row count whose padded dispatch stays within the per-dimension
  // cap: floor keeps rowsPerChunk * renderWidth <= cap * workgroupSize, so
  // ceil(rowsPerChunk * renderWidth / workgroupSize) <= cap exactly.
  const rowsPerChunk = Math.max(1, Math.floor((maxWorkgroups * workgroupSize) / renderWidth));
  const chunks: DispatchChunk[] = [];
  for (let y0 = startRow; y0 <= endRow; y0 += rowsPerChunk) {
    const y1 = Math.min(y0 + rowsPerChunk - 1, endRow);
    const texels = renderWidth * (y1 - y0 + 1);
    const workgroups = Math.ceil(texels / workgroupSize);
    if (workgroups > maxWorkgroups) {
      throw new Error(
        `dispatch chunk of ${workgroups} workgroups exceeds ` +
          `maxComputeWorkgroupsPerDimension ${maxWorkgroups}: one texel row of ` +
          `width ${renderWidth} already needs more than the ${maxWorkgroups} x ` +
          `${workgroupSize} per-dispatch budget`,
      );
    }
    chunks.push({ y0, y1, texels, workgroups });
  }
  return chunks;
}

/** Exact byte equality (the correctness-critical comparison, never hashes). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function assertPositiveInt(v: number, label: string): void {
  if (!Number.isInteger(v) || v <= 0) {
    throw new RangeError(`${label} must be a positive integer, got ${v}`);
  }
}
