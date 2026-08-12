# Issue #32 implementation brief — tile binning, culling, and partial recompute

Implement GitHub Issue #32 on top of the completed #31 retained-pass scheduler.
Work directly in this repository. Do not use Luna or the dev-loop wrapper, do
not commit, and do not change the public backend default.

## Required behavior

1. Add a deterministic conservative tile grid for the encoded render extent.
   A surface must be assigned to every tile its raster footprint can affect.
   Expand bounds for bevel/profile support and for cast shadows so culling can
   never omit a contributing surface. Empty or uncertain bounds must select a
   safe full-frame/full-surface fallback.
2. Compute dirty regions by comparing the previous and next effective scene.
   Include added, removed, and changed surfaces; viewport/DPR changes; and the
   downstream footprint of normal and shadow kernels. Expand dirty bounds by
   the required halo. Light direction, global environment/exposure, material
   table changes, unknown mutations, and incompatible retained state must fall
   back to the conservative full recompute where locality cannot be proven.
3. Retain outputs outside dirty tiles. Dispatch only affected tiles/regions
   when the estimated partial cost is materially below the full-frame cost.
   When dispatch fragmentation, dirty coverage, or binning overhead is worse,
   choose the full path automatically. Expose the decision and reason.
4. Preserve exact #30/#31 provenance rules and final output parity. Partial
   and forced-full recompute of the same frame must produce equivalent height,
   normal, shadow, lighting, and presented RGBA results. Do not weaken any
   bounds checks, lifecycle checks, or device-loss behavior.
5. Extend structured profiling with tile size/count, dirty tile/texel counts,
   candidate versus culled surface counts, partial/full decision, dispatch
   count, upload bytes, and host wall-clock duration. Never label host timing
   as GPU time.

## Design constraints

- Prefer a standalone, testable tile/region planner module. Keep policy and
  geometry math independent from WebGPU calls.
- Tile size must be explicit, bounded, and configurable for benchmarks while
  retaining a documented default.
- GPU shaders/passes may use dispatch offsets or clipped regions, but all
  buffer accesses must remain bounds-safe at right/bottom edge tiles.
- If existing full-frame pass APIs cannot safely update a subregion, extend
  them narrowly rather than duplicating the renderer.
- Hash collisions must not be allowed to silently preserve wrong output.
  Use exact/canonical comparisons for correctness-critical dirty decisions,
  with hashes only as accelerators if useful.
- No per-pixel host↔GPU calls and no readback in production rendering.
- #33 WASM work is out of scope.

## Required tests

- Unit tests for tile indexing, edge clipping, negative/out-of-view bounds,
  bevel/profile halo, shadow expansion, and deterministic bin membership.
- Dirty-region tests for unchanged, move, resize, add, remove, material-only,
  local option, global light/environment, DPR/viewport, and unknown changes.
- Scheduler tests proving unchanged tiles are retained, a small local edit
  chooses partial work, broad/fragmented edits choose full work, and failure
  recovery invalidates retained regional state.
- Property/table tests comparing partial versus forced-full outputs across
  tile sizes, fractional DPR, edge-touching surfaces, overlaps, and shadows.
- Extend the real-adapter browser harness with partial/full final canvas parity
  and counters that prove fewer texels/workgroups for a small edit.
- Add a browser debug view or extend scheduler-debug with tile overlay, dirty
  region, bin/cull counts, partial/full reason, and a forced-full comparison.

## Benchmarks and acceptance

Benchmark at least several tile sizes and dirty-area ratios on the documented
640x360 proxy scene. Report binning overhead separately from submitted GPU
completion time, plus candidates/culled surfaces, dirty coverage, dispatches,
and frame time. The optimized path must never be selected merely because a
microbenchmark is noisy; use a deterministic cost threshold and document it.

Run and report:

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:golden -w ukibori-renderer`
- `npm run test:webgpu -w ukibori-renderer`

Finish with a concise file/change report, planner/fallback rules, profiling
fields, benchmark results, verification results, and remaining limitations.
