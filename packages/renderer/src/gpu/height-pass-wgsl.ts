import { WGSL_SCENE_BASE, WGSL_SCENE_BINDINGS } from "./wgsl";

/**
 * #25 compute-pass WGSL shaders — the first real WebGPU compute pass.
 *
 * Every module declares the FULL frozen #24 scene bindings (group 0,
 * bindings 0–4, verbatim from `WGSL_SCENE_BINDINGS`), and the scene buffers
 * genuinely feed the computation across the pipeline:
 *
 * - sceneHeader (binding 0): read directly for dimensions, counts and DPR
 *   (the SDF pass uses `maskCount`, every compose pass uses
 *   `renderWidth`/`renderHeight`/`surfaceCount`/`materialCount`/`dpr`)
 * - surfaces (binding 1): composed per-texel for geometry, owner and ties
 * - masks (binding 2): the SDF pass reads `width`/`height`/`alphaFormat`/
 *   `pixelOffset` directly from the MaskRecord
 * - maskPixels (binding 3): the GPU mask SDF is generated from the uploaded
 *   alpha (never a CPU-built SDF)
 * - materials (binding 4): the material-id pass reads MaterialRecord
 *   `flags` in a validity-dependent output path (valid scenes are
 *   unchanged: flags are always 0, so materialId == materialIndex)
 *
 * ## Passes
 *
 * The mask-SDF pass writes the padded signed-distance workspace. The
 * composition stage is split into FOUR output-specific compute passes
 * (height, coverage, objectId, materialId) so each stage stays within
 * `maxStorageBuffersPerShaderStage` (spec minimum 8): 5 scene storage
 * bindings + maskMeta + maskWorkspace + exactly ONE output storage = 8,
 * plus the uniform (which does not count). Each compose pass recomputes the
 * deterministic owner (`ownerAt`, pure function of the scene and texel), so
 * all four outputs agree. `HeightPass` documents `composePasses = 4`.
 *
 * ## Pass bindings (group 1, owned by `HeightPass`)
 *
 * | binding | SDF pass | each compose pass | buffer type                          |
 * |---------|----------|-------------------|--------------------------------------|
 * | 0       | uniform  | uniform           | HeightPassParams (16 bytes)          |
 * | 1       | storage  | storage           | maskMeta: array<u32> workspace byte  |
 * |         |          |                   | offsets (one u32 per mask)           |
 * | 2       | storage  | storage           | maskWorkspace: array<f32> (padded    |
 * |         |          |                   | SDF grids, SDF pass writes, compose  |
 * |         |          |                   | reads)                               |
 * | 3       | —        | storage           | exactly ONE output (varies per pass) |
 *
 * ## HeightPassParams — 16 bytes, align 16, little-endian host packing
 *
 * | offset | size | field            | meaning                               |
 * |--------|------|------------------|---------------------------------------|
 * | 0      | 4    | totalMaskCells (u32) | sum over masks of (w+2)*(h+2)
 * |        |      |                  | padded cells (genuinely derived)      |
 * | 4      | 4    | workgroupSize (u32) | documented dispatch workgroup size |
 * | 8      | 4    | _pad0 (u32)      | 0                                     |
 * | 12     | 4    | _pad1 (u32)      | 0                                     |
 *
 * All other pass inputs come from the scene header itself
 * (`sceneHeader.maskCount` etc.), so no host-copied counts are needed.
 *
 * ## maskMeta — array<u32>, one u32 per mask
 *
 * `maskMeta[i]` is the BYTE offset of mask i's padded SDF grid inside
 * `maskWorkspace` — the only genuinely derived per-mask metadata the host
 * provides (cumulative padded-cell bytes). Mask dimensions, format and
 * `pixelOffset` are read DIRECTLY from the ABI `MaskRecord` (the absolute
 * `pixelOffset` is converted to a section-relative blob offset in-shader by
 * subtracting the mask-pixel section base derived from the header).
 */

/** Dispatch workgroup size for every pass (documented, injected into WGSL). */
export const WORKGROUP_SIZE = 64;

/** HeightPassParams uniform byte length (16 bytes, 16-byte aligned). */
export const HEIGHT_PASS_PARAMS_BYTE_LENGTH = 16;

/** maskMeta stride: one u32 (workspace byte offset) per mask. */
export const MASK_META_STRIDE = 4;

const PARAMS_STRUCT = /* wgsl */ `
// #25 pass params (16 bytes, align 16; offsets pinned by height-pass.ts)
struct HeightPassParams {
  totalMaskCells: u32,   //  0 (sum of (mask.width+2)*(mask.height+2) padded cells)
  workgroupSize: u32,    //  4 (documented dispatch workgroup size)
  _pad0: u32,            //  8
  _pad1: u32,            // 12
}                        // size 16, align 16

const WORKGROUP_SIZE: u32 = ${WORKGROUP_SIZE}u;

@group(1) @binding(0) var<uniform> params: HeightPassParams;
// maskMeta[i]: byte offset of mask i's padded SDF grid inside maskWorkspace
@group(1) @binding(1) var<storage, read> maskMeta: array<u32>;
`;

const SDF_GROUP1 = /* wgsl */ `
@group(1) @binding(2) var<storage, read_write> maskWorkspace: array<f32>;

const PAD: u32 = 1u;                          // virtual one-cell transparent padding
const ALPHA_FORMAT_F32: u32 = 0u;
const ALPHA_FORMAT_U8: u32 = 1u;
const U8_INK_THRESHOLD: u32 = 128u;           // alpha >= 128 is ink
const F32_INK_THRESHOLD: f32 = 0.5;           // alpha >= 0.5 is ink
// Largest finite f32 (used as the "no segment" sentinel in the SDF scan).
const F32_MAX: f32 = 3.4028234663852886e+38;

fn readAlphaByte(blobSectionOffset: u32, index: u32) -> u32 {
  let byteOffset = blobSectionOffset + index;
  let word = maskPixels[byteOffset >> 2u];
  return (word >> ((byteOffset & 3u) * 8u)) & 0xffu;
}

fn readAlphaF32(blobSectionOffset: u32, index: u32) -> f32 {
  return bitcast<f32>(maskPixels[(blobSectionOffset + index * 4u) >> 2u]);
}

// Absolute ABI byte offset of the mask-pixel section, derived from the
// header counts (ABI mask pixelOffset is absolute; the bound mask-pixel
// section starts at offset zero).
fn maskPixelsSectionBase() -> u32 {
  return 128u + sceneHeader.surfaceCount * 128u
    + sceneHeader.maskCount * 32u
    + sceneHeader.materialCount * 64u;
}

// Ink of the padded cell (r, c) of the mask at maskIndex. Dimensions,
// format and blob offset come DIRECTLY from the ABI MaskRecord.
fn inkAt(maskIndex: u32, r: u32, c: u32) -> bool {
  let mask = masks[maskIndex];
  if (r < PAD || r >= PAD + mask.height || c < PAD || c >= PAD + mask.width) {
    return false; // virtual transparent padding
  }
  let i = (r - PAD) * mask.width + (c - PAD);
  let blob = mask.pixelOffset - maskPixelsSectionBase();
  if (mask.alphaFormat == ALPHA_FORMAT_U8) {
    return readAlphaByte(blob, i) >= U8_INK_THRESHOLD;
  }
  return readAlphaF32(blob, i) >= F32_INK_THRESHOLD;
}
`;

/**
 * Mask-SDF pass: generates the exact signed distance field of every mask
 * from the UPLOADED alpha (never from a CPU-built SDF). The computation is an
 * exact boundary scan mirroring the CPU oracle `computeMaskSdf`:
 *
 * - the binary silhouette is `alpha >= 0.5` (f32) / `>= 128` (u8)
 * - the raster is padded with one virtual transparent cell so ink touching
 *   the edge has a proper outer boundary (the padded grid is kept in the
 *   result; the raster edge samples `d = 0` exactly)
 * - boundary features live on an even 2x grid (segment x/y at even indices,
 *   padded-cell centers at odd indices), exactly like the CPU oracle
 * - the signed distance from a padded-cell center to the silhouette boundary
 *   segment set is the minimum of: the perpendicular distance to a vertical
 *   segment in the same row band, the perpendicular distance to a horizontal
 *   segment in the same column band, and the Euclidean distance to the
 *   nearest segment endpoint (corner) — each computed by a full, exact scan
 * - the final distance is converted from 2x units to mask-pixel units and
 *   signed negative inside (`distance < 0` is coverage, like every shape)
 *
 * An exact distance transform (EDT) is deliberately deferred to a later
 * issue; this pass is exact, not approximate (no JFA, no altered silhouette).
 *
 * Reads sceneHeader (maskCount), the ABI MaskRecords (width/height/format/
 * pixelOffset), maskPixels (alpha) and maskMeta (workspace byte offsets);
 * the remaining scene bindings are declared and bound but only the SDF
 * inputs are read here. Storage bindings: 5 scene + maskMeta + workspace = 7.
 */
export const MASK_SDF_WGSL = /* wgsl */ `
${WGSL_SCENE_BASE}
${WGSL_SCENE_BINDINGS}
${PARAMS_STRUCT}
${SDF_GROUP1}

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let g = gid.x;
  if (g >= params.totalMaskCells) {
    return; // in-shader bounds guard
  }
  // Global cell -> (mask index, cell inside the mask). Padded grids are laid
  // out back-to-back in mask order, so the cumulative cell count locates the
  // mask (maskCount is bounded and small; a linear scan is exact). Cell
  // counts are derived from the ABI MaskRecords.
  var maskIndex = 0u;
  var cellBase = 0u;
  for (var m = 0u; m < sceneHeader.maskCount; m++) {
    let mask = masks[m];
    let cells = (mask.width + 2u) * (mask.height + 2u);
    if (g < cellBase + cells) {
      maskIndex = m;
      break;
    }
    cellBase += cells;
  }
  let mask = masks[maskIndex];
  let pw = mask.width + 2u;
  let ph = mask.height + 2u;
  let cell = g - cellBase;
  let c = cell % pw;
  let r = cell / pw;
  let px = f32(2u * c + 1u); // padded-cell center in 2x units
  let py = f32(2u * r + 1u);

  // Perpendicular distance to the nearest vertical boundary segment in this
  // row band (vertical segments sit at even 2x x positions).
  var vert = F32_MAX;
  for (var cc = 0u; cc < pw; cc++) {
    if (cc + 1u < pw && inkAt(maskIndex, r, cc) != inkAt(maskIndex, r, cc + 1u)) {
      vert = min(vert, abs(px - f32(2u * cc + 2u)));
    }
  }
  // Perpendicular distance to the nearest horizontal boundary segment in this
  // column band.
  var hor = F32_MAX;
  for (var rr = 0u; rr < ph; rr++) {
    if (rr + 1u < ph && inkAt(maskIndex, rr, c) != inkAt(maskIndex, rr + 1u, c)) {
      hor = min(hor, abs(py - f32(2u * rr + 2u)));
    }
  }
  // Euclidean distance to the nearest boundary segment endpoint (corner).
  var corner = F32_MAX;
  for (var rr = 0u; rr < ph; rr++) {
    for (var cc = 0u; cc < pw; cc++) {
      if (cc + 1u < pw && inkAt(maskIndex, rr, cc) != inkAt(maskIndex, rr, cc + 1u)) {
        let ex = f32(2u * cc + 2u);
        let ey0 = f32(2u * rr);
        let ey1 = f32(2u * rr + 2u);
        let dx0 = px - ex;
        corner = min(corner, dx0 * dx0 + (py - ey0) * (py - ey0));
        corner = min(corner, dx0 * dx0 + (py - ey1) * (py - ey1));
      }
      if (rr + 1u < ph && inkAt(maskIndex, rr, cc) != inkAt(maskIndex, rr + 1u, cc)) {
        let ey = f32(2u * rr + 2u);
        let ex0 = f32(2u * cc);
        let ex1 = f32(2u * cc + 2u);
        let dy0 = py - ey;
        corner = min(corner, (px - ex0) * (px - ex0) + dy0 * dy0);
        corner = min(corner, (px - ex1) * (px - ex1) + dy0 * dy0);
      }
    }
  }
  let dist2x = min(vert, min(hor, sqrt(corner)));
  let distance = dist2x * 0.5; // 2x units -> mask-pixel units
  let inside = inkAt(maskIndex, r, c);
  maskWorkspace[(maskMeta[maskIndex] >> 2u) + r * pw + c] =
    select(distance, -distance, inside);
}
`;

// ---------------------------------------------------------------------------
// Composition: four output-specific passes sharing one core. Each stage has
// 5 scene storage bindings + maskMeta + maskWorkspace + exactly ONE output
// storage = 8 (plus the uniform), staying within the spec-minimum
// maxStorageBuffersPerShaderStage of 8. The deterministic owner is
// recomputed per pass, so all four outputs agree.
// ---------------------------------------------------------------------------

const COMPOSE_GROUP1 = /* wgsl */ `
@group(1) @binding(2) var<storage, read> maskWorkspace: array<f32>;
`;

const COMPOSE_CORE = /* wgsl */ `
const SHAPE_ROUNDED_RECT: u32 = 0u;
const SHAPE_MASK: u32 = 1u;
const PROFILE_FLAT: u32 = 0u;
const PROFILE_BEVEL: u32 = 1u;
const NO_OWNER: u32 = 0xffffffffu;
// Most-negative f32: "no geometry" sentinel (CPU uses -Infinity; heights are
// validated >= 0, so the h >= 0 test cleanly separates coverage from
// no-coverage).
const F32_NEG_MAX: f32 = -3.4028234663852886e+38;

struct OwnerResult {
  best: f32,
  owner: u32,
}

// Height of surface i at logical scene position (sx, sy). Returns the
// no-coverage sentinel outside the shape (CPU: -Infinity).
fn shapeHeightAt(i: u32, sx: f32, sy: f32) -> f32 {
  let s = surfaces[i];
  var distance = 0.0;
  if (s.shapeKind == SHAPE_ROUNDED_RECT) {
    let halfW = s.localSize.x * 0.5;
    let halfH = s.localSize.y * 0.5;
    let r = min(s.radius, min(halfW, halfH));
    let pdx = sx - (s.localToSceneRow0.z + halfW);
    let pdy = sy - (s.localToSceneRow1.z + halfH);
    let qx = abs(pdx) - halfW + r;
    let qy = abs(pdy) - halfH + r;
    let outer = length(vec2(max(qx, 0.0), max(qy, 0.0)));
    let inner = min(max(qx, qy), 0.0);
    distance = outer + inner - r;
  } else {
    let maskIndex = s.maskIndex;
    let mask = masks[maskIndex];
    let mw = f32(mask.width);
    let mh = f32(mask.height);
    let px = (sx - s.localToSceneRow0.z) / s.localSize.x * mw;
    let py = (sy - s.localToSceneRow1.z) / s.localSize.y * mh;
    let scale = s.localSize.x / mw;
    let pw = mask.width + 2u;
    let ph = mask.height + 2u;
    let fx = clamp(px + 0.5, 0.0, f32(pw - 1u));
    let fy = clamp(py + 0.5, 0.0, f32(ph - 1u));
    let x0 = u32(floor(fx));
    let y0 = u32(floor(fy));
    let x1 = min(x0 + 1u, pw - 1u);
    let y1 = min(y0 + 1u, ph - 1u);
    let tx = fx - f32(x0);
    let ty = fy - f32(y0);
    let base = maskMeta[maskIndex] >> 2u;
    let v00 = maskWorkspace[base + y0 * pw + x0];
    let v10 = maskWorkspace[base + y0 * pw + x1];
    let v01 = maskWorkspace[base + y1 * pw + x0];
    let v11 = maskWorkspace[base + y1 * pw + x1];
    let top = v00 + (v10 - v00) * tx;
    let bottom = v01 + (v11 - v01) * tx;
    distance = (top + (bottom - top) * ty) * scale;
  }
  if (distance >= 0.0) {
    return F32_NEG_MAX; // no coverage
  }
  if (s.profileKind == PROFILE_FLAT) {
    return s.elevation + s.thickness;
  }
  if (s.bevelWidth <= 0.0) {
    return s.elevation + s.thickness; // zero bevel width degenerates to flat
  }
  let u = clamp((distance + s.bevelWidth) / s.bevelWidth, 0.0, 1.0);
  let falloff = u * u * (3.0 - 2.0 * u);
  return s.elevation + s.thickness * (1.0 - falloff);
}

// Deterministic owner composition, mirroring composeHeightField: larger
// f32 height wins, exact ties go to the later surface (paint order == array
// order); background has height 0 and no owner. Every compose pass calls
// this, so height/coverage/objectId/materialId always agree.
fn ownerAt(sx: f32, sy: f32) -> OwnerResult {
  var best = 0.0;
  var owner = NO_OWNER;
  for (var i = 0u; i < sceneHeader.surfaceCount; i++) {
    let s = surfaces[i];
    // Conservative ABI bounds cull before SDF evaluation.
    if (sx < s.bounds.x || sx > s.bounds.z || sy < s.bounds.y || sy > s.bounds.w) {
      continue;
    }
    let h = shapeHeightAt(i, sx, sy);
    if (h >= 0.0) {
      if (h > best || h == best) {
        best = h;
        owner = i;
      }
    }
  }
  return OwnerResult(best, owner);
}
`;

const COMPOSE_MAIN_PRELUDE = /* wgsl */ `
@compute @workgroup_size(WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let g = gid.x;
  let texelCount = sceneHeader.renderWidth * sceneHeader.renderHeight;
  if (g >= texelCount) {
    return; // in-shader bounds guard
  }
  let tx = g % sceneHeader.renderWidth;
  let ty = g / sceneHeader.renderWidth;
  let sx = (f32(tx) + 0.5) / sceneHeader.dpr;
  let sy = (f32(ty) + 0.5) / sceneHeader.dpr;
  let r = ownerAt(sx, sy);
`;

/** Build one output-specific composition module (all five scene bindings). */
function composeModule(outputBinding: string, writeBody: string): string {
  return `${WGSL_SCENE_BASE}
${WGSL_SCENE_BINDINGS}
${PARAMS_STRUCT}
${COMPOSE_GROUP1}
${outputBinding}
${COMPOSE_CORE}
${COMPOSE_MAIN_PRELUDE}
${writeBody}
}
`;
}

/**
 * Height output pass: writes `best` (absolute scene-space z; 0 for
 * background/base plane). Reads sceneHeader for dims/counts/DPR and
 * SurfaceRecords for geometry/owner (plus MaskRecords/workspace for mask
 * shapes).
 */
export const COMPOSE_HEIGHT_WGSL = composeModule(
  "@group(1) @binding(3) var<storage, read_write> outHeight: array<f32>;",
  `  outHeight[g] = select(0.0, r.best, r.owner != NO_OWNER);`,
);

/** Coverage output pass: 1 when a surface owns the texel, 0 for background. */
export const COMPOSE_COVERAGE_WGSL = composeModule(
  "@group(1) @binding(3) var<storage, read_write> outCoverage: array<u32>;",
  `  outCoverage[g] = select(0u, 1u, r.owner != NO_OWNER);`,
);

/** Object-id output pass: ABI surface index of the owner, or NO_OWNER. */
export const COMPOSE_OBJECT_ID_WGSL = composeModule(
  "@group(1) @binding(3) var<storage, read_write> outObjectId: array<u32>;",
  `  outObjectId[g] = r.owner;`,
);

/**
 * Material-id output pass: the MaterialRecord is genuinely read in a
 * validity-dependent path — the record's `flags` must be 0 for the id to be
 * written (strict validation guarantees this for valid scenes, so
 * materialId == materialIndex and CPU parity is preserved); an out-of-range
 * material index also yields NO_OWNER instead of a garbage write.
 */
export const COMPOSE_MATERIAL_ID_WGSL = composeModule(
  "@group(1) @binding(3) var<storage, read_write> outMaterialId: array<u32>;",
  `  if (r.owner != NO_OWNER) {
    let matIndex = surfaces[r.owner].materialIndex;
    if (matIndex < sceneHeader.materialCount) {
      outMaterialId[g] = select(matIndex, NO_OWNER, materials[matIndex].flags != 0u);
    } else {
      outMaterialId[g] = NO_OWNER;
    }
  } else {
    outMaterialId[g] = NO_OWNER;
  }`,
);
