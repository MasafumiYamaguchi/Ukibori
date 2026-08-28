import type { EncodedHeader, SceneSectionLayout } from "./layout";
import {
  HEADER_SIZE,
  MATERIAL_OFFSET_FLAGS,
  MATERIAL_STRIDE,
  sceneSectionLayout,
} from "./layout";
import { validateEncodedScene } from "./validate";

/**
 * Exact semantic byte regions of the frozen #24 ABI (single source of truth
 * for the semantic invalidation classifier and the height-field reuse
 * authorization).
 *
 * The encoded scene is ONE buffer, but not every byte feeds every stage:
 *
 * - the #25 height stage (and its derived #26 normal stage) read ONLY the
 *   geometry/structural bytes: header dims/counts/DPR/coordinate flags, the
 *   surface records, the mask records, the mask alpha payloads and the
 *   material FLAGS field (the material-id output's only material-table read;
 *   strict-validated to 0).
 * - the #27 shadow stage reads light direction, surface records
 *   (`receivesShadow`) and the retained height/casterHeight/objectId fields.
 * - the #28 lighting stage reads the light/environment/exposure header
 *   fields, the material table values, and the retained materialId/normal/
 *   visibility fields.
 * - the #29 presentation stage reads the retained color/objectId/visibility
 *   fields and composite options only.
 *
 * So a light/environment/exposure/material-VALUE-only byte change may
 * re-upload the scene and re-run ONLY the downstream stages while the
 * height/normal fields stay retained — PROVIDED the exact height-dependent
 * bytes and extent/DPR are unchanged. Every comparison here is EXACT byte
 * comparison (never a hash): a hash may accelerate scheduling decisions
 * elsewhere, but reuse of GPU-resident fields is only ever authorized by
 * these exact ranges matching.
 */

export interface SceneByteRegion {
  readonly offset: number;
  readonly byteLength: number;
}

/** A height-dependent byte range of an encoded scene (see `heightInputRanges`). */
export type HeightInputRange = SceneByteRegion;

// Module-private runtime authenticity for cross-scene reuse. Public
// structural provenance objects can be hand-built for same-scene test seams,
// but only a successful HeightPass dispatch is registered here and may
// authorize reuse with a different encoded-scene object.
const trustedHeightProvenances = new WeakSet<object>();

/** @internal Called only by HeightPass after a successful dispatch. */
export function registerHeightInputProvenance(provenance: object): void {
  trustedHeightProvenances.add(provenance);
}

/** Header `lightDirection` vec4 (offsets 64..80). Shadow-direction input. */
export const LIGHT_DIRECTION_REGION: SceneByteRegion = { offset: 64, byteLength: 16 };
/** Header `lightIntensity` f32 (offsets 80..84). Lighting-only input. */
export const LIGHT_INTENSITY_REGION: SceneByteRegion = { offset: 80, byteLength: 4 };
/** Header `exposure` f32 (offsets 84..88). Lighting-only input. */
export const EXPOSURE_REGION: SceneByteRegion = { offset: 84, byteLength: 4 };
/**
 * Header #41 `lightAngularRadius` f32 (offsets 88..92): the apparent light
 * size for soft cast shadows. It feeds ONLY the shadow stage's cone
 * directions (and downstream lighting/presentation through visibility) —
 * the height field never reads it, so an angular-radius-only change keeps
 * the retained height/normal fields valid.
 */
export const LIGHT_ANGULAR_RADIUS_REGION: SceneByteRegion = { offset: 88, byteLength: 4 };
/** Header `environment` vec4 (offsets 96..112). Lighting-only input. */
export const ENVIRONMENT_REGION: SceneByteRegion = { offset: 96, byteLength: 16 };
/**
 * Header #45 `lightColor` vec4 (offsets 112..128): the directional light's
 * LINEAR RGB color (w = 0). It feeds ONLY the lighting stage (the direct
 * contribution) — the height field never reads it, so a light-color-only
 * change keeps the retained height/normal/shadow/reconstruction fields
 * valid.
 */
export const LIGHT_COLOR_REGION: SceneByteRegion = { offset: 112, byteLength: 16 };

/**
 * Header bytes the height stage genuinely depends on: everything EXCEPT
 * light direction / intensity / angular radius / color / exposure /
 * environment. Covers the magic/version/length fields, logical+render
 * extents, DPR, section counts, coordinate flags and the remaining reserved
 * word (always zero, strict-validated) — so a count/layout change also lands
 * here and forces the conservative full chain.
 */
export const HEADER_GEOMETRY_REGIONS: readonly SceneByteRegion[] = [
  { offset: 0, byteLength: 64 },
  { offset: 92, byteLength: 4 },
];

/** The material FLAGS field of every record — the ONLY material-table bytes
 * the height stage reads (the material-id output), strict-validated to 0. */
export function materialFlagsRanges(
  header: EncodedHeader,
  layout: SceneSectionLayout,
): readonly SceneByteRegion[] {
  const ranges: SceneByteRegion[] = [];
  for (let i = 0; i < header.materialCount; i++) {
    ranges.push({
      offset: layout.materialsOffset + i * MATERIAL_STRIDE + MATERIAL_OFFSET_FLAGS,
      byteLength: 4,
    });
  }
  return ranges;
}

/**
 * The EXACT height-dependent byte ranges of one encoded scene:
 *
 * 1. the geometry header regions (dims/counts/DPR/flags + reserved)
 * 2. the surfaces section (geometry, flags, materialIndex, transform, bounds)
 * 3. the mask records section (SDF metadata)
 * 4. the mask alpha payload section
 * 5. the material FLAGS field of every record — the ONLY material-table
 *    bytes the height stage reads (`materials[i].flags` in the material-id
 *    compose shader; strict-validated to 0). Material VALUES never feed the
 *    height stage, so they are deliberately absent from this list.
 *
 * The header is strictly validated before this helper runs, so the ranges
 * are always in bounds for the scene they were derived from.
 */
export function heightInputRanges(
  header: EncodedHeader,
  layout: SceneSectionLayout,
): readonly HeightInputRange[] {
  const ranges: HeightInputRange[] = [...HEADER_GEOMETRY_REGIONS];
  ranges.push(
    { offset: layout.surfacesOffset, byteLength: layout.surfacesByteLength },
    { offset: layout.masksOffset, byteLength: layout.masksByteLength },
    { offset: layout.maskPixelsOffset, byteLength: layout.maskPixelsByteLength },
  );
  for (const range of materialFlagsRanges(header, layout)) {
    ranges.push(range);
  }
  return ranges;
}

/**
 * Exact bounds-checked byte comparison of ONE region of two encoded scenes.
 * Any out-of-bounds or non-integer region is a mismatch (a foreign or
 * hand-crafted provenance must never be silently accepted).
 */
export function regionEqual(
  prevBytes: Uint8Array,
  nextBytes: Uint8Array,
  region: SceneByteRegion,
): boolean {
  const { offset, byteLength } = region;
  if (
    !Number.isInteger(offset) ||
    !Number.isInteger(byteLength) ||
    offset < 0 ||
    byteLength < 0 ||
    offset + byteLength > prevBytes.byteLength ||
    offset + byteLength > nextBytes.byteLength
  ) {
    return false;
  }
  for (let i = 0; i < byteLength; i++) {
    if (prevBytes[offset + i] !== nextBytes[offset + i]) {
      return false;
    }
  }
  return true;
}

/** Exact comparison of every region in the list (all must match). */
export function regionsEqual(
  prevBytes: Uint8Array,
  nextBytes: Uint8Array,
  regions: readonly SceneByteRegion[],
): boolean {
  for (const region of regions) {
    if (!regionEqual(prevBytes, nextBytes, region)) {
      return false;
    }
  }
  return true;
}

/**
 * Exact comparison of `byteLength` bytes at DIFFERENT offsets in two
 * buffers. Used for layout-dependent sections (the material VALUES table):
 * two scenes with different surface/mask layouts still carry their material
 * tables at their own `materialsOffset`, so a comparison must pair each
 * scene's OWN offset — a same-offset `regionEqual` would compare shifted
 * sections whenever the layouts differ. Bounds-checked like `regionEqual`
 * (an out-of-bounds range compares unequal — conservative, never a false
 * "identical").
 */
export function regionBytesEqual(
  prevBytes: Uint8Array,
  prevOffset: number,
  nextBytes: Uint8Array,
  nextOffset: number,
  byteLength: number,
): boolean {
  if (
    !Number.isInteger(prevOffset) ||
    !Number.isInteger(nextOffset) ||
    !Number.isInteger(byteLength) ||
    prevOffset < 0 ||
    nextOffset < 0 ||
    byteLength < 0 ||
    prevOffset + byteLength > prevBytes.byteLength ||
    nextOffset + byteLength > nextBytes.byteLength
  ) {
    return false;
  }
  for (let i = 0; i < byteLength; i++) {
    if (prevBytes[prevOffset + i] !== nextBytes[nextOffset + i]) {
      return false;
    }
  }
  return true;
}

/**
 * True when retained height-stage fields (a `HeightPassSnapshot` provenance)
 * may be combined with a freshly uploaded scene: the exact height-dependent
 * portions of the provenance's `sceneBytes` equal the corresponding bytes of
 * the fresh scene AND the total byte length matches. Extent/DPR equality is
 * validated separately by the consuming passes.
 *
 * The public `heightInputs` metadata is diagnostic only and is NEVER trusted
 * for authorization: callers can construct or mutate public objects. The
 * canonical ranges are recomputed from the strictly validated provenance
 * bytes on every cross-scene reuse check. Exact object identity remains the
 * fast path for synthetic fixtures and unchanged scenes.
 */
export function heightInputsMatchScene(
  provenance: {
    readonly sceneBytes: Uint8Array;
    readonly heightInputs?: readonly HeightInputRange[] | undefined;
  },
  sceneBytes: Uint8Array,
): boolean {
  if (provenance.sceneBytes === sceneBytes) return true;
  if (!trustedHeightProvenances.has(provenance)) return false;
  if (provenance.sceneBytes.byteLength !== sceneBytes.byteLength) {
    return false;
  }
  const validation = validateEncodedScene(provenance.sceneBytes);
  if (!validation.ok || validation.header === undefined) return false;
  const layout = sceneSectionLayout(validation.header);
  return regionsEqual(
    provenance.sceneBytes,
    sceneBytes,
    heightInputRanges(validation.header, layout),
  );
}
