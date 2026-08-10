# Issue #26 implementation brief — GPU normal field

## Context

Issue #24 established the frozen WebGPU scene ABI and direct GPU uploads.
Issue #25 is approved: `HeightPass` consumes those bindings and leaves
GPU-resident f32 height plus coverage/object/material outputs. Treat both
contracts as fixed. The TypeScript `computeNormals` implementation in
`packages/renderer/src/lighting.ts` is the semantic oracle and CPU fallback.

This issue adds only the normal stage. Keep `WebGpuBackend.capabilities.compute`
false until the later shadow, lighting, and presentation issues complete the
pipeline. Preserve unrelated uncommitted work and do not redesign public
Ukibori/DOM APIs.

## Objective

Add a real WebGPU compute pass that reads the approved #25 height allocation
directly and writes a GPU-resident normalized normal field for the same render
extent. Normal-frame execution must remain GPU-only: no height or normal
readback to JavaScript.

## Supervisor regression constraints from real Metal validation

The real adapter exposed two f32 lowering traps that must stay covered:

- forming `dx * scale` before normalization overflows for largest-finite-f32
  operands;
- precomputing an extreme reciprocal such as `1 / F32_MAX` (including an
  optimizer lowering a large division to reciprocal-and-multiply) may flush
  to zero and then create either a false +Z result or NaN.

Keep the exponent-aligned/normal-range implementation, or prove an equally
robust replacement. The real-GPU fixture must combine an exact `F32_MAX`
height difference with exact `F32_MAX` x/y scales. Do not weaken this to a
smaller diagnostic value. Temporary raw shaders and diagnostic readbacks must
not remain in the final harness.

## Fixed CPU semantic contract

Mirror `computeNormals` exactly for representable f32 inputs/options:

```text
x0 = max(x - 1, 0)              x1 = min(x + 1, width - 1)
y0 = max(y - 1, 0)              y1 = min(y + 1, height - 1)
dx = H(x1, y) - H(x0, y)
dy = H(x, y1) - H(x, y0)
N  = normalize((-dx * scaleX, -dy * scaleY, normalScale))
```

1. Use the symmetric central difference in the interior. At target edges,
   replicate/clamp the missing neighbor to the edge texel. Do not wrap,
   sample outside the buffer, or switch to a different smoothing kernel.
2. Coordinates remain +x right, +y down, +z toward the viewer. A height that
   rises toward +x therefore produces a negative normal x component; the same
   sign rule applies to +y.
3. Default options remain CPU-compatible: `scaleX = 0.5`, `scaleY = 0.5`,
   `normalScale = 1`. Finite custom x/y scales are allowed, including zero or
   negative values; `normalScale` must be finite and strictly positive or fall
   back to 1. Values packed to the GPU must remain finite f32 values; document
   and test the fallback/rejection policy for finite JS values outside f32.
4. Scaling affects only the derivative-to-normal conversion. It must never
   rewrite, reinterpret, or redispatch the underlying height field. A caller
   that wants scene-unit slopes at DPR `dpr` can explicitly use
   `scaleX = scaleY = 0.5 * dpr`; do not silently bake DPR into height values.
5. `computeNormals` does not gate derivatives by coverage/object ownership.
   The #25 background is height 0: a flat background is +Z, while a background
   texel adjacent to a height discontinuity may tilt because its clamped
   central difference sees that discontinuity. Preserve this behavior for
   missing-owner/background and clipped regions; do not flatten them with an
   ownership shortcut.
6. Valid #25 height output is finite. Normalize with the same overflow-safe
   max-component-first method as the CPU oracle so each output vector is
   finite and unit length. Flat input must be exactly/approximately `(0,0,1)`
   within f32 arithmetic.

## Output and pass contract

1. Add a focused module under `packages/renderer/src/gpu/` that owns a cached
   real shader module, explicit bind-group/pipeline layout, reusable/growing
   params and output allocations, dispatch statistics/snapshot, and idempotent
   `dispose()`.
2. Consume the exact `HeightPass.getSnapshot().outputs.height.buffer` (or a
   narrowly typed equivalent binding) directly as read-only storage. Do not
   copy it to another input allocation and do not require the five scene
   buffers, coverage, objectId, or materialId for the normal algorithm.
3. Use one GPU invocation per render texel, a documented 1D workgroup size,
   ceil-divided dispatch, and an in-shader texel-count guard. Validate width,
   height, logical byte length, format, buffer size/usage assumptions, safe
   integer/u32 arithmetic, workgroup limits, and allocation limits before any
   normal-pass device call.
4. The output is one tightly packed row-major f32 xyz triple per texel
   (`12 * width * height` logical bytes), not a hidden vec3/16-byte stride.
   Document `+x right, +y down, +z viewer`, finite/unit-normal guarantees, and
   the layout expected by later lighting. Use an `array<f32>` or another WGSL
   declaration whose actual storage stride matches the documented 12 bytes.
5. The production normal allocation must be
   `STORAGE | COPY_SRC | COPY_DST`, remain unmapped, and be exposed through a
   stable read-only snapshot containing the buffer, logical byte length,
   format/channels, width/height, effective options, workgroup size, and last
   dispatch dimensions.
6. Updating normal options may reuse the same height and output allocations;
   it must only update bounded parameter data and rerun the normal compute
   pass. Pipeline objects must be cached across dispatches.

## Host and shader safety

- Use actual WebGPU calls: `createShaderModule`, explicit
  `createBindGroupLayout`/`createPipelineLayout`, `createComputePipeline`,
  bind groups, command encoder compute pass, `dispatchWorkgroups`, `end`,
  `finish`, and `queue.submit`.
- Document the params uniform layout with scalar widths, alignment, byte
  offsets, and little-endian host packing. Keep the shader and host constants
  pinned by tests.
- Reject mismatched/stale structural height snapshots where detectable; at
  minimum, format, extent, logical bytes, required buffer size, and required
  storage usage must agree before allocation or dispatch.
- Do not add fabricated WebGPU methods to mocks. Mocks verify orchestration,
  not numeric GPU parity.
- Normal execution must expose no map/readback path. Test-only readback uses a
  dedicated staging buffer and command encoder, as in #25.

## Verification

### Node tests

Add focused tests for:

- explicit layout/pipeline creation and caching;
- direct identity of the #25 height input binding;
- exact uniform packing/effective option sanitization;
- output allocation size/usage, reuse/growth, snapshot, and disposal;
- command order, ceil-division, bounds, and no readback;
- pre-device rejection of mismatched extent/bytes/format/usage, arithmetic,
  device allocation, and workgroup limits;
- WGSL binding/stride/edge-clamp/sign/overflow-safe-normalization contracts;
- `WebGpuBackend.capabilities.compute` staying false.

### Real-GPU CPU parity

Extend the reproducible `npm run test:webgpu -w ukibori-renderer` harness so it
compiles and executes the public bundled normal pass on the real adapter after
`HeightPass`. Use test-only staging readback and compare against the actual
TypeScript `computeNormals` oracle fed with the CPU reference height at the
same render extent and the same effective options.

Fixtures must cover:

- flat +Z interior/background;
- x ramp/sign and diagonal slope (a small synthetic GPU-resident height input
  is acceptable in addition to integrated #25 scenes);
- rounded/bevel plateau and both edge directions;
- target outer borders with replicate-clamp behavior;
- clipped/offscreen geometry and background immediately adjacent to a surface;
- DPR 1, 1.5, and 2 with explicit scene-unit sampling scales;
- at least two custom option sets, proving the normal output changes while the
  source height bytes remain exactly unchanged in the test-only readback;
- mask-height edges from the #25 GPU SDF path.

Compare all xyz components, require finite unit normals, report the maximum
component and length error, and state a tight explicit tolerance justified by
f32 height/derivative/normalization arithmetic. A tolerance up to `5e-4` is
acceptable only with the measured maximum reported; use a tighter bound when
the fixtures support it. Any fixture throw, shader compilation message,
validation error, non-finite component, non-unit vector, or mismatch must
produce the anchored FAIL marker and nonzero runner exit. Retain the #25
height/coverage/object/material comparisons and cleanup guarantees.

Run and report:

1. `npm run typecheck`
2. `npm test`
3. `npm run build`
4. `npm run test:webgpu -w ukibori-renderer` (real adapter PASS required here)

## Non-goals

- No BRDF, environment lighting, directional-light shading, shadow marching,
  color target, presentation, or default-backend switch.
- No changes to CPU `computeNormals`, height/SDF composition semantics, the
  frozen scene ABI, or public DOM/React behavior to make parity easier.
- No silent smoothing, owner-aware flattening, altered Y sign, or readback in
  production.

## Completion report

Report the derivative convention, boundary/background behavior, params and
output layout, workgroup/dispatch dimensions, option sanitization, direct
height binding, allocation reuse, real-adapter fixture/tolerance/max-error
results, verification totals, and consciously deferred Issue #27+ work. Do
not commit, push, reset, clean, or discard existing changes.
