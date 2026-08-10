# Issue #24 implementation brief — GPU scene / buffer contract

## Context

This is the first implementation task under Issue #23, the production WebGPU
renderer epic. The existing TypeScript CPU renderer remains the semantic
reference and fallback. Do not change its rendering semantics or make WebGPU
the default in this issue.

The repository already has a deliberately incomplete WebGPU backend skeleton.
Inspect the current scene, composition, material, buffer, and backend code
before designing the ABI. Preserve all unrelated uncommitted work, including
Issue #22 changes.

## Objective

Define and implement a stable, versioned CPU-to-GPU scene and buffer ABI that
later Issue #25 and #26 compute passes can consume directly. The contract must
be concrete code plus executable validation fixtures, not documentation alone.

## Required contract

1. Represent every renderer input needed by later GPU passes without DOM or
   callback/function objects:
   - stable numeric surface/object identity for all passes in one encoded scene;
   - array paint/z order and the existing last-surface-wins tie rule;
   - conservative scene-space bounds;
   - an explicit local/scene transform, even though today's `SurfaceNode`
     supports only position and size;
   - shape/profile parameters, including rounded rectangles and mask metadata;
   - elevation, thickness, bevel width, material reference/index, and shadow
     flags;
   - a packed material table containing the inputs required by later lighting.
2. Specify matching TypeScript and WGSL layouts. Document byte offsets, record
   strides, 32-bit scalar widths, alignment/padding, little-endian encoding,
   header/version rules, and sentinel values such as `NO_OWNER`.
3. Fix coordinate semantics in the ABI:
   - logical scene x/y are CSS-pixel units, +x right, +y down, +z toward viewer;
   - pixel centers are sampled;
   - render dimensions derive from logical dimensions and DPR without mutating
     logical scene geometry;
   - origin and Y direction are explicit and unambiguous.
4. Provide a pure host-side encoder and strict validator suitable for Node unit
   tests. Reject malformed headers, unsupported versions, invalid counts,
   wrong/misaligned offsets or byte lengths, non-finite values, invalid enum or
   flag values, duplicate/out-of-range object IDs, and invalid referenced
   material/mask ranges. Validation must operate on the actual encoded bytes,
   not merely revalidate the source `Scene` object.
5. Provide a GPU upload owner that batches uploads and reuses sufficiently
   sized GPU allocations between normal frames. Normal uploads must use
   `GPUQueue.writeBuffer` or an equivalent batched transfer and must perform no
   CPU readback. Make resource ownership/disposal explicit and testable with a
   small mock device/queue.
6. Correct the current WebGPU buffer usage/readback design if needed. A storage
   buffer may not rely on an invalid `MAP_READ` usage combination: use an
   explicit copy/readback staging buffer for diagnostic `readBytes()` while
   keeping production buffers usable by compute passes.
7. Export only the minimal public types/functions needed by later renderer
   passes. Prefer a focused module under `packages/renderer/src/gpu/` with
   adjacent tests; update existing integration/export files only as necessary.

## Behavioral invariants

- `objectId` is a numeric pass-to-pass identity, with `0xffffffff` reserved for
  background/no owner. Surface string IDs remain debugging/user identities and
  are not written into pixel buffers.
- Encoding the same validated scene and DPR is deterministic.
- No normal-frame CPU readback is introduced.
- CPU renderer behavior and public component/DOM APIs remain unchanged.
- WebGPU `capabilities.compute` remains false until a real compute pipeline is
  installed by later issues.

## Non-goals

- Do not implement SDF/height composition, normal generation, lighting,
  environment shading, or shadows here.
- Do not redesign public React/DOM props or Issue #13–#22 semantics.
- Do not add WebAssembly or make WebGPU the default.

## Verification

Add targeted unit tests for byte-exact deterministic encoding, offsets/strides,
coordinate/DPR rules, stable IDs and tie order, malformed/misaligned fixture
rejection, allocation reuse/growth, batched writes, no readback on upload, and
the staging-buffer readback path. Then run:

1. `npm run typecheck`
2. `npm test`
3. `npm run build`

## Completion report

Report the ABI layout and invariants, files changed, tests added, verification
results, and any consciously deferred work for Issue #25/#26. Do not commit,
push, reset, clean, or discard existing changes.
