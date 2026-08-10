# Issue #25 implementation brief — production GPU SDF / height composition

## Context

Issue #24 is approved. It established ABI v1, `encodeScene`, strict byte
validation, `SceneUploader`, five bindable GPU scene sections, and legal
diagnostic staging readback. Treat that contract as frozen for this issue:
do not renumber fields/bindings, change offsets/strides/sentinels, or move DPR
into logical scene geometry.

The TypeScript geometry/composition implementation remains the semantic oracle
and fallback. Preserve unrelated uncommitted Issue #22 and loop-framework work.
Do not make WebGPU the default and do not claim that a mock proves GPU numeric
parity.

## Objective

Implement the first real WebGPU compute pass. A real `GPUDevice` dispatch must
consume the Issue #24 scene buffers and produce GPU-resident height, coverage,
object-ID, and material-ID fields for the render extent. Rounded rectangles,
alpha masks, profiles, bounds culling, overlap, clipping, background, tie
order, and DPR coordinates must match the CPU reference.

## Fixed semantic contract

1. Output extent and sampling:
   - width/height are ABI `renderWidth`/`renderHeight`;
   - render texel `(tx, ty)` samples logical scene position
     `((tx + 0.5) / dpr, (ty + 0.5) / dpr)`;
   - height stays in logical scene/CSS-pixel z units;
   - dispatch is ceil-divided from a documented workgroup size, with an
     in-shader bounds guard.
2. Output fields:
   - height: one f32 per texel, background/base plane `0`;
   - coverage: one u32 per texel, `1` when a surface owns the texel and `0`
     for background;
   - objectId: one u32 per texel, ABI surface index or `NO_OWNER`;
   - materialId: one u32 per texel, ABI material index or `NO_OWNER`.
   Every production output buffer must be `STORAGE | COPY_SRC | COPY_DST`,
   remain unmapped, and be exposed through a stable read-only binding snapshot
   for Issue #26 and later shadow/lighting passes.
3. Composition exactly follows `composeHeightField`:
   - shape coverage is `distance < 0`;
   - a covered zero-height surface still owns its texel;
   - compare f32 heights; larger height wins and exact ties go to the later
     surface/paint order;
   - background has height 0 and no owner/material;
   - negative/offscreen bounds are clipped only by the target extent.
4. Rounded-rectangle SDF and flat/bevel profiles mirror
   `roundedRectSdf`/`evaluateProfile`, including radius clamp, inward-only
   bevel, zero bevel width, and no semantic smoothing.
5. Mask behavior mirrors `computeMaskSdf` + `sampleMaskSdfAt`:
   - f32 alpha uses `>= 0.5`; u8 uses `>= 128`;
   - virtual one-cell transparent padding, true silhouette boundary segments,
     signed distance at padded-grid cell centers, and bilinear sampling must
     match the CPU oracle;
   - mask-to-surface mapping is isotropic and distance scales by
     `localSize.x / mask.width`;
   - the mask SDF must be generated from the uploaded alpha on the GPU. Do not
     call the CPU SDF builder or upload a CPU-generated SDF. An exact,
     straightforward GPU boundary scan is acceptable before a faster exact EDT;
     an approximate JFA or altered silhouette is not.

## Required architecture

1. Add a focused module under `packages/renderer/src/gpu/` that owns:
   - cached real WebGPU shader module/pipeline objects;
   - reusable/growing mask-SDF workspace and four output allocations;
   - any small derived per-mask metadata. Host work may iterate mask records to
     build bounded metadata, but must never iterate output pixels by surfaces
     and must never generate mask SDF pixels on the CPU;
   - explicit `dispose()` and a binding/result snapshot containing output
     buffers, logical byte lengths, formats, width/height, workgroup size, and
     last dispatch dimensions.
2. Consume all five `SceneUploader.getBindings()` buffers directly when
   creating bind groups. A cast at the narrow structural `GpuBufferLike` /
   real `GPUBuffer` boundary is acceptable; copying scene sections into new
   host or GPU buffers is not.
3. Use per-texel or per-tile GPU parallelism. Before SDF evaluation, reject a
   surface for the current texel using its conservative ABI bounds (or an
   equivalent tile cull). Iterating surfaces in the GPU shader is allowed;
   nested CPU pixel-by-surface evaluation is forbidden.
4. Validate header/count/range assumptions before allocation or dispatch.
   Allocation arithmetic must be bounded by `GPUDevice.limits` and safe JS
   integers. Fail before device calls for malformed/mismatched encoded scenes
   or scene bindings.
5. Normal-frame execution performs only GPU uploads/compute submission. It
   must not map or read production inputs/outputs. Diagnostic readback belongs
   only in tests and must use a dedicated staging buffer through a command
   encoder.
6. Keep `WebGpuBackend.capabilities.compute` false: this is a real partial
   pipeline, not yet the complete renderer. Do not implement normals, BRDF,
   environment, lighting, or shadows here.

## Shader and buffer correctness

- Use actual WebGPU APIs: `createShaderModule`, `createComputePipeline` (or
  async equivalent), bind groups, command encoder compute passes,
  `dispatchWorkgroups`, `end`, `finish`, and `queue.submit`.
- Never add fabricated WebGPU methods to structural mocks.
- Document every new WGSL binding and derived metadata layout, including
  scalar width, alignment, byte offsets, little-endian host packing, and the
  fact that ABI mask `pixelOffset` is absolute while the bound mask-pixel
  section begins at offset zero.
- Keep WGSL binding numbers coherent with `WGSL_LAYOUT` bindings 0–4.
- Surface/material/object indices must remain stable across the output and all
  later passes.

## Verification

### Node unit tests

Use mock devices only to verify host orchestration: pipeline caching,
allocation reuse/growth, complete bind groups, command ordering, dispatch
ceil-division/bounds, no map/readback, malformed-size rejection, and disposal.
Also add focused shader/layout assertions. Do not label mock execution as GPU
numeric parity.

### Real-GPU parity test

Add a reproducible browser integration command for this repository. The
current machine has Google Chrome 151 and a working WebGPU adapter when run
headlessly with Metal/unsafe-WebGPU flags. The runner must:

1. build `ukibori-renderer` first and test its bundled public ESM output;
2. create an isolated temporary directory, serve only the copied bundle and
   test harness on `127.0.0.1`, and use an isolated browser profile;
3. execute the real compute pipeline, use test-only staging readback, and
   compare against small CPU-oracle fixtures;
4. cover rounded-rect flat/bevel edges, background, zero-height ownership,
   overlap and exact later-wins ties, clipping/offscreen bounds, DPR 1/1.5/2
   including fractional floor dimensions, and f32/u8 empty/full/edge mask
   fixtures;
5. require exact coverage/object/material IDs and use an explicit tight f32
   height tolerance justified by WGSL f32 arithmetic;
6. print an unambiguous PASS/FAIL result and fail nonzero on mismatch. If no
   adapter/browser exists on another machine, report an explicit SKIP; on this
   machine the checkpoint is not complete until the real-GPU test actually
   runs and passes.

The runner must terminate browser/server processes and remove only the exact
temporary directories it created, including on failure.

Run and report:

1. `npm run typecheck`
2. `npm test`
3. `npm run build`
4. `npm run test:webgpu -w ukibori-renderer` (must report real adapter PASS here)

## Completion report

Report shader passes, workgroup/dispatch dimensions, buffer formats/usages,
culling and tie rules, mask algorithm, files/tests added, real adapter result,
verification totals, and consciously deferred Issue #26+ work. Do not commit,
push, reset, clean, or discard existing changes.
