# Issue #33 implementation brief — WASM CPU fallback / preprocessing

Implement this issue with `opencode-go/deepseek-v4-flash`. Codex owns review,
verification, commits, and integration.

## Scope

- Add an optional WASM-assisted CPU rendering path that consumes the existing
  canonical `Scene` contract. Do not create a second scene schema.
- Keep the TypeScript CPU implementation as the semantic oracle. Port one
  measured, batch-friendly CPU bottleneck first (prefer normal generation or
  another pure dense-field pass), then compose the complete fallback output
  through the existing reference stages.
- Expose an explicit backend/pipeline API and capability report. A result
  produced through the WASM path must state which stage actually ran in WASM;
  never label a TypeScript-only execution as WASM.
- Extend backend selection with `wasm` and `auto` behavior while preserving the
  rule that WebGPU detection/initialization starts first and is never delayed by
  WASM compilation or benchmarking. If WebGPU succeeds, optional WASM loading
  must not be on its critical path.
- Select WASM only when WebAssembly is supported and a bounded startup probe
  demonstrates a documented benefit for the representative workload. Cache
  the decision; provide deterministic overrides for tests and callers.

## Runtime and safety contract

- Batch all input/output through typed-array views over `WebAssembly.Memory`;
  no per-pixel JS/WASM calls.
- Validate dimensions, byte counts, offsets, alignment, overflow, and memory
  bounds before invoking exports.
- Handle memory growth by reacquiring all views after `memory.grow`; never keep
  detached/stale views.
- Deduplicate concurrent module loads. A failed load must be retryable and must
  fall back to TypeScript without poisoning WebGPU or future attempts.
- Support AbortSignal cancellation at JS stage boundaries. Never publish a
  cancelled or partially computed result.
- Make disposal idempotent. After disposal reject new work, release worker/listener
  references, and ignore late async completions.
- If a worker is used, use request IDs, transferable batched buffers, explicit
  cancellation and termination. Worker use is optional; document why if the
  initial implementation remains same-thread.

## Correctness and observability

- Test the WASM kernel against the TypeScript oracle over table/property cases:
  edges, flat fields, extreme finite f32 values, DPR 1/1.5/2, small/large extents,
  memory growth, repeated renders, cancellation, concurrent load, load failure,
  retry, and disposal.
- Full fallback output must preserve the established #13–#21 semantics and #22
  color cases. Reuse existing CPU golden fixtures; add a browser WASM parity gate.
- Report module-load time, probe time, JS→WASM bytes, WASM→JS bytes, transfer
  time, kernel time, total time, memory pages/growth count, selected path and
  fallback reason. Durations are host wall-clock unless genuinely measured
  otherwise.
- Benchmarks must compare TypeScript CPU, WASM-assisted CPU, and real WebGPU for
  representative small and large scenes. Keep timing results non-gating; parity,
  lifecycle and selection rules are gating.

## Browser demo

- Add a browser-visible WASM diagnostics page (or extend scheduler diagnostics)
  showing support, load/probe/selection state, actual WASM stage, transfer sizes,
  memory pages/growth, cancellation/disposal status, parity result, and benchmark
  rows for TypeScript/WASM/WebGPU.
- The final workspace must run with the normal demo dev command and expose a
  stable URL Codex can open for human verification.

## Non-goals

- Do not port the entire renderer before profiling supports it.
- Do not add a required compiler/runtime dependency to the WebGPU production
  path.
- Do not weaken existing CPU/WebGPU parity tolerances or silently fall back while
  claiming WASM execution.

## Required verification

Run workspace typecheck, all tests, build, CPU golden verification, browser WASM
parity/lifecycle tests, and the real WebGPU gate. Do not commit or push.

## Implementation status (filled in during implementation)

- WASM kernel: deterministic builder `packages/renderer/scripts/build-wasm.mjs`
  (no external toolchain; every opcode in its table verified empirically
  against the engine) -> checked-in base64 `src/wasm/normal-kernel.base64.ts`,
  pinned byte-for-byte by `src/wasm/determinism.test.ts`. Human-audit WAT:
  `src/wasm/normal-kernel.wat`.
- Ported stage: normal generation (`computeNormals`, the first measured,
  batch-friendly dense-field bottleneck; ~2x faster than the oracle at the
  probe workload). All other fallback stages stay on the existing TypeScript
  reference stages (`composeSdfHeightField` / `computeVisibility` /
  `shadePreparedFields`) — `WasmCpuPipeline` composes the complete output and
  reports per-stage provenance (`wasmStages`), labeling a result WASM only
  when the normal stage actually ran in WASM.
- Selection: `selectWasmBackend` requires WebAssembly support + bounded probe
  with exact oracle parity + documented benefit (wasm < ts*0.9); decisions
  are cached (`resetWasmSelectionCache`), deterministic force overrides for
  tests/callers. `createRenderer({ backend: "auto"|"wasm" })`; `auto` starts
  WebGPU detection FIRST and never awaits WASM work; a winning WebGPU
  releases the optional WASM kernel off its critical path.
- Same-thread by design (documented in `pipeline.ts`): the kernel is one
  synchronous batch call and the remaining stages are the same-thread
  TypeScript oracle, so a worker would offload only the fastest fraction.
- Browser gate: `test-browser/wasm-parity.html/.mjs` + `scripts/
  test-wasm-browser.mjs` (real Chrome, anchored first-line marker
  UKIBORI_WASM_PASS/FAIL/SKIP); `npm run test:wasm-browser -w ukibori-renderer`.
- Demo: `/wasm-debug.html` under `npm run dev` (vite input registered) —
  selection state/reason, load/probe metrics, actual WASM stage, transfer
  sizes, memory pages/growth, cancellation/disposal state, parity result and
  TS/WASM/WebGPU benchmark rows (honest host wall-clock; WebGPU reports
  "unavailable" rather than fake timings).
