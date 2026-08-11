# Issue #29 implementation brief — direct GPU presentation/compositing

## Context

Issue #24 froze the encoded scene ABI and direct upload. Issues #25–#28 now
form a real GPU-resident chain:

```text
SceneUploader -> HeightPass -> NormalPass -> ShadowPass -> LightingPass
```

`LightingPass.color` is tightly packed row-major RGBA8 in a storage buffer.
The #25 `objectId` and #27 `visibility` fields remain GPU-resident as well.
The CPU/DOM reference compositor is
`packages/ukibori-dom/src/compositor.ts`: owned surface pixels are opaque
renderer color, lit base-plane pixels are transparent, and shadowed base-plane
pixels are a configurable translucent tint.

Issue #29 adds only the thin final GPU stage and a full-chain internal
orchestrator. Do not make React `backend="auto"` select WebGPU yet: #30 must
first establish golden parity. Do not implement #31 dirty-pass scheduling or
resource graph optimization.

## Objective

Present the exact #28 output directly to a real `GPUCanvasContext` without a
GPU-to-CPU readback or CPU bitmap upload. The production frame must encode,
upload, dispatch and present entirely on the GPU after the scene ABI bytes are
prepared on the host.

## Fixed DOM composition semantics

Mirror `compositeSurfaceImage` exactly; do not redesign it:

1. `objectId != NO_OWNER`: output the packed #28 R,G,B bytes with alpha 255.
2. `objectId == NO_OWNER` and `visibility >= 0.5`: output transparent black.
3. `objectId == NO_OWNER` and `visibility < 0.5`: output sanitized
   `shadowColor` with sanitized `shadowAlpha`.
4. Shadow color channels are rounded/clamped to integer bytes exactly like
   the CPU compositor. Alpha is finite-clamped to `[0,1]`, default `0.3`, and
   encoded with `floor(alpha * 255 + 0.5)`.
5. The canvas is configured with `alphaMode: "premultiplied"`; therefore the
   fragment output for a translucent shadow must premultiply RGB by alpha.
   Surface RGB is unchanged because its alpha is 1. Transparent pixels are
   `(0,0,0,0)`.
6. Canvas `colorSpace` is explicitly `"srgb"`. The #28 bytes are already
   sRGB encoded. Treat their normalized numeric values as the sRGB canvas
   encoding; do not apply a second gamma transform or introduce a tone map.
7. Use the browser's preferred 8-bit canvas format (`rgba8unorm` or
   `bgra8unorm`) and a matching render-pipeline target. The shader returns
   logical RGBA; attachment format swizzle is handled by WebGPU. Snapshot the
   selected format so test-only readback can normalize byte order.

## PresentationPass contract

Add focused host/WGSL modules under `packages/renderer/src/gpu/`.

1. Consume three exact GPU buffers directly:
   - #28 packed RGBA8 color;
   - #25 u32 object-id;
   - #27 f32 visibility.
   Do not copy, map, read back, or upload replacements for them.
2. Propagate the unique successful HeightPass-dispatch provenance through the
   LightingPass snapshot. The three presentation fields must share the same
   token and exact width/height/DPR. Reject foreign or mixed fields before any
   presentation-device/context call.
3. Strictly validate positive integer extent, safe/u32 texel arithmetic,
   formats, channels, logical byte lengths, STORAGE usage, actual buffer
   coverage, canvas backing-store dimensions, device limits, and every
   explicit binding range before configuring/acquiring a current texture.
4. Use one cached WGSL shader module, explicit bind-group/pipeline layouts,
   one reusable/growing uniform allocation, and a render pipeline cached per
   canvas target format. Every `GPUBufferBinding` has an explicit validated
   `size`.
5. Draw one fullscreen triangle. In the fragment stage derive integer texel
   coordinates from `@builtin(position)`; framebuffer y grows downward, so it
   matches the row-major height-field convention without a vertical flip.
   Guard the extent before indexing storage arrays.
6. Begin one render pass against
   `context.getCurrentTexture().createView()`, clear to transparent black,
   set pipeline/bind group, draw 3 vertices, end, finish and submit. No
   intermediate texture is required in the normal path.
7. Configure the context with the owning device, selected format,
   `GPUTextureUsage.RENDER_ATTACHMENT`, `alphaMode: "premultiplied"`, and
   `colorSpace: "srgb"`. Test/debug mode may additionally request `COPY_SRC`;
   default production configuration must not expose a readback helper.
8. Snapshot width/height/DPR, canvas format, effective composite options,
   work submitted, configuration generation and per-call host encode time.
   Presentation profiling remains separate from compute-pass statistics.
9. Context configuration is reused while device/format/debug usage remain
   unchanged. Backing-store resize invalidates the old current texture; the
   next present validates the new size and acquires a fresh texture. Never
   retain a current texture/view across frames.
10. Track `device.lost`. Once lost, reject presentation without touching a
    stale context or submitting more work. `dispose()` unconfigures the
    context, destroys only owned resources and is idempotent. Recovery in #29
    is explicit construction of a fresh pipeline with a fresh device; #31
    owns automatic retained-resource recovery.

## Full-chain GpuScenePipeline

Add a small internal production orchestrator which owns and calls, in order:

```text
encodeScene -> SceneUploader -> HeightPass -> NormalPass -> ShadowPass
            -> LightingPass -> PresentationPass
```

1. Its render input is the existing `Scene`, DPR, normal/shadow/lighting and
   composite options. No public scene/material redesign.
2. Resize the canvas backing store to the encoded render extent before
   presentation. CSS positioning/size remains a DOM-layer responsibility.
3. Derive every downstream binding through the existing public helpers so
   per-dispatch provenance is current on every frame.
4. Run every compute pass every requested frame. Pass-level allocations and
   pipelines may reuse their existing caches; skipping unaffected passes and
   retaining a dependency graph belong to #31.
5. Return/snapshot structured per-pass dispatch statistics and presentation
   statistics for debugging. Do not expose host copies of intermediate/final
   pixel data.
6. Dispose in reverse ownership order, never destroy foreign canvas/device
   resources twice, and leave no usable stale snapshot after disposal/loss.
7. Export the internal-stage APIs from `packages/renderer/src/index.ts`.
   Keep the existing TypeScript CPU renderer and Canvas2D DOM path unchanged
   for fallback/reference behavior in this checkpoint.
8. Keep `WebGpuBackend.capabilities.compute` false in #29. #30 is the parity
   gate before capability/default-backend selection changes.

## Node verification

Add focused structural tests for:

- explicit shader/layout/render-pipeline creation, target-format cache,
  command order, fullscreen draw and one queue submission;
- exact identity of color/objectId/visibility bindings and strict shared
  provenance, including two dispatches of the exact same EncodedScene;
- uniform byte layout, little-endian packing and CPU-compatible composite
  option sanitization (NaN, infinities, endpoints, fractional byte rounding);
- RGBA extraction byte order, `NO_OWNER`, visibility threshold, premultiplied
  shadow output, transparent clear, no y flip and no second gamma transform;
- context configuration fields, reuse, resize/current-texture acquisition,
  debug-only COPY_SRC usage and no retained per-frame texture/view;
- every pre-device/context rejection path (extent, canvas size, format,
  channels, bytes, usage, buffer coverage, limits, provenance);
- device-loss fail-closed behavior, idempotent disposal/unconfigure and owned
  allocation cleanup;
- full orchestrator pass order and current per-frame provenance;
- production modules containing no `mapAsync`, mapped-range,
  `copyBufferToBuffer`, `putImageData`, `ImageData`, Canvas2D or CPU staging
  bitmap path;
- `WebGpuBackend.capabilities.compute` still false until #30.

Mocks prove host orchestration only. Numeric presentation claims require the
real adapter/canvas harness.

## Real-GPU canvas parity

Extend `npm run test:webgpu -w ukibori-renderer` so representative fixtures
run the PUBLIC bundled ESM through the full `GpuScenePipeline` into a real
`GPUCanvasContext`.

Test-only mode may configure the current canvas texture with `COPY_SRC` and
copy it to a padded staging buffer only after presentation submission. No
such path may exist in production modules.

Compare normalized RGBA canvas bytes against the actual CPU reference
composition semantics. Reuse or expose a narrow shared CPU compositor helper
instead of writing a second JavaScript formula copy. Existing DOM compositor
results must remain byte-identical.

Fixtures must include:

- opaque silicone/matte/metal surfaces and base-plane transparency;
- shadowed and lit background, custom shadow tint/alpha, alpha 0 and 1;
- overlap/ownership, clipped/offscreen surfaces and empty scene behavior;
- DPR 1, 1.5 and 2; fractional extents; two resizes on the same presenter;
- light/environment/exposure changes without stale presentation dimensions;
- preferred RGBA or BGRA format normalization;
- a presentation-only 640x360 benchmark with 5 warmups and 10 samples,
  timed from render-pass encoding through `queue.onSubmittedWorkDone()`,
  excluding compute, scene upload and test readback. Report its median
  separately from the existing full compute-chain benchmark.

Require exact alpha and byte order. Stable fixtures require exact RGBA8;
if a real canvas implementation introduces a single-byte rounding boundary,
use only the already documented at-most-one-channel-by-one policy and report
per-channel maxima. Any shader compilation message, validation error,
fixture throw, stale size, non-premultiplied output or mismatch emits the
anchored FAIL marker.

## Verification commands

Run and report all of:

1. `npm run typecheck`
2. `npm test`
3. `npm run build`
4. `npm run test:webgpu -w ukibori-renderer`

## Non-goals

- No React/DOM public backend selection or WebGPU-by-default switch (#30
  parity gate and later integration decision).
- No dirty-pass graph, skipped dispatches, partial updates, tiles or culling
  (#31/#32).
- No postprocessing, tone mapping, blur/soft shadows or shader redesign.
- No CPU readback/re-upload, Canvas2D bridge, staging bitmap or
  `putImageData` in the production GPU path.
- No changes to DOM measurement, accessibility, pointer/focus behavior or
  CSS layout.

## Completion report

Report canvas configuration and color/alpha interpretation; bindings and
uniform layout; direct buffer identities/provenance; render-pass command
order; resize/loss/disposal behavior; full-chain orchestration; real-adapter
fixture and RGBA mismatch totals; presentation-only and full-chain benchmark
medians; test totals; and work consciously deferred to #30/#31. Do not
commit, push, reset, clean or discard changes. Stop for Codex review.

## Supervisor feedback after the timed-out first implementation attempt

Continue from the existing files; do not restart or discard useful production
code. The next attempt must address these concrete findings:

1. `npm test -w ukibori-renderer -- --run` currently has 42 failures. Nearly
   all new presentation/pipeline tests build real Height/Normal/Shadow/Lighting
   snapshots, but their command-encoder mocks throw from `beginComputePass()`.
   Reuse the proven compute-pass mock behavior from the existing pass tests (a
   pass encoder with `setPipeline`, `setBindGroup`, `dispatchWorkgroups`, and
   `end`) instead of an `"unused"` throwing stub. Do not weaken production
   assertions to make a broken mock pass.
2. Fix the incorrect sanitizer expectation `[255, 256, 0]`; the documented
   byte contract clamps the second channel to 255.
3. Do not call a fabricated `GPUCanvasContext.getPreferredFormat()` method.
   Real WebGPU obtains the browser-preferred format from
   `navigator.gpu.getPreferredCanvasFormat()`. Keep the production class
   testable by accepting an already-resolved `rgba8unorm`/`bgra8unorm` format
   at the real API boundary (constructor or present input), then validate it.
4. Canvas configuration reuse must include context identity, not only a string
   format/debug key. A different context must never skip `configure()` because
   it happens to use the same format. Either bind a `PresentationPass` to one
   context or explicitly unconfigure/reconfigure on context change.
5. `GpuScenePipeline` must resize the same backing-store object exposed by the
   presentation context. Reject mismatched canvas/context ownership early or
   remove the redundant independent canvas parameter; do not silently resize
   one object and validate another.
6. Complete the real-browser harness required by this issue: WebGPU canvas
   presentation parity for opaque surface, transparent lit background,
   translucent shadow, clipping, resize and DPR, plus separately reported
   presentation-only timing. Production remains readback-free; only the
   harness configuration may add `COPY_SRC`.
7. Run the full configured verification without piping through `head` (which
   can hide the real exit code). Do not report completion until typecheck,
   tests, build, and the real-WebGPU harness all pass.
