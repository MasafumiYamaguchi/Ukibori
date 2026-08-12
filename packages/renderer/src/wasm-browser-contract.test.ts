import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
// The runner is a plain ESM CLI script without type declarations; importing
// parseWasmResultMarker for unit tests is intentional.
// @ts-expect-error - scripts/test-wasm-browser.mjs has no type declarations
import { parseWasmResultMarker } from "../scripts/test-wasm-browser.mjs";

/**
 * Deterministic source-level contract assertions for the #33 browser WASM
 * harness + runner (the same hardening model as the #30 test-browser
 * contract tests, which these files mirror):
 *
 * - a fixture/lifecycle step that THROWS or reports a failure must FAIL the
 *   run (no false PASS from a zero-mismatch count)
 * - a WASM-path result must report the WASM stage exactly (`normal: "wasm"`,
 *   every other stage "typescript") — a TypeScript-only execution is never
 *   labeled WASM
 * - the runner must parse ONLY the first line with an anchored exact marker
 *   token; FAIL/SKIP can never be flipped to PASS by substring search
 * - the runner must await the killed Chrome's exit (bounded) BEFORE removing
 *   the profile/temp directory it created
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const harnessSource = readFileSync(resolve(packageRoot, "test-browser", "wasm-parity.mjs"), "utf8");
const runnerSource = readFileSync(resolve(packageRoot, "scripts", "test-wasm-browser.mjs"), "utf8");

describe("#33 wasm-parity.mjs — no false PASS and honest WASM labeling", () => {
  it("returns an error-bearing result when a fixture throws", () => {
    expect(harnessSource).toContain("String(error?.stack ?? error)");
    expect(harnessSource).toContain("recordFailure(`fixture ${fixture.id} threw:");
  });

  it("counts execution failures and FAILs the final marker when any exist", () => {
    expect(harnessSource).toContain("let executionFailures = 0;");
    expect(harnessSource).toContain("executionFailures += 1;");
    expect(harnessSource).toContain("if (executionFailures > 0) {");
    // the FAIL branch must run BEFORE the final PASS marker
    const failIndex = harnessSource.indexOf("if (executionFailures > 0) {");
    const passIndex = harnessSource.indexOf("${MARKER_PASS} wasm parity+lifecycle");
    expect(failIndex).toBeGreaterThan(-1);
    expect(passIndex).toBeGreaterThan(-1);
    expect(failIndex).toBeLessThan(passIndex);
  });

  it("requires exact stage provenance: normal in WASM, the rest TypeScript", () => {
    expect(harnessSource).toContain("stages.normal !== \"wasm\"");
    expect(harnessSource).toContain('for (const stage of ["height", "objectId", "visibility", "lighting"])');
    expect(harnessSource).toContain("wrongly labeled");
  });

  it("rejects an auto decision that lost the WASM path (stage/reason reported)", () => {
    expect(harnessSource).toContain("selection stage should be");
    expect(harnessSource).toContain("auto should select wasm on this browser");
  });
});

describe("#33 parseWasmResultMarker — anchored first-line parsing", () => {
  it("parses an exact PASS/FAIL/SKIP marker on the first line", () => {
    expect(parseWasmResultMarker("UKIBORI_WASM_PASS everything is fine")).toBe("UKIBORI_WASM_PASS");
    expect(parseWasmResultMarker("UKIBORI_WASM_FAIL one failure")).toBe("UKIBORI_WASM_FAIL");
    expect(parseWasmResultMarker("UKIBORI_WASM_SKIP no chrome")).toBe("UKIBORI_WASM_SKIP");
  });

  it("rejects forged tokens with letter/hyphen/underscore suffixes", () => {
    expect(parseWasmResultMarker("UKIBORI_WASM_PASS-evil")).toBeNull();
    expect(parseWasmResultMarker("UKIBORI_WASM_PASS_evil")).toBeNull();
    expect(parseWasmResultMarker("UKIBORI_WASM_PASSEvil")).toBeNull();
    expect(parseWasmResultMarker("x UKIBORI_WASM_PASS")).toBeNull();
    expect(parseWasmResultMarker("")).toBeNull();
  });

  it("FAIL on the first line cannot be flipped by a later PASS word", () => {
    expect(
      parseWasmResultMarker("UKIBORI_WASM_FAIL fixture broke\nUKIBORI_WASM_PASS later"),
    ).toBe("UKIBORI_WASM_FAIL");
  });
});

describe("#33 test-wasm-browser.mjs — runner safety", () => {
  it("awaits the killed Chrome's exit (bounded) before removing its directory", () => {
    expect(runnerSource).toContain("terminateChrome");
    expect(runnerSource).toContain("chrome.once(\"exit\", resolveExit)");
    expect(runnerSource).toContain("CHROME_EXIT_WAIT_MS");
    const terminateIndex = runnerSource.indexOf("await terminateChrome(chrome)");
    const rmIndex = runnerSource.indexOf("await rm(tmp");
    expect(terminateIndex).toBeGreaterThan(-1);
    expect(rmIndex).toBeGreaterThan(-1);
    expect(terminateIndex).toBeLessThan(rmIndex);
  });

  it("parses only the first line marker and treats FAIL/SKIP as failures", () => {
    expect(runnerSource).toContain("parseWasmResultMarker(text)");
    expect(runnerSource).toContain("// FAIL and SKIP are both failures for this gate");
    expect(runnerSource).toContain("process.exitCode = 1");
  });

  it("tests the built public ESM bundle (never the TS sources)", () => {
    expect(runnerSource).toContain('npm", ["run", "build", "-w", "ukibori-renderer"');
    expect(runnerSource).toContain('"dist", "index.js"');
  });
});
