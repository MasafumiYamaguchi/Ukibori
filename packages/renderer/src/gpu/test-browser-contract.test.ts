import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
// The runner is a plain ESM CLI script without type declarations; importing
// parseResultMarker for unit tests is intentional.
// @ts-expect-error - scripts/test-webgpu.mjs has no type declarations
import { parseResultMarker } from "../../scripts/test-webgpu.mjs";

/**
 * Deterministic source-level contract assertions for the #25-#30 real-GPU
 * integration pieces (the `test-browser/` harness + catalog + oracle and
 * `scripts/test-webgpu.mjs` runner). These files run outside vitest (browser
 * + CLI), so the hardening contracts are pinned here as source patterns
 * instead of runtime tests:
 *
 * - a fixture that THROWS or reports a non-null scoped validation error must
 *   FAIL the run (no false PASS from a zero mismatch count)
 * - checkShaders must fail the run on ANY compilation message (error,
 *   warning or info), never let a message type pass silently
 * - the runner must await the killed Chrome's exit (bounded) BEFORE removing
 *   the profile/temp directory it created
 * - the runner must parse ONLY the first line with an anchored exact marker
 *   token; FAIL takes precedence over any PASS word in the details
 * - only a real-adapter PASS exits zero: UKIBORI_WEBGPU_SKIP (no WebGPU,
 *   no adapter, no Chrome) exits nonzero
 * - the fixture definitions live in the #30 catalog (test-browser/catalog.mjs)
 *   and the CPU oracles/comparisons live in test-browser/oracle.mjs
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const paritySource = readFileSync(resolve(packageRoot, "test-browser", "parity.mjs"), "utf8");
const catalogSource = readFileSync(resolve(packageRoot, "test-browser", "catalog.mjs"), "utf8");
const oracleSource = readFileSync(resolve(packageRoot, "test-browser", "oracle.mjs"), "utf8");
const runnerSource = readFileSync(resolve(packageRoot, "scripts", "test-webgpu.mjs"), "utf8");

describe("parity.mjs — fixture failure accounting (no false PASS)", () => {
  it("returns an error-bearing result when runFixture throws", () => {
    expect(paritySource).toContain("failure = String(error?.stack ?? error);");
    expect(paritySource).toContain("return { name: fixture.id, error: failure };");
  });

  it("treats a non-null scoped validation error as a fixture failure", () => {
    expect(paritySource).toContain(
      "return { name: fixture.id, error: `validation: ${scopedError.message}` };",
    );
  });

  it("pops the validation error scope exactly once per fixture (no double-pop)", () => {
    // count the actual call syntax so the doc comment mentioning the method
    // name does not count as an occurrence; both fixture runners (compute
    // chain and #29 presentation) push and pop exactly one scope per fixture
    const pushes = paritySource.split("device.pushErrorScope(").length - 1;
    const pops = paritySource.split("device.popErrorScope(").length - 1;
    expect(pushes).toBe(2);
    expect(pops).toBe(2);
  });

  it("counts execution failures and FAILs the final marker when any exist", () => {
    expect(paritySource).toContain("let executionFailures = 0;");
    expect(paritySource).toContain("executionFailures += 1;");
    expect(paritySource).toContain(
      "if (executionFailures > 0) {",
    );
    expect(paritySource).toContain(
      "fixture execution failures: ${executionFailures} of ${fixtureResults.length} fixtures",
    );
    // the FAIL branch must run BEFORE the mismatch PASS path; the final
    // PASS marker (last occurrence) must come after both failure branches
    const failIndex = paritySource.indexOf("if (executionFailures > 0) {");
    const mismatchIndex = paritySource.indexOf("if (totalMismatches > 0) {");
    const passIndex = paritySource.lastIndexOf("MARKER_PASS,");
    expect(failIndex).toBeGreaterThan(-1);
    expect(mismatchIndex).toBeGreaterThan(-1);
    expect(passIndex).toBeGreaterThan(-1);
    expect(failIndex).toBeLessThan(mismatchIndex);
    expect(mismatchIndex).toBeLessThan(passIndex);
  });
});

describe("catalog.mjs — #26 extreme normal fixtures", () => {
  it("pins largest-finite-f32 derivative/scale parity and subnormal sanitization", () => {
    expect(catalogSource).toContain("const F32_MAX = 3.4028234663852886e38;");
    expect(catalogSource).toContain('name: "synth-extreme-f32-diff-scale"');
    expect(catalogSource).toContain(
      "field: synthHeight(3, 1, (x) => (x === 2 ? 0 : F32_MAX))",
    );
    expect(catalogSource).toContain(
      "normalOptions: { scaleX: F32_MAX, scaleY: F32_MAX, normalScale: 1 }",
    );
    expect(catalogSource).toContain('name: "synth-normal-scale-below-min-subnormal"');
    expect(catalogSource).toContain("normalScale: 5e-324");
    expect(catalogSource).toContain('name: "synth-normal-scale-min-subnormal"');
  });

  it("contains no temporary raw shader or height-readback probe", () => {
    expect(paritySource).not.toContain("TEMPORARY DEBUG");
    expect(paritySource).not.toContain("rawProbe");
    expect(paritySource).not.toContain("synth height first8");
  });
});

describe("parity.mjs + oracle.mjs — #27 shadow fixtures and harness hardening", () => {
  it("runs the real ShadowPass through the public helper on every scene fixture", () => {
    expect(paritySource).toContain("shadowHeightBindingsFromHeightPass(snapshot)");
    expect(paritySource).toContain("shadowPass = new api.ShadowPass(device);");
    expect(paritySource).toContain(
      "shadowSnapshot.output.buffer",
    );
    // the exact 0/1 comparison is tolerance-free
    expect(oracleSource).toContain(
      "v !== 0 && v !== 1 ? `non-binary/non-finite ${v}` : v === oracle[g] ? null : `!= oracle ${oracle[g]}`",
    );
  });

  it("pins the required shadow fixture set (brief fixture list)", () => {
    for (const name of [
      "shadow-two-level-light-right",
      "shadow-two-level-light-left",
      "shadow-occluder-removed",
      "shadow-non-casting-top",
      "shadow-panel-receives",
      "shadow-receives-false",
      "shadow-bilinear-boundary",
      "shadow-equality-at-threshold",
      "shadow-strict-above-threshold",
      "shadow-tie-overlap-ordering",
      "shadow-mask-caster",
      "shadow-clipped-offscreen-caster",
      "shadow-vertical-light",
      "shadow-near-vertical-light",
      "shadow-y-light-bottom-exit",
      "shadow-y-light-top-exit",
      "shadow-short-max-distance",
      "shadow-custom-options-a",
      "shadow-custom-options-b",
      "shadow-non-binary-step-0.1",
      "shadow-f32-vs-f64-equality",
      "shadow-frac-dpr1",
      "shadow-frac-dpr1.5",
      "shadow-frac-dpr2",
      "shadow-synth-self-shadow-bias-sets",
    ]) {
      expect(catalogSource).toContain(`name: "${name}"`);
    }
  });

  it("pins the +/-y edge-exit lights and the non-dyadic 0.1 step", () => {
    // the y-lights must point along +y/-y so rays exit the bottom/top edge
    expect(catalogSource).toContain("twoLevelScene({ x: 0, y: 1, z: 1 })");
    expect(catalogSource).toContain("twoLevelScene({ x: 0, y: -1, z: 1 })");
    // the 0.1 step pins the explicit f32-multiple march series
    expect(catalogSource).toContain('stepSize: 0.1, bias: 0.25, maxDistance: 10');
  });

  it("exempts only the two intentional equality fixtures from the perturbation pre-check", () => {
    expect(catalogSource).toContain("shadowThresholdExact: true");
    expect(catalogSource.match(/shadowThresholdExact: true/g)).toHaveLength(2);
    expect(oracleSource).toContain("exactThreshold = false");
    expect(oracleSource).toContain("if (exactThreshold) {");
    // the exemption is NOT applied to ordinary fixtures
    expect(paritySource).toContain("fixture.shadowThresholdExact === true");
    // the fixture pins the f32-packed sample value f32(0.1 + 0.2)
    expect(catalogSource).toContain("thickness: 0.3");
  });

  it("reports the effective options in the benchmark output", () => {
    expect(paritySource).toContain("const effectiveOptions = shadowPass.getSnapshot().options;");
    expect(paritySource).toContain("(effective options ${JSON.stringify(benchmark.options)})");
    expect(paritySource).toContain("casterMismatches: casterCompare.mismatches");
    expect(paritySource).toContain("if (benchmarkParity.casterMismatches > 0) {");
  });

  it("runs the +/-5e-4 CPU stability pre-check before the GPU comparison", () => {
    expect(oracleSource).toContain("export const SHADOW_PERTURBATION = 5e-4;");
    expect(oracleSource).toContain("height.map((v) => v + SHADOW_PERTURBATION)");
    expect(oracleSource).toContain("casterHeight.map((v) => v - SHADOW_PERTURBATION)");
    expect(oracleSource).toContain("height.map((v) => v - SHADOW_PERTURBATION)");
    expect(oracleSource).toContain("casterHeight.map((v) => v + SHADOW_PERTURBATION)");
    expect(oracleSource).toContain("razor-edge fixture texel");
    expect(oracleSource).toContain("stableShadowOracle(");
    expect(oracleSource).toContain("the CPU decision flips within ");
    expect(oracleSource).toContain("+/-${SHADOW_PERTURBATION} field perturbation");
  });

  it("checks the caster-height module and the shadow module for compilation", () => {
    expect(paritySource).toContain('["COMPOSE_CASTER_HEIGHT_WGSL", api.COMPOSE_CASTER_HEIGHT_WGSL],');
    expect(paritySource).toContain('["SHADOW_PASS_WGSL", api.SHADOW_PASS_WGSL],');
  });

  it("requires the 640x360 benchmark and the >= 2x material improvement", () => {
    expect(paritySource).toContain("const BENCHMARK_WIDTH = 640;");
    expect(paritySource).toContain("const BENCHMARK_HEIGHT = 360;");
    expect(paritySource).toContain("const BENCHMARK_WARMUP = 5;");
    expect(paritySource).toContain("const BENCHMARK_MIN_SPEEDUP = 2;");
    expect(paritySource).toContain("benchmark blocker: speedup");
    expect(paritySource).toContain("await device.queue.onSubmittedWorkDone();");
    expect(paritySource).toContain("median GPU");
  });

  it("reports shadow visibility mismatches as a dedicated FAIL branch", () => {
    const failIndex = paritySource.indexOf("if (totalShadowMismatches > 0) {");
    const passIndex = paritySource.lastIndexOf("MARKER_PASS,");
    expect(failIndex).toBeGreaterThan(-1);
    expect(failIndex).toBeLessThan(passIndex);
    expect(paritySource).toContain("exact 0/1 equality required");
  });
});

describe("parity.mjs — checkShaders fails on ANY compilation message", () => {
  it("pushes every compilation message (error, warning, info) into the failure list", () => {
    expect(paritySource).toContain("for (const message of info.messages) {");
    // messages are NEVER filtered by type inside checkShaders: a warning or
    // info message counts exactly like an error, so a real-adapter PASS
    // means zero messages
    const shaderStart = paritySource.indexOf("async function checkShaders");
    const shaderEnd = paritySource.indexOf("return problems;", shaderStart);
    const shaderFn = paritySource.slice(shaderStart, shaderEnd);
    expect(shaderStart).toBeGreaterThan(-1);
    expect(shaderEnd).toBeGreaterThan(shaderStart);
    expect(shaderFn).not.toContain('message.type === "error"');
    expect(shaderFn).toContain(
      "${label}:${message.lineNum}:${message.linePos}: ${message.type}: ${message.message}",
    );
  });

  it("FAILs the final marker when any message exists, before the PASS path", () => {
    expect(paritySource).toContain("if (shaderProblems.length > 0) {");
    expect(paritySource).toContain(
      "shader compilation failed (${shaderProblems.length} messages)",
    );
    const shaderFail = paritySource.indexOf("if (shaderProblems.length > 0) {");
    const passIndex = paritySource.lastIndexOf("MARKER_PASS,");
    expect(shaderFail).toBeGreaterThan(-1);
    expect(passIndex).toBeGreaterThan(-1);
    expect(shaderFail).toBeLessThan(passIndex);
  });
});

describe("parity.mjs + catalog.mjs — #29 GPU canvas presentation", () => {
  it("runs the full public GpuScenePipeline into a real GPUCanvasContext", () => {
    expect(paritySource).toContain("new api.GpuScenePipeline(device, context, canvasFormat)");
    expect(paritySource).toContain('canvas.getContext("webgpu")');
    expect(paritySource).toContain("api.PRESENTATION_PASS_WGSL");
    expect(oracleSource).toContain("compositePixelBytes,");
    expect(oracleSource).toContain("compositeShadowPremultipliedBytes,");
    expect(paritySource).toContain("debugReadback: true");
  });

  it("resolves the canvas format once at the real API boundary (no fabricated method)", () => {
    expect(paritySource).toContain("navigator.gpu.getPreferredCanvasFormat()");
    // the production modules must never call navigator.gpu or a fabricated
    // context method; only the harness resolves the browser-preferred format
    expect(paritySource).toContain(
      "// resolved ONCE at the real API boundary, exactly like the #29 contract",
    );
  });

  it("pins the required #29 presentation fixture set (brief fixture list)", () => {
    for (const name of [
      "present-silicone-opaque",
      "present-matte-opaque",
      "present-metal-opaque",
      "present-lit-background",
      "present-shadow-default",
      "present-shadow-custom-tint-alpha",
      "present-shadow-alpha-0",
      "present-shadow-alpha-1",
      "present-overlap-ownership",
      "present-clipped-offscreen",
      "present-empty-scene",
      "present-frac-dpr1",
      "present-frac-dpr1.5",
      "present-frac-dpr2",
      "present-two-resizes",
      "present-light-change",
      "present-env-exposure-change",
    ]) {
      expect(catalogSource).toContain(`name: "${name}"`);
    }
    expect(catalogSource).toContain("renders: [");
  });

  it("runs the test-only padded canvas readback only after the presentation submission", () => {
    // padded staging: bytesPerRow rounded up to 256
    expect(paritySource).toContain("const bytesPerRow = Math.ceil((width * 4) / 256) * 256;");
    expect(paritySource).toContain("GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST");
    expect(paritySource).toContain("encoder.copyTextureToBuffer(");
    // the readback is a harness-only path: it must live in parity.mjs and
    // never in the production modules (pinned by presentation-pass.test.ts)
    expect(paritySource).toContain("ukibori-test-present-staging");
  });

  it("normalizes BGRA canvas bytes into RGBA for the comparison", () => {
    expect(paritySource).toContain("if (canvasFormat !== \"bgra8unorm\") {");
    expect(paritySource).toContain("out[p + 2]");
  });

  it("requires exact alpha and the documented at-most-one-channel-by-one canvas policy", () => {
    const compareStart = oracleSource.indexOf("function compareCanvas(");
    const compareEnd = oracleSource.indexOf("return { hard, alphaBad, maxDelta, samples };", compareStart);
    const compareFn = oracleSource.slice(compareStart, compareEnd);
    expect(compareStart).toBeGreaterThan(-1);
    expect(compareEnd).toBeGreaterThan(compareStart);
    expect(compareFn).toContain("Math.abs(gpu[i + 3] - reference[i + 3]) > 0");
    expect(compareFn).toContain("if (maxd > 1 || diffs > 1 || alpha) {");
  });

  it("reports the presentation benchmark separately from the compute-chain benchmark", () => {
    expect(paritySource).toContain("const PRESENT_BENCHMARK_WARMUP = 5;");
    expect(paritySource).toContain("const PRESENT_BENCHMARK_SAMPLES = 10;");
    expect(paritySource).toContain("present-only median");
    expect(paritySource).toContain("(full compute-chain median reported separately)");
    expect(paritySource).toContain("pipeline.present();");
    expect(paritySource).toContain("await device.queue.onSubmittedWorkDone();");
  });

  it("FAILs the run on presentation mismatches and on benchmark scene mismatches", () => {
    expect(paritySource).toContain(
      "presentation canvas mismatches: ${totalPresentHard} hard texels",
    );
    expect(paritySource).toContain("presentation fixture execution failures");
    const failIndex = paritySource.indexOf("if (totalPresentHard > 0) {");
    const passIndex = paritySource.lastIndexOf("MARKER_PASS,");
    expect(failIndex).toBeGreaterThan(-1);
    expect(failIndex).toBeLessThan(passIndex);
    expect(paritySource).toContain(
      "presentation benchmark scene canvas mismatches",
    );
  });

  it("checks the presentation shader module for compilation with zero messages", () => {
    expect(paritySource).toContain('["PRESENTATION_PASS_WGSL", api.PRESENTATION_PASS_WGSL],');
  });
});

describe("parity.mjs — #31 retained-frame parity and scheduler counters", () => {
  it("runs the retained-frame parity section on the real adapter", () => {
    expect(paritySource).toContain("async function runRetainedParity(device)");
    expect(paritySource).toContain("retained-frame parity + scheduler counters");
    expect(paritySource).toContain("new api.GpuScenePipeline(device, first.context, first.canvasFormat)");
  });

  it("requires a byte-identical repeated frame to do zero GPU work", () => {
    expect(paritySource).toContain("frameB.invalidation.retained !== true");
    expect(paritySource).toContain("retained frame issued");
    expect(paritySource).toContain("retained frame allocated new GPU buffers");
    expect(paritySource).toContain("retained frame re-uploaded host bytes");
    expect(paritySource).toContain("frameB.frame.dispatchCount !== 0");
  });

  it("checks retained repaint parity and partial-invalidation closures", () => {
    expect(paritySource).toContain("repaint of the retained frame changed the canvas bytes");
    expect(paritySource).toContain('"normal,lighting,presentation"');
    expect(paritySource).toContain("composite change issued compute dispatches");
    expect(paritySource).toContain("normal change dispatchCount");
  });

  it("verifies forced-full-recompute equivalence and FAILs the gate on problems", () => {
    expect(paritySource).toContain("forced full recompute differs from the retained pipeline output");
    const failIndex = paritySource.indexOf("retained-frame parity problems");
    const passIndex = paritySource.lastIndexOf("MARKER_PASS,");
    expect(failIndex).toBeGreaterThan(-1);
    expect(passIndex).toBeGreaterThan(-1);
    expect(failIndex).toBeLessThan(passIndex);
    expect(paritySource).toContain("retainedProblems");
    expect(paritySource).toContain("retained-frame parity: PASS");
  });
});

describe("test-webgpu.mjs — bounded child-exit wait before temp/profile cleanup", () => {
  it("awaits the Chrome exit (bounded) after SIGKILL instead of deleting immediately", () => {
    expect(runnerSource).toContain("chrome.once(\"exit\", resolveExit);");
    expect(runnerSource).toContain('chrome.kill("SIGKILL");');
    expect(runnerSource).toContain("await Promise.race([exited, sleep(CHROME_EXIT_WAIT_MS)]);");
    expect(runnerSource).toContain("const CHROME_EXIT_WAIT_MS = 10_000;");
    // already-exited children must not hang the cleanup
    expect(runnerSource).toContain(
      "if (chrome === null || chrome.exitCode !== null) {",
    );
  });

  it("terminates Chrome BEFORE removing the temp directory in the finally block", () => {
    const finallyStart = runnerSource.indexOf("} finally {");
    const terminateIndex = runnerSource.indexOf("await terminateChrome(chrome);");
    const rmIndex = runnerSource.indexOf("await rm(tmp, { recursive: true, force: true });");
    expect(finallyStart).toBeGreaterThan(-1);
    expect(terminateIndex).toBeGreaterThan(finallyStart);
    expect(rmIndex).toBeGreaterThan(terminateIndex);
    expect(terminateIndex).toBe(runnerSource.indexOf("await terminateChrome(chrome);")); // unique
  });
});

describe("parity.mjs — #32 partial/full parity and scheduler counters", () => {
  it("runs the partial/full parity section on the real adapter", () => {
    expect(paritySource).toContain("async function runPartialParity(device)");
    expect(paritySource).toContain("partial/full parity + counters on the real adapter");
    expect(paritySource).toContain('new api.GpuScenePipeline(device, first.context, first.canvasFormat)');
  });

  it("requires a small local edit to take the partial path with fewer workgroups", () => {
    expect(paritySource).toContain("small edit plan ${frameMove.planning.mode}");
    expect(paritySource).toContain("a small edit must dispatch fewer workgroups");
    expect(paritySource).toContain("frameMove.planning.dispatchTexels > frameMove.planning.totalTexels * 0.5");
    expect(paritySource).toContain("partial frame reported zero dirty tiles/texels");
    // the ACTUAL height-stage culling counts: the compose shaders genuinely
    // iterate ONLY the candidate ORIGINAL indices on a partial frame
    expect(paritySource).toContain("candidateSurfaceCount");
    expect(paritySource).toContain("partial height field differs from forced-full (culled compose)");
    expect(paritySource).toContain("partial objectId field differs from forced-full (owner identity)");
  });

  it("covers the zero-candidate deletion and mask partial scenarios", () => {
    expect(paritySource).toContain("zero-candidate partial: deleting an isolated surface");
    expect(paritySource).toContain("zcFrame.planning.candidateSurfaceCount !== 0");
    expect(paritySource).toContain("zero-candidate edit differs from forced-full recompute");
    expect(paritySource).toContain("mask scenario: editing a MASK surface");
    expect(paritySource).toContain("mask edit differs from forced-full recompute (canvas bytes)");
  });

  it("requires partial output to equal a forced-full recompute byte-for-byte", () => {
    expect(paritySource).toContain("partial render differs from forced-full recompute (canvas bytes)");
    expect(paritySource).toContain("forced full recompute on a FRESH pipeline must reproduce the");
    expect(paritySource).toContain("scenarios = [\"add\", \"remove\", \"reorder\", \"light\", \"material\", \"viewport\"]");
    expect(paritySource).toContain("${scenario} edit differs from forced-full recompute (canvas bytes)");
  });

  it("pins the documented full-fallback reasons for light/material/viewport", () => {
    expect(paritySource).toContain('light: "light-direction-change"');
    expect(paritySource).toContain('material: "material-values-change"');
    expect(paritySource).toContain('viewport: "viewport-change"');
  });

  it("FAILs the gate on partial problems before the PASS marker", () => {
    const failIndex = paritySource.indexOf("partial/full parity problems");
    const passIndex = paritySource.lastIndexOf("MARKER_PASS,");
    expect(failIndex).toBeGreaterThan(-1);
    expect(failIndex).toBeLessThan(passIndex);
    expect(paritySource).toContain("partial/full parity: PASS");
  });

  it("runs the tile benchmark with separate binning overhead and non-gating results", () => {
    expect(paritySource).toContain("async function runTileBenchmark(device)");
    expect(paritySource).toContain("Binning overhead (the planner's host wall-clock");
    expect(paritySource).toContain("binningMs");
    expect(paritySource).toContain("for (const tileSize of [16, 32, 64])");
    expect(paritySource).toContain("the partial/full path is chosen by the deterministic");
    expect(paritySource).toContain("never by timing");
  });
});

describe("parseResultMarker — anchored first-line marker parsing", () => {
  it("returns the exact marker from the first line only", () => {
    expect(parseResultMarker("UKIBORI_WEBGPU_PASS real adapter parity: 79 fixtures")).toBe(
      "UKIBORI_WEBGPU_PASS",
    );
    expect(parseResultMarker("UKIBORI_WEBGPU_FAIL fixture mismatches\nUKIBORI_WEBGPU_PASS sneaky")).toBe(
      "UKIBORI_WEBGPU_FAIL",
    );
    expect(parseResultMarker("UKIBORI_WEBGPU_SKIP no adapter")).toBe("UKIBORI_WEBGPU_SKIP");
    expect(parseResultMarker("UKIBORI_WEBGPU_PASS")).toBe("UKIBORI_WEBGPU_PASS");
  });

  it("rejects forged suffixes after the marker (hyphen, underscore, letter)", () => {
    // a word boundary alone would accept these forged first tokens; the
    // marker must be followed by whitespace or end-of-line
    expect(parseResultMarker("UKIBORI_WEBGPU_PASS-evil")).toBeNull();
    expect(parseResultMarker("UKIBORI_WEBGPU_PASS_evil")).toBeNull();
    expect(parseResultMarker("UKIBORI_WEBGPU_PASS-evil-real")).toBeNull();
    expect(parseResultMarker("UKIBORI_WEBGPU_FAIL_evil")).toBeNull();
    expect(parseResultMarker("UKIBORI_WEBGPU_SKIPevil")).toBeNull();
    expect(parseResultMarker("UKIBORI_WEBGPU_SKIP2")).toBeNull();
  });

  it("preserves CRLF line endings and ordinary trailing detail text", () => {
    // CRLF first line: the trailing \r is trimmed before matching
    expect(parseResultMarker("UKIBORI_WEBGPU_PASS ok\r\nfixture x: PASS")).toBe(
      "UKIBORI_WEBGPU_PASS",
    );
    expect(parseResultMarker("UKIBORI_WEBGPU_FAIL\r\nUKIBORI_WEBGPU_PASS later")).toBe(
      "UKIBORI_WEBGPU_FAIL",
    );
    expect(
      parseResultMarker(
        "UKIBORI_WEBGPU_PASS real adapter parity: 79 fixtures, 29040 texels, 0 mismatches (height tolerance 0.0001)",
      ),
    ).toBe("UKIBORI_WEBGPU_PASS");
    expect(
      parseResultMarker(
        "UKIBORI_WEBGPU_PASS\twith a tab separator",
      ),
    ).toBe("UKIBORI_WEBGPU_PASS");
  });

  it("never matches markers that are not on the first line or not anchored", () => {
    // a detail line containing the PASS word must not decide the outcome
    expect(parseResultMarker("detail line\nUKIBORI_WEBGPU_PASS sneaky")).toBeNull();
    // the token must be anchored at the start of the first line
    expect(parseResultMarker("prefix UKIBORI_WEBGPU_PASS")).toBeNull();
    expect(parseResultMarker("xUKIBORI_WEBGPU_PASS")).toBeNull();
    // running state and empty input carry no marker
    expect(parseResultMarker("UKIBORI_WEBGPU_RUNNING")).toBeNull();
    expect(parseResultMarker("")).toBeNull();
  });

  it("FAIL text containing UKIBORI_WEBGPU_PASS still parses as FAIL (regression)", () => {
    expect(
      parseResultMarker(
        "UKIBORI_WEBGPU_FAIL fixture mismatches: 42 texels\n" +
          "  fixture x: PASS (0/1 texels) but UKIBORI_WEBGPU_PASS appears in details",
      ),
    ).toBe("UKIBORI_WEBGPU_FAIL");
  });

  it("the runner decides the exit code by the parsed marker, never by substring search", () => {
    // the decision must go through parseResultMarker
    expect(runnerSource).toContain("const marker = parseResultMarker(result);");
    expect(runnerSource).toContain("if (marker === MARKER_PASS) {");
    expect(runnerSource).toContain("if (marker === MARKER_FAIL) {");
    // the marker must be followed by whitespace or end-of-line (no forged
    // suffixes like UKIBORI_WEBGPU_PASS-evil)
    expect(runnerSource).toContain("(?:[ \\t]|$)");
    // the FAIL branch must set a nonzero exit code
    const failBranch = runnerSource.indexOf("if (marker === MARKER_FAIL) {");
    const failExitCode = runnerSource.indexOf("process.exitCode = 1;", failBranch);
    const skipBranch = runnerSource.indexOf("if (marker === MARKER_SKIP) {");
    expect(failBranch).toBeGreaterThan(-1);
    expect(failExitCode).toBeGreaterThan(failBranch);
    expect(failExitCode).toBeLessThan(skipBranch);
    // substring includes() must not appear in the marker decision path
    expect(runnerSource).not.toContain("result.includes(MARKER_PASS)");
    expect(runnerSource).not.toContain("result.includes(MARKER_FAIL)");
    // the poll uses the same anchored parser, so RUNNING never counts
    expect(runnerSource).toContain("parseResultMarker(text) !== null");
  });

  it("treats SKIP as a failure: only a real-adapter PASS exits zero", () => {
    // the SKIP marker branch must set a nonzero exit code (PASS is the only
    // success condition for the real-GPU verification gate locally; the #30
    // CI workflow may translate an anchored parsed SKIP into a
    // capability-dependent non-failing outcome, never a substring search)
    const passBranch = runnerSource.indexOf("if (marker === MARKER_PASS) {");
    const skipBranch = runnerSource.indexOf("if (marker === MARKER_SKIP) {");
    const skipExitCode = runnerSource.indexOf("process.exitCode = 1;", skipBranch);
    expect(passBranch).toBeGreaterThan(-1);
    expect(skipBranch).toBeGreaterThan(passBranch);
    expect(skipExitCode).toBeGreaterThan(skipBranch);
    // the Chrome-not-found skip path also exits nonzero, never a silent
    // success for an environment that cannot run a real adapter
    const chromeSkip = runnerSource.indexOf("SKIP is a failure: only a real-adapter PASS counts");
    const chromeSkipExit = runnerSource.indexOf("process.exit(1);", chromeSkip);
    expect(chromeSkip).toBeGreaterThan(-1);
    expect(chromeSkipExit).toBeGreaterThan(chromeSkip);
  });
});
