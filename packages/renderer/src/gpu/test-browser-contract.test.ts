import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
// The runner is a plain ESM CLI script without type declarations; importing
// parseResultMarker for unit tests is intentional.
// @ts-expect-error - scripts/test-webgpu.mjs has no type declarations
import { parseResultMarker } from "../../scripts/test-webgpu.mjs";

/**
 * Deterministic source-level contract assertions for the #25 real-GPU
 * integration pieces (`test-browser/parity.mjs` harness and
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
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const paritySource = readFileSync(resolve(packageRoot, "test-browser", "parity.mjs"), "utf8");
const runnerSource = readFileSync(resolve(packageRoot, "scripts", "test-webgpu.mjs"), "utf8");

describe("parity.mjs — fixture failure accounting (no false PASS)", () => {
  it("returns an error-bearing result when runFixture throws", () => {
    expect(paritySource).toContain("failure = String(error?.stack ?? error);");
    expect(paritySource).toContain("return { name: fixture.name, error: failure };");
  });

  it("treats a non-null scoped validation error as a fixture failure", () => {
    expect(paritySource).toContain(
      "return { name: fixture.name, error: `validation: ${scopedError.message}` };",
    );
  });

  it("pops the validation error scope exactly once per fixture (no double-pop)", () => {
    // count the actual call syntax so the doc comment mentioning the method
    // name does not count as an occurrence
    const pushes = paritySource.split("device.pushErrorScope(").length - 1;
    const pops = paritySource.split("device.popErrorScope(").length - 1;
    expect(pushes).toBe(1);
    expect(pops).toBe(1);
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

describe("parity.mjs — #26 extreme normal fixtures", () => {
  it("pins largest-finite-f32 derivative/scale parity and subnormal sanitization", () => {
    expect(paritySource).toContain("const F32_MAX = 3.4028234663852886e38;");
    expect(paritySource).toContain('name: "synth-extreme-f32-diff-scale"');
    expect(paritySource).toContain(
      "field: synthHeight(3, 1, (x) => (x === 2 ? 0 : F32_MAX))",
    );
    expect(paritySource).toContain(
      "normalOptions: { scaleX: F32_MAX, scaleY: F32_MAX, normalScale: 1 }",
    );
    expect(paritySource).toContain('name: "synth-normal-scale-below-min-subnormal"');
    expect(paritySource).toContain("normalScale: 5e-324");
    expect(paritySource).toContain('name: "synth-normal-scale-min-subnormal"');
  });

  it("contains no temporary raw shader or height-readback probe", () => {
    expect(paritySource).not.toContain("TEMPORARY DEBUG");
    expect(paritySource).not.toContain("rawProbe");
    expect(paritySource).not.toContain("synth height first8");
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

describe("parseResultMarker — anchored first-line marker parsing", () => {
  it("returns the exact marker from the first line only", () => {
    expect(parseResultMarker("UKIBORI_WEBGPU_PASS real adapter parity: 16 fixtures")).toBe(
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
        "UKIBORI_WEBGPU_PASS real adapter parity: 16 fixtures, 29040 texels, 0 mismatches (height tolerance 0.0001)",
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
    // success condition for the #26 real-GPU verification gate)
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
