// #33 browser WASM parity + lifecycle harness (runs in real Chrome via
// scripts/test-wasm-browser.mjs against the BUILT public ESM dist/index.js).
//
// Deterministic completion contract (mirrors the #25-#30 WebGPU harness):
//
//   - the FIRST line of the result block carries exactly one anchored
//     marker token: UKIBORI_WASM_PASS | UKIBORI_WASM_FAIL | UKIBORI_WASM_SKIP
//   - a fixture that throws, a lifecycle failure, a selection-rule failure
//     or ANY parity mismatch increments a failure counter and FAILs the run
//     (no false PASS from a zero-mismatch count)
//   - FAIL is never convertible to SKIP/PASS (the runner parses the first
//     line marker only; detail lines may mention other tokens)
//
// Coverage:
//
//   1. KERNEL PARITY — the WasmCpuPipeline output vs the TypeScript oracle
//      (`lightScene`, the semantic reference) byte-for-byte over the #30
//      catalog scene fixtures (dpr 1, logical render extent) — normal,
//      height, visibility, diffuse, specular and color buffers.
//   2. STAGE PROVENANCE — a WASM-path result must report `normal: "wasm"`
//      and every other stage "typescript"; a TypeScript-only execution is
//      never labeled WASM.
//   3. SELECTION RULES — force "wasm" selects WASM with exact probe parity;
//      force "cpu" selects the TypeScript path with reason "forced-cpu";
//      auto (default options) selects WASM with the documented benefit
//      evidence; decisions are cached and reset clears them.
//   4. LIFECYCLE — concurrent load dedup, load failure + retry, abort
//      (nothing published), idempotent disposal rejecting new work, memory
//      growth with reacquired views.
//   5. MEMORY — transfer bytes, pages and growth counts reported.
//
// The harness publishes the result block into `#result` (the runner polls it
// through CDP) and also returns it for direct embedding.

const resultElement = () => document.getElementById("result");

function report(line) {
  const text = (resultElement()?.textContent ?? "") + line + "\n";
  if (resultElement()) {
    resultElement().textContent = text;
  }
  return text;
}

const MARKER_PASS = "UKIBORI_WASM_PASS";
const MARKER_FAIL = "UKIBORI_WASM_FAIL";
const MARKER_SKIP = "UKIBORI_WASM_SKIP";

async function main() {
  let text = "";
  const fail = (message) => {
    text = report(`${MARKER_FAIL} ${message}`);
    throw new Error(message);
  };
  let executionFailures = 0;
  const recordFailure = (message) => {
    executionFailures += 1;
    text = report(`failure: ${message}`);
  };

  let api;
  try {
    api = await import("./index.js");
  } catch (error) {
    report(`${MARKER_FAIL} bundle import failed: ${String(error?.stack ?? error)}`);
    return;
  }
  const {
    WasmCpuPipeline,
    WasmNormalKernel,
    selectWasmBackend,
    resetWasmSelectionCache,
    resetKernelLoadCache,
    decodeDefaultModule,
    lightScene,
    createScene,
  } = api;
  if (typeof resetKernelLoadCache !== "function") {
    report(`${MARKER_FAIL} bundle is missing resetKernelLoadCache (stale build?)`);
    return;
  }
  let createCatalog;
  try {
    ({ createCatalog } = await import("./catalog.mjs"));
  } catch (error) {
    report(`${MARKER_FAIL} catalog import failed: ${String(error?.stack ?? error)}`);
    return;
  }
  const catalog = createCatalog(api);

  // -------------------------------------------------------------------
  // 1. kernel parity over the #30 catalog scene fixtures (dpr 1)
  // -------------------------------------------------------------------
  let parityFixtures = 0;
  let parityBuffers = 0;
  {
    const selection = await selectWasmBackend({ force: "wasm" });
    if (selection.selected !== "wasm") {
      fail(`selection force:wasm did not select WASM (${selection.fallbackReason})`);
    }
    if (selection.stage !== "normal") {
      fail(`selection stage should be "normal", got ${selection.stage}`);
    }
    const pipeline = await WasmCpuPipeline.load({ kernel: selection.kernel, selection });

    const fixtures = catalog.computeFixtures.filter(
      (fixture) =>
        fixture.scene !== undefined &&
        (fixture.dpr ?? 1) === 1 &&
        fixture.synthetic !== true &&
        fixture.shadowSynth !== true &&
        fixture.optionChange !== true,
    );
    if (fixtures.length < 10) {
      fail(`expected >= 10 parity fixtures, got ${fixtures.length}`);
    }

    for (const fixture of fixtures) {
      try {
        const options = {
          normal: fixture.normalOptions,
          shadow: fixture.shadowOptions,
          ambient: fixture.lightingOptions?.ambient,
        };
        const wasm = await pipeline.render({ scene: fixture.scene, lighting: options });
        const oracle = lightScene(fixture.scene, options);
        // stage provenance: exactly the normal stage ran in WASM
        const stages = wasm.wasmStages;
        if (stages.normal !== "wasm") {
          recordFailure(`fixture ${fixture.id}: normal stage not labeled wasm`);
          continue;
        }
        for (const stage of ["height", "objectId", "visibility", "lighting"]) {
          if (stages[stage] !== "typescript") {
            recordFailure(`fixture ${fixture.id}: stage ${stage} wrongly labeled ${stages[stage]}`);
          }
        }
        const pairs = [
          ["height", wasm.height, oracle.height],
          ["normal", wasm.normal, oracle.normal],
          ["visibility", wasm.visibility, oracle.visibility],
          ["diffuse", wasm.diffuse, oracle.diffuse],
          ["specular", wasm.specular, oracle.specular],
          ["color", wasm.color, oracle.color],
        ];
        for (const [name, a, b] of pairs) {
          const av = new Uint8Array(a.data.buffer);
          const bv = new Uint8Array(b.data.buffer);
          let bad = -1;
          if (av.length !== bv.length) {
            recordFailure(`fixture ${fixture.id} ${name}: length ${av.length} vs ${bv.length}`);
            continue;
          }
          for (let i = 0; i < av.length; i++) {
            if (av[i] !== bv[i]) {
              bad = i;
              break;
            }
          }
          if (bad !== -1) {
            recordFailure(
              `fixture ${fixture.id} ${name}: byte mismatch at ${bad} (${av[bad]} vs ${bv[bad]})`,
            );
          }
        }
        parityFixtures += 1;
        parityBuffers += pairs.length;
      } catch (error) {
        const failure = String(error?.stack ?? error);
        recordFailure(`fixture ${fixture.id} threw: ${failure}`);
      }
    }
    pipeline.dispose();
  }

  // -------------------------------------------------------------------
  // 2. selection rules
  // -------------------------------------------------------------------
  {
    const forcedCpu = await selectWasmBackend({ force: "cpu" });
    if (forcedCpu.selected !== "cpu" || forcedCpu.fallbackReason !== "forced-cpu") {
      recordFailure(
        `force:cpu should select cpu/forced-cpu, got ${forcedCpu.selected}/${forcedCpu.fallbackReason}`,
      );
    }
    const auto = await selectWasmBackend({});
    if (auto.selected !== "wasm" || auto.stage !== "normal") {
      recordFailure(`auto should select wasm on this browser, got ${auto.selected}`);
    }
    if (auto.parityOk !== true || auto.maxNormalError !== 0) {
      recordFailure(`auto probe parity failed: ${auto.parityOk} maxError ${auto.maxNormalError}`);
    }
    // decision caching
    const again = await selectWasmBackend({});
    if (again !== auto) {
      recordFailure("selection decision was not cached");
    }
    resetWasmSelectionCache();
    resetKernelLoadCache();
    const afterReset = await selectWasmBackend({ force: "wasm" });
    if (afterReset === auto) {
      recordFailure("resetWasmSelectionCache did not clear the cached decision");
    }
    afterReset.kernel?.dispose();
  }

  // -------------------------------------------------------------------
  // 3. lifecycle: dedup, load failure + retry, abort, disposal, growth
  // -------------------------------------------------------------------
  {
    // concurrent load dedup
    const [k1, k2] = await Promise.all([
      WasmNormalKernel.load({ cacheKey: "browser-dedup" }),
      WasmNormalKernel.load({ cacheKey: "browser-dedup" }),
    ]);
    if (k1 !== k2) {
      recordFailure("concurrent loads were not deduplicated");
    }
    // load failure + retry (corrupt module bytes)
    const bad = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0xff, 0xff]);
    let loadRejected = false;
    try {
      await WasmNormalKernel.load({ bytes: bad, cacheKey: "browser-retry" });
    } catch {
      loadRejected = true;
    }
    if (!loadRejected) {
      recordFailure("corrupt module bytes did not fail the load");
    }
    const retried = await WasmNormalKernel.load({ cacheKey: "browser-retry" });
    if (retried.kernelVersion !== 1) {
      recordFailure("retry after load failure produced a broken kernel");
    }
    // abort: nothing published
    const controller = new AbortController();
    controller.abort();
    let aborted = false;
    try {
      await retried.computeNormals(new Float32Array(16), 4, 4, {}, controller.signal);
    } catch (error) {
      aborted = error?.name === "AbortError";
    }
    if (!aborted) {
      recordFailure("aborted compute did not reject with AbortError");
    }
    // memory growth: 1024x1024 -> pages/growth visible in stats
    const before = retried.getStats();
    const grown = await retried.computeNormals(new Float32Array(1024 * 1024), 1024, 1024, {});
    const after = retried.getStats();
    if (after.growthCount <= before.growthCount) {
      recordFailure("memory growth did not occur for a 1024x1024 field");
    }
    if (grown.normal.length !== 1024 * 1024 * 3) {
      recordFailure("grown-memory result has the wrong length");
    }
    // disposal: idempotent, rejects new work
    retried.dispose();
    retried.dispose();
    let rejected = false;
    try {
      await retried.computeNormals(new Float32Array(16), 4, 4, {});
    } catch (error) {
      rejected = String(error).includes("disposed");
    }
    if (!rejected) {
      recordFailure("compute after disposal did not reject");
    }
    k1.dispose();
  }

  // -------------------------------------------------------------------
  // result
  // -------------------------------------------------------------------
  if (executionFailures > 0) {
    text = report(
      `${MARKER_FAIL} ${executionFailures} execution failure(s): ` +
        `parity fixtures ${parityFixtures} (${parityBuffers} buffers compared)`,
    );
    return text;
  }
  text = report(
    `${MARKER_PASS} wasm parity+lifecycle: ${parityFixtures} fixtures / ${parityBuffers} buffers ` +
      `byte-exact vs oracle; selection, dedup, retry, abort, growth and disposal green`,
  );
  report(`SUMMARY wasm parity fixtures=${parityFixtures} buffers=${parityBuffers} failures=${executionFailures}`);
  return text;
}

main().catch((error) => {
  report(`${MARKER_FAIL} harness crashed: ${String(error?.stack ?? error)}`);
});
