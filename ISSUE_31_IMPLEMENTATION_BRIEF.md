# Issue #31 implementation brief — retained GPU resources and dirty-pass scheduling

## Objective

Implement Issue #31 on top of the merged #22–#30 GPU pipeline. `GpuScenePipeline`
currently retains pass objects but recomputes and re-uploads every stage on every
`render()` call. Replace that all-or-nothing orchestration with a small explicit
invalidation dependency graph while preserving the exact #30 CPU↔GPU parity.

## Required behavior

1. Retain pipelines, bind groups, buffers, textures, and samplers across unchanged
   frames. Reuse must be observable in tests and profiling rather than inferred.
2. Model dirty state explicitly for viewport, scene upload/geometry, height and
   ownership, normals, shadows, lighting, composite/presentation, and debug target
   configuration. Avoid an unstructured collection of unrelated booleans.
3. Each invalidation reason must propagate only to its downstream dependencies:
   - viewport/encoded scene or geometry -> upload, height, normal, shadow,
     lighting, presentation;
   - normal options -> normal, lighting, presentation;
   - shadow options -> shadow, lighting, presentation;
   - lighting/environment/exposure options -> lighting, presentation;
   - composite or presentation/debug options -> presentation only;
   - a byte-identical repeated frame -> no upload or compute dispatch, while the
     final canvas may be re-presented from retained outputs when requested.
4. Preserve safe resource ownership across resize, device loss, context recovery,
   and idempotent disposal. Never retain resources beyond the owning pipeline.
5. Extend structured profiling with cumulative and per-frame allocation count,
   uploaded bytes, dispatch count, executed/skipped passes, invalidation reasons,
   and measured pass durations when reliable timing is available. Do not fake GPU
   timestamps; wall-clock encoding/submission timings must be labeled as such.
6. Tests must cover initial full render, repeated unchanged render, geometry-only,
   normal-only, shadow-only, lighting-only, presentation-only, resize/DPR change,
   context reconfiguration/recovery seam, device loss, and disposal. Assert final
   output/provenance remains equivalent to a forced full recompute.
7. Extend the real-adapter browser harness with retained-frame parity and scheduler
   counters. Keep the existing 79 compute + 17 presentation golden gate intact.
8. Add or extend a demo/debug view so a human can trigger unchanged, light,
   material/geometry, shadow, resize, and forced-full updates and see the dirty
   reasons, executed/skipped passes, allocations, upload bytes, dispatches, and
   timings in the browser. This will be part of the final #31–#33 handoff.

## Constraints

- Do not implement tile binning, regional dispatch, partial recompute, or culling;
  those belong to #32.
- Do not change #13–#22 rendering semantics, comparison tolerances, public material
  semantics, DOM measurement, or React accessibility behavior.
- Keep the TypeScript CPU renderer and #30 goldens as the semantic oracle.
- Keep public/default backend selection unchanged in this issue.
- No per-frame GPU readback outside explicit debug/test mode.
- Prefer stable canonical fingerprints of effective encoded/options data. Object
  identity alone is insufficient because callers commonly recreate equivalent
  scene objects.
- Do not commit, push, merge, reset, clean, or discard changes. Stop after
  implementation and verification, leaving a concise completion report.

## Verification

Run at minimum:

1. `npm run typecheck`
2. `npm test`
3. `npm run build`
4. `npm run test:golden -w ukibori-renderer`
5. `npm run test:webgpu -w ukibori-renderer`

Report changed files, dependency graph/invalidation rules, profiling fields,
resource-lifetime behavior, browser demo URL/path, verification results, and any
remaining limitation before stopping.
