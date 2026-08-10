# Issue #27 implementation brief — GPU height-field shadow visibility

## Context

Issue #24 established the frozen WebGPU scene ABI and direct GPU uploads.
Issue #25 is approved: `HeightPass` produces GPU-resident full-scene height,
coverage, object-id, and material-id fields. Issue #26 is approved:
`NormalPass` consumes the exact height allocation directly and leaves the
normal field GPU-resident. Treat those contracts, the #13 coordinate system,
and the #17/#18 CPU shadow semantics as fixed.

The semantic oracle is `packages/renderer/src/shadow.ts`, together with
`composeCasterHeightField` in `geometry.ts`. This issue moves only the
visibility stage to WebGPU. Keep `WebGpuBackend.capabilities.compute` false
until the later lighting/color/presentation issues complete the production
pipeline. Preserve public DOM/React behavior and unrelated work.

## Objective

Add a real WebGPU compute stage that produces a reusable, GPU-resident hard
shadow visibility field from the #25 height/ownership data, with no
height/ownership/visibility readback in normal execution. Remove the
per-pixel JavaScript ray-march from the future WebGPU frame path while
retaining the existing CPU implementation as the reference and fallback.

## Fixed shadow semantics

For a receiver point `P = (x, y, Hfull(x, y))`, march toward the normalized
directional light (the direction points **from the receiver toward the
light**):

```text
for t = stepSize .. maxDistance, increment stepSize:
    sampleXY = P.xy + light.xy * t
    rayZ     = f32(P.z + light.z * t)

    stop lit if sampleXY leaves the render field's pixel-center bounds
    stop lit if rayZ > maxCasterHeight + bias
    shadowed if f32(Hcaster(sampleXY)) > f32(rayZ + bias)
```

The output is binary `f32`: `1.0 = visible/lit`, `0.0 = occluded`.

1. `Hfull` is the full visible #25 height field and supplies receiver z.
2. `Hcaster` is a separately composed height field containing **only**
   surfaces whose ABI `FLAG_CASTS_SHADOW` bit is set. It uses the same shape,
   profile, f32 height, maximum-height, and later-surface tie rules as the full
   field. A non-casting top surface must never hide a lower casting surface.
   Do not approximate this by checking only the full-field owner at each ray
   sample.
3. Receiver ownership comes from the full #25 object-id field. A valid owner
   whose `FLAG_RECEIVES_SHADOW` bit is clear returns `1.0` before marching.
   `NO_OWNER` is the base plane and **does receive shadows** under the fixed
   CPU semantics; background pixels therefore cannot be skipped merely for
   having no owner. An invalid owner follows the CPU defensive behavior and
   is treated as receiving, although valid #25 output never emits one.
4. If the encoded scene has no casting surface, every invocation may return
   `1.0` without marching. Empty space along a ray is sampled normally.
5. Bilinear sampling matches `sampleHeightAt`: render texel centers are the
   samples, interpolation is row-major, and the four lookup indices replicate
   the edge. The march itself checks the inclusive pixel-center rectangle
   before sampling and stops once it leaves it. Do not wrap or sample an
   out-of-range storage element.
6. Coordinates remain `+x right`, `+y down`, `+z toward viewer`. At DPR `d`,
   render texel `(tx, ty)` is logical scene position
   `((tx + 0.5) / d, (ty + 0.5) / d)`. `stepSize`, `bias`, and `maxDistance`
   stay in logical scene units; height stays in scene-z units. A logical
   sample position maps back to render-field interpolation coordinates with
   the same center convention.
7. Preserve the strict comparison: an occluder blocks only when its f32
   sampled height is **greater than** `f32(rayZ + bias)`. Equality is lit.
   Mirror the CPU operation order closely and include threshold fixtures that
   distinguish f32 from naive JavaScript-f64 decisions.
8. Stable defaults remain #17-compatible:
   - `stepSize = 0.5` scene units;
   - `bias = f32(0.5)` scene-z units;
   - `maxDistance = sceneDiagonal / length(light.xy)` when
     `length(light.xy) > 1e-6`, otherwise `sceneDiagonal`.
9. Expose all three options explicitly. Finite positive custom step/max
   values and finite non-negative bias are accepted only when their packed
   f32 values remain finite and preserve the required sign; otherwise use
   the stable fallback. Return/document the effective packed values used by
   the shader. A value that rounds to zero must never create a non-terminating
   WGSL loop.
10. The CPU oracle currently assumes DPR 1 in its implementation despite its
    prose documenting scaled targets. Add a narrowly scoped DPR-aware path
    (an option or focused helper) with default `1`, so the real-GPU oracle can
    compare the exact render extent without changing any existing DPR-1
    result or public default.

## Caster-height extension to HeightPass

Extend the approved #25 stage only as required to supply `Hcaster`:

1. Add a fifth output-specific composition dispatch/allocation named clearly
   as caster height. Reuse the existing SDF/mask workspace and the exact same
   shape/profile code.
2. Its owner search considers only surfaces with `FLAG_CASTS_SHADOW`, then
   writes that owner's height or `0.0` for no caster. It must independently
   search casting surfaces; filtering the already selected full owner is
   incorrect.
3. Expose it beside the existing outputs as tightly packed row-major scalar
   `f32`, `4 * width * height` logical bytes, with
   `STORAGE | COPY_SRC | COPY_DST` usage. Existing full height, coverage,
   object-id, and material-id identities/formats remain unchanged.
4. Update dispatch statistics and tests deliberately (`composePasses` becomes
   five). Pipeline/layout caching, allocation reuse/growth, disposal, and
   no-readback guarantees remain intact.

## ShadowPass contract

1. Add a focused module under `packages/renderer/src/gpu/` that owns a cached
   real shader module, explicit bind-group/pipeline layouts, reusable/growing
   params and visibility allocations, a stable snapshot/dispatch statistics,
   and idempotent `dispose()`.
2. Bind the exact #25 full-height, caster-height, and object-id allocations
   directly. Bind only the uploaded surface records (or a narrower proven
   equivalent) needed to resolve `receivesShadow`; do not copy these fields
   into JavaScript arrays or replacement GPU inputs.
3. Tie the pass to the exact encoded scene/upload/height snapshot using
   provenance plus structural checks where detectable. Before any device
   call, validate matching extent/DPR, formats, channels/logical byte lengths,
   required buffer sizes/usages, surface count, safe integer/u32 arithmetic,
   workgroup limits, binding-size limits, and output allocation limits.
4. A conservative `maxCasterHeight` derived from the already CPU-resident,
   validated ABI surface records (`max(elevation + thickness)` over casting
   surfaces) is acceptable for the early-exit bound: it requires no GPU
   readback and cannot change visibility. Do not scan the GPU height field on
   the host. If a different reduction is used, it must also remain GPU-only.
5. Use one invocation per render texel, a documented 1D workgroup size (64 is
   preferred for consistency), ceil-divided dispatch, and an in-shader texel
   guard. A simple per-invocation loop is the intended #27 implementation;
   tiling/acceleration belongs to #32.
6. The output is one tightly packed row-major scalar f32 per texel. Production
   usage is `STORAGE | COPY_SRC | COPY_DST`; it remains unmapped. Snapshot the
   buffer, logical bytes, format/channels, width/height/DPR, effective options,
   workgroup size, and last dispatch dimensions/step counters useful for
   inspection.
7. Updating only shadow options may reuse all input/output allocations,
   rewrite bounded params, and redispatch. Pipeline objects remain cached.
8. Use actual WebGPU calls: `createShaderModule`, explicit
   `createBindGroupLayout`/`createPipelineLayout`, `createComputePipeline`,
   bind groups, command encoder/compute pass, `dispatchWorkgroups`, `end`,
   `finish`, and `queue.submit`.
9. Document and test the uniform byte layout (scalar type/width, alignment,
   offsets, padding, and little-endian host packing). Keep host constants and
   WGSL declarations pinned together.
10. Production code must expose no `mapAsync`, mapped range, or staging
    readback path. Test-only real-adapter readback remains confined to the
    browser parity harness.
11. Export the public internal-stage API from `packages/renderer/src/index.ts`.
    Do not connect visibility to BRDF/final color or switch the default
    backend in this issue.

## Node verification

Add focused tests for:

- caster-only height composition on the GPU orchestration path, including a
  lower casting surface fully covered by a higher non-casting surface and a
  casting/non-casting bilinear boundary;
- explicit shadow layout/pipeline creation, caching, direct input-buffer
  identity, and scene/upload/height provenance;
- exact uniform packing and effective-option sanitization, including NaN,
  infinities, negative/zero values, f32 overflow, and positive values that
  underflow to zero;
- output allocation size/usage, reuse/growth, stable snapshot, and disposal;
- command order, ceil division, bounds guard, one invocation per texel, and
  absence of readback/mapping;
- pre-device rejection of stale/mismatched extent, DPR, bytes, format, usage,
  ownership, unsafe arithmetic, allocation, and workgroup limits;
- WGSL pinning for bilinear center mapping, DPR conversion, light sign,
  bounds, strict f32 threshold, bias, max-distance/step termination,
  receives/casts flags, background semantics, and early exits;
- `WebGpuBackend.capabilities.compute` staying false.

Mocks verify host orchestration only. Do not fabricate numeric shader
execution or add non-WebGPU methods to production interfaces.

## Real-GPU CPU parity

Extend `npm run test:webgpu -w ukibori-renderer` so the public bundled ESM runs
`HeightPass -> NormalPass -> ShadowPass` on the real adapter. Use dedicated
test-only staging buffers after submission, and compare both caster height and
visibility against the actual TypeScript CPU oracle using the same render
extent, DPR, light, and effective options.

Fixtures must cover:

- the #17 two-level caster with light from both sides and removal of the
  occluder;
- a non-casting top surface above a lower caster;
- `receivesShadow = false`, a receiving surface, and `NO_OWNER` background
  receiving a cast shadow;
- no surfaces, no casters, empty/background space, and vertical/near-vertical
  light;
- target outer edges, rays leaving every side, clamped bilinear samples, and
  a casting/non-casting interpolation boundary;
- self-shadow bias, equality at the f32 threshold, explicit short
  `maxDistance`, and at least two custom step/bias/distance sets;
- overlap/tie ordering, mask/glyph caster height, clipped/offscreen geometry,
  and DPR 1, 1.5, and 2.

Visibility is binary, so require exact `0/1` equality and report total
mismatches; do not hide a semantic error behind a broad float tolerance.
Caster-height comparisons use the existing tight #25 tolerance. Any fixture
throw, compilation message, validation error, non-finite/non-binary value,
buffer mutation, or mismatch must emit the anchored FAIL marker and exit
nonzero. Retain all #25/#26 parity fixtures and cleanup guarantees.

## Benchmark fixture

In the real-adapter harness, add a reproducible benchmark at a documented
demo-sized render extent (use the actual demo/debug extent if representative,
or explicitly document a fixed 640x360 scene used as the demo-frame proxy).

- Use the same nontrivial multi-surface scene/options for CPU and GPU.
- Warm shader/pipeline/allocation caches before timing.
- Time multiple samples and report median CPU milliseconds, median GPU
  submission-to-`queue.onSubmittedWorkDone()` milliseconds, dimensions,
  options, sample count, and speedup.
- Exclude adapter/pipeline creation and test-only readback from both timings.
- Include normal per-frame parameter upload/dispatch/queue completion on the
  GPU side; do not compare an empty or no-caster fast path.
- Require and report a material improvement (target at least 2x; if the
  environment cannot sustain this without a flaky assertion, stop and report
  the measured blocker rather than weakening the fixture or timing unlike
  work).

## Verification commands

Run and report all of:

1. `npm run typecheck`
2. `npm test`
3. `npm run build`
4. `npm run test:webgpu -w ukibori-renderer` (real adapter PASS, exact shadow
   parity, and benchmark improvement are required)

## Non-goals

- No BRDF/direct/environment lighting pass, final color target, canvas
  presentation, or default-backend switch.
- No visual shadow-model/default change, soft shadow, denoiser, general ray
  tracing, spatial acceleration, tiles, or dirty-region recomputation.
- No object-by-object translated shadow image, CSS shadow, nearest-owner
  caster shortcut, or CPU height/visibility readback.
- No changes to public React/DOM component behavior.

## Completion report

Report the input/output and uniform layouts; caster-only composition rule;
coordinate/DPR/bilinear/edge behavior; receiver/background rules; option
sanitization/defaults; direct buffer identities/provenance; workgroup and
dispatch dimensions; allocation reuse; real-adapter fixture count, mismatch
count, height tolerance/max error; benchmark dimensions/samples/medians and
speedup; test totals; and consciously deferred #28+/#32 work. Do not commit,
push, reset, clean, or discard changes. Stop for Codex review.
