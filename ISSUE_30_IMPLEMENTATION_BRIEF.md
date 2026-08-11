# Issue #30 implementation brief — CPU↔GPU golden parity gate

## Context and objective

Issues #24–#29 already provide a real GPU-resident production chain and a
real-adapter browser harness:

```text
encode/upload -> height/ownership -> normal -> shadow -> lighting -> canvas
```

The current harness compares 79 compute fixtures and 17 canvas-presentation
fixtures against the TypeScript CPU reference. Issue #30 turns that useful
parity harness into a durable golden gate for the semantics fixed by #13–#22.
Build on it; do not replace it with screenshots or a second oracle.

This issue does **not** make WebGPU the public/default backend. Keep
`WebGpuBackend.capabilities.compute` and React/DOM backend selection unchanged.
Production integration/fallback selection belongs to a later issue.

## Golden fixture catalog

Create a small, reviewable, versioned golden-fixture catalog under
`packages/renderer/test-browser/` (split the current monolithic harness where
that improves clarity). Every fixture has a stable ID and explicit metadata:

- semantic categories covered;
- logical dimensions and DPR;
- relevant geometry/material/light/environment/exposure/shadow parameters;
- buffers compared and their comparison policy;
- expected static CPU golden values/digests.

Coverage must include, without inventing unsupported scene features:

- one rounded surface, bevel/no-bevel and analytic/mask/glyph shapes;
- translated/resized surfaces (the supported transform seams), overlap,
  exact ownership ties, paint order and clipping/offscreen geometry;
- empty scene, unowned lit background, opaque owned pixels and translucent
  shadow pixels;
- DPR 1, 1.5 and 2 with fractional logical coordinates/extents and floor
  render dimensions;
- height, coverage, object ID, material ID and caster height;
- normals including flat, edge/bevel and boundary behavior;
- shadow visibility including vertical/no-shadow, opposing directions,
  occluder/receiver separation and max-distance behavior;
- silicone, matte and metal lighting; directional-light changes;
- #22 environment OFF/ON and exposure zero/low/default/high/extreme-finite,
  proving geometry/ownership/normal/visibility invariance while only the
  relevant lighting/color fields change;
- final premultiplied canvas composition, preferred RGBA/BGRA normalization,
  transparency, two resizes on one presenter and clipped output.

Do not claim arbitrary rotation/skew support if the scene contract does not
have it. Document the supported translation/size transform coverage instead.

## Static CPU goldens

Dynamic CPU↔GPU agreement alone cannot detect the same semantic regression on
both sides. Add checked-in deterministic CPU goldens for representative
fixtures and intermediate buffers.

1. Use canonical little-endian bytes for integer/RGBA buffers.
2. For f32 buffers, canonicalize non-finite/-0 behavior and quantize using the
   buffer's declared absolute tolerance before hashing or snapshotting, so the
   golden is portable and the tolerance is visible in code.
3. Store compact SHA-256 digests plus a small set of human-readable probes
   (coordinates and values) rather than large binary dumps.
4. Include scene/header dimensions, DPR and relevant parameters in the
   canonical payload so a dimension/parameter change cannot preserve a stale
   digest accidentally.
5. Normal test/CI runs only verify goldens. A separate explicit maintenance
   command may regenerate them, but it must never run implicitly and must
   print which fixture/buffer changed. Document the review workflow.
6. Never change the CPU renderer merely to update a failing golden. First
   classify and explain the semantic change; golden updates must be obvious
   reviewable files.

## Comparison policies

Declare one central policy table and use it in reports/tests:

- encoded/header and object/material IDs: exact;
- coverage and shadow visibility: exact unless an already-fixed contract says
  otherwise;
- height/caster height: existing absolute tolerance (`1e-4`);
- normals: existing component/length tolerances (`1e-4`);
- diffuse/specular: existing absolute tolerance (`1e-3`);
- packed lighting RGBA8: exact for stable fixtures, otherwise only the already
  documented at-most-one-channel-by-one allowance, with exact alpha;
- final normalized premultiplied canvas RGBA8: exact alpha and the documented
  color-byte policy.

Each mismatch must report fixture ID, semantic category, pass/buffer,
dimensions/DPR, relevant parameters, coordinate/index, CPU value, GPU value,
delta and policy/tolerance. Classify it as exactly one of `contract`,
`coordinate`, `precision`, `sampling`, `scheduling` or `color-space` before
suggesting an implementation change. If automatic classification is not
sound, report `unclassified` and require a human to choose one of the six;
never guess silently.

## Real-WebGPU CI

Add a focused GitHub Actions workflow under `.github/workflows/`.

1. Run on a GitHub-hosted macOS job with Chrome and the real WebGPU runner;
   do not add `--disable-gpu` or replace the parity gate with mocks.
2. Install with `npm ci`, run the golden/contract tests and run
   `npm run test:webgpu -w ukibori-renderer`.
3. Capture the full harness log as an artifact and add a concise job summary
   containing adapter/backend (when exposed), PASS/FAIL/SKIP marker, fixture
   totals and pass-specific mismatch totals.
4. PASS exits zero. A real mismatch, shader/validation error, harness throw or
   malformed/missing marker fails the job. Capability absence may be reported
   as an explicit SKIP without pretending parity passed; the workflow must
   distinguish SKIP from FAIL and keep the reason visible in summary/logs.
5. Keep local default behavior strict: the existing runner may continue to
   exit nonzero for SKIP. CI may translate only an anchored, parsed SKIP into
   a non-failing capability-dependent outcome. Never decide from substring
   search.
6. Avoid vendor-specific expected pixels or adapter names. The CPU oracle,
   catalog and comparison policies are vendor-neutral.

Add structural tests that pin the workflow, anchored marker handling,
artifact/summary behavior, catalog coverage and the fact that FAIL cannot be
converted to SKIP/PASS.

## Verification and completion report

Run and report:

1. `npm run typecheck`
2. `npm test`
3. `npm run build`
4. the static CPU golden verification command
5. `npm run test:webgpu -w ukibori-renderer`

The report must list catalog categories/fixture count, static golden
buffer/digest count, policy table, real adapter result and per-pass totals,
canvas totals, CI workflow/SKIP semantics, reproduction commands and any
unsupported transform semantics. Do not commit, push, reset, clean or discard
changes. Stop for Codex review.

## Non-goals

- No public backend-selection/default switch.
- No CPU renderer rewrite or semantic relaxation.
- No screenshot-only comparison or vendor-specific golden image.
- No dirty-pass graph, tiling, culling or incremental scheduling (#31/#32).
- No DOM measurement, React API, accessibility or CSS layout changes.
- No new tone mapper/IBL/material behavior; #22 values are test inputs and
  semantic references only.
