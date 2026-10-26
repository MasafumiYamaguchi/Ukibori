import type { EncodedHeader, SceneSectionLayout } from "./layout";
import { MATERIAL_STRIDE, SURFACE_STRIDE, SURFACE_OFFSET_MATERIAL_INDEX, SURFACE_OFFSET_TRANSFORM_ROW0, SURFACE_OFFSET_TRANSFORM_ROW1 } from "./layout";

// One material plus local origin per SURFACE. Lighting replaces two existing
// bindings (material table/id -> shading table/objectId), staying at 8 storage
// buffers. Shared material refs therefore still have independent local origins.
export const SHADING_RECORD_STRIDE = 80;
export function hasGrain(bytes: Uint8Array, header: EncodedHeader, layout: SceneSectionLayout): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < header.materialCount; i++) {
    if (view.getFloat32(layout.materialsOffset + i * MATERIAL_STRIDE + 52, true) > 0) return true;
  }
  return false;
}
export function packGrainInputs(bytes: Uint8Array, header: EncodedHeader, layout: SceneSectionLayout): Uint8Array {
  const out = new Uint8Array(Math.max(SHADING_RECORD_STRIDE, header.surfaceCount * SHADING_RECORD_STRIDE));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < header.surfaceCount; i++) {
    const surface = layout.surfacesOffset + i * SURFACE_STRIDE;
    const material = layout.materialsOffset + view.getUint32(surface + SURFACE_OFFSET_MATERIAL_INDEX, true) * MATERIAL_STRIDE;
    const offset = i * SHADING_RECORD_STRIDE;
    out.set(bytes.subarray(material, material + MATERIAL_STRIDE), offset);
    out.set(bytes.subarray(surface + SURFACE_OFFSET_TRANSFORM_ROW0 + 8, surface + SURFACE_OFFSET_TRANSFORM_ROW0 + 12), offset + 64);
    out.set(bytes.subarray(surface + SURFACE_OFFSET_TRANSFORM_ROW1 + 8, surface + SURFACE_OFFSET_TRANSFORM_ROW1 + 12), offset + 68);
  }
  return out;
}
