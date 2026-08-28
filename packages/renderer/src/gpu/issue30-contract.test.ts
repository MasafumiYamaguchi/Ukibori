import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
// The CI gate is a plain ESM CLI script without type declarations; importing
// its pure helpers for unit tests is intentional.
// @ts-expect-error - scripts/summarize-webgpu.mjs has no type declarations
import { ciOutcome, parseSummaryLines } from "../../scripts/summarize-webgpu.mjs";
// @ts-expect-error - scripts/test-webgpu.mjs has no type declarations
import { parseResultMarker } from "../../scripts/test-webgpu.mjs";
// @ts-expect-error - test-browser modules are plain ESM without declarations
import { createCatalog, CATALOG_VERSION, POLICY_TABLE, REQUIRED_COVERAGE, policyFor } from "../../test-browser/catalog.mjs";
// @ts-expect-error - test-browser modules are plain ESM without declarations
import { createOracle } from "../../test-browser/oracle.mjs";
import * as api from "../index";

/**
 * #30 structural contracts:
 *
 * - the golden fixture catalog (test-browser/catalog.mjs) covers every item
 *   of the brief's coverage list and gives every fixture explicit metadata
 *   (stable id, semantic categories, logical dimensions, DPR, parameters,
 *   compared buffers + policy)
 * - the real-WebGPU CI workflow (.github/workflows/golden-gate.yml) runs the
 *   real runner on macOS with Chrome, keeps the local SKIP-is-a-failure
 *   semantics and translates ONLY an anchored, parsed SKIP into a
 *   capability-dependent non-failing outcome
 * - the CI gate (scripts/summarize-webgpu.mjs) decides by the anchored
 *   first-line marker, never by substring search, and FAIL can never be
 *   converted to SKIP or PASS
 * - the full harness log is captured as an artifact and a concise job
 *   summary (adapter/backend when exposed, marker, fixture totals, per-pass
 *   mismatch totals) is emitted
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const catalogSource = readFileSync(resolve(packageRoot, "test-browser", "catalog.mjs"), "utf8");
const oracleSource = readFileSync(resolve(packageRoot, "test-browser", "oracle.mjs"), "utf8");
const paritySource = readFileSync(resolve(packageRoot, "test-browser", "parity.mjs"), "utf8");
const runnerSource = readFileSync(resolve(packageRoot, "scripts", "test-webgpu.mjs"), "utf8");
const summarizeSource = readFileSync(resolve(packageRoot, "scripts", "summarize-webgpu.mjs"), "utf8");
const goldenCliSource = readFileSync(resolve(packageRoot, "scripts", "golden-cpu.mjs"), "utf8");
const workflowSource = readFileSync(
  resolve(packageRoot, "..", "..", ".github", "workflows", "golden-gate.yml"),
  "utf8",
);

const catalog = createCatalog(api);
const oracle = createOracle(api);

/** Structural type of a finalized catalog fixture (from the untyped .mjs). */
interface FixtureLike {
  id: string;
  name: string;
  categories: string[];
  logical: { width: number; height: number };
  render: { width: number; height: number };
  dpr: number;
  params: { dpr: number; scene: unknown; render: unknown };
  buffers: string[];
  golden: boolean;
  scene?: unknown;
  renders?: unknown[];
}
const allFixtures: FixtureLike[] = [
  ...(catalog.computeFixtures as FixtureLike[]),
  ...(catalog.presentationFixtures as FixtureLike[]),
];
interface PolicyEntry {
  buffer: string;
  policy: string;
  tolerance: number;
  description: string;
}
const policyEntries = POLICY_TABLE as PolicyEntry[];

describe("#30 catalog — every fixture has explicit metadata", () => {
  it("pins the catalog version and fixture totals (92 compute + 19 presentation)", () => {
    expect(CATALOG_VERSION).toBe(5);
    expect(catalog.computeFixtures.length).toBe(92);
    expect(catalog.presentationFixtures.length).toBe(19);
  });

  it("gives every fixture a stable id, categories, dimensions, dpr, params and buffers", () => {
    for (const fixture of allFixtures) {
      expect(fixture.id).toBeTruthy();
      expect(fixture.name).toBe(fixture.id);
      expect(Array.isArray(fixture.categories)).toBe(true);
      expect(fixture.categories.length).toBeGreaterThan(0);
      expect(fixture.logical.width).toBeGreaterThan(0);
      expect(fixture.logical.height).toBeGreaterThan(0);
      expect([1, 1.5, 2]).toContain(fixture.dpr);
      expect(fixture.params).toBeTruthy();
      expect(fixture.params.dpr).toBe(fixture.dpr);
      expect(Array.isArray(fixture.buffers)).toBe(true);
      expect(fixture.buffers.length).toBeGreaterThan(0);
      // every compared buffer resolves to a declared policy
      for (const buffer of fixture.buffers) {
        const policyName = buffer.startsWith("canvas-frame-") ? "canvas" : buffer;
        expect(policyFor(policyName)).toBeTruthy();
      }
      // ids are unique across the whole catalog
      const allIds = allFixtures.map((f) => f.id);
      expect(new Set(allIds).size).toBe(allIds.length);
    }
  });

  it("covers every required semantic category from the brief", () => {
    const covered = new Set(
      allFixtures.flatMap((fixture) => fixture.categories),
    );
    for (const required of REQUIRED_COVERAGE) {
      expect(covered.has(required)).toBe(true);
    }
  });

  it("documents only the supported transforms (translation/size/DPR), never rotation or skew", () => {
    // the scene contract has no rotation/skew: no fixture may claim it
    for (const fixture of allFixtures) {
      expect(
        fixture.categories.some((c: string) => c.includes("rotat") || c.includes("skew")),
      ).toBe(false);
    }
    expect(catalogSource).toContain("there is NO rotation/skew support");
    expect(catalogSource).toContain("Only translation/size (position/size) and DPR transforms are");
  });

  it("marks a representative static-golden subset with every compared buffer", () => {
    const golden = allFixtures.filter((fixture) => fixture.golden);
    expect(golden.length).toBeGreaterThanOrEqual(20);
    for (const fixture of golden) {
      expect(fixture.categories).toContain("static-golden");
      expect(fixture.buffers.length).toBeGreaterThan(0);
    }
  });

  it("centralizes the comparison policy table with the fixed tolerances", () => {
    const byName = new Map<string, PolicyEntry>(
      policyEntries.map((entry) => [entry.buffer, entry]),
    );
    expect(byName.get("height")!.tolerance).toBe(1e-4);
    expect(byName.get("casterHeight")!.tolerance).toBe(1e-4);
    expect(byName.get("normal")!.tolerance).toBe(1e-4);
    expect(byName.get("diffuse")!.tolerance).toBe(1e-3);
    expect(byName.get("specular")!.tolerance).toBe(1e-3);
    expect(byName.get("coverage")!.policy).toBe("exact");
    expect(byName.get("objectId")!.policy).toBe("exact");
    expect(byName.get("materialId")!.policy).toBe("exact");
    expect(byName.get("visibility")!.policy).toBe("exact-0-1");
    // #43: the reconstructed field has its OWN documented tight tolerance,
    // distinct from the raw exact contract
    expect(byName.get("visibility-reconstructed")!.policy).toBe("reconstructed-abs-tolerance");
    expect(byName.get("visibility-reconstructed")!.tolerance).toBe(1e-6);
    expect(byName.get("encodedHeader")!.policy).toBe("exact");
    expect(byName.get("lightingColor")!.description).toContain("exact alpha");
    expect(byName.get("canvas")!.description).toContain("exact alpha");
  });
});

describe("#30 mismatch classification — exactly one of the six, else unclassified", () => {
  it("classifies exact-semantic fields as contract", () => {
    expect(oracle.classifyMismatch("objectId", {})).toBe("contract");
    expect(oracle.classifyMismatch("materialId", {})).toBe("contract");
    expect(oracle.classifyMismatch("coverage", {})).toBe("contract");
    expect(oracle.classifyMismatch("visibility", {})).toBe("contract");
    expect(oracle.classifyMismatch("encodedHeader", {})).toBe("contract");
  });

  it("classifies height shifts as coordinate and numeric divergences as precision", () => {
    expect(oracle.classifyMismatch("height", { coordinateShift: true })).toBe("coordinate");
    expect(oracle.classifyMismatch("height", { coordinateShift: false })).toBe("precision");
    expect(oracle.classifyMismatch("casterHeight", {})).toBe("precision");
    expect(oracle.classifyMismatch("normal", {})).toBe("precision");
    expect(oracle.classifyMismatch("diffuse", {})).toBe("precision");
    expect(oracle.classifyMismatch("specular", {})).toBe("precision");
  });

  it("classifies alpha deltas as color-space and mutation audits as scheduling", () => {
    expect(oracle.classifyMismatch("lightingColor", { alphaMismatch: true })).toBe("color-space");
    expect(oracle.classifyMismatch("canvas", { alphaMismatch: true })).toBe("color-space");
    expect(oracle.classifyMismatch("lightingColor", {})).toBe("precision");
    expect(oracle.classifyMismatch("mutation", {})).toBe("scheduling");
    expect(oracle.classifyMismatch("something-unknown", {})).toBe("unclassified");
  });

  // #43: a reconstructed-visibility mismatch is ALWAYS classified through
  // the explicit context the comparison passes (contract for domain
  // violations, precision for tolerance exceedance) — never unclassified.
  it("classifies every visibility-reconstructed mismatch explicitly", () => {
    expect(
      oracle.classifyMismatch("visibility-reconstructed", {
        classification: "contract",
      }),
    ).toBe("contract");
    expect(
      oracle.classifyMismatch("visibility-reconstructed", {
        classification: "precision",
      }),
    ).toBe("precision");
    // and the comparison itself passes exactly those classifications
    const mismatches = oracle.compareReconstructedVisibility(
      { id: "x", shadowOptions: { samples: 4 }, scene: { light: { angularRadius: 0.2 } } },
      new Float32Array([0.5, 0.5, 0.5]),
      new Float32Array([0.5, Number.NaN, 0.5001]),
      3,
    );
    expect(mismatches.mismatches).toBe(2);
    expect(mismatches.samples[0].includes("classification=contract")).toBe(true);
    expect(mismatches.samples[1].includes("classification=precision")).toBe(true);
  });

  it("never guesses silently: the classifier emits only the six documented labels or unclassified", () => {
    const allowed = new Set(["contract", "coordinate", "precision", "sampling", "scheduling", "color-space", "unclassified"]);
    for (const buffer of ["height", "normal", "visibility", "lightingColor", "canvas", "mutation", "?"]) {
      expect(allowed.has(oracle.classifyMismatch(buffer, {}))).toBe(true);
    }
  });

  it("emits actionable per-mismatch context, values, policy and classification", () => {
    const fixture = allFixtures[0]!;
    const sample = oracle.mismatchReport(
      fixture,
      "height",
      1,
      fixture.render.width,
      0.25,
      0.5,
      0.25,
      { coordinateShift: false },
    );
    for (const field of [
      `fixture=${fixture.id}`,
      "categories=",
      "pass/buffer=height",
      "dimensions=logical:",
      "dpr:",
      "params=",
      "coordinate=",
      "index=1",
      "cpu=0.25",
      "gpu=0.5",
      "delta=0.25",
      "policy=abs-tolerance",
      "tolerance=0.0001",
      "classification=precision",
    ]) {
      expect(sample).toContain(field);
    }
  });
});

describe("#30 static CPU goldens — maintenance and review workflow", () => {
  it("normal runs only verify; regeneration is an explicit separate command", () => {
    // verify is wired into the package test script
    expect(goldenCliSource).toContain('mode === "verify" ? "VERIFY" : "UPDATE"');
    expect(goldenCliSource).toContain("node scripts/golden-cpu.mjs --update");
    expect(goldenCliSource).toContain("--update");
    expect(goldenCliSource).toContain("--verify");
    // regeneration prints exactly which fixture/buffer changed
    expect(goldenCliSource).toContain("fixture ${change.fixtureId} buffer ${change.buffer}");
    expect(goldenCliSource).toContain("oldDigest ?? \"(missing)\"");
    // the CPU renderer is never changed to fix a golden
    expect(goldenCliSource).toContain("Do NOT edit the CPU renderer to fix this");
    expect(goldenCliSource).toContain("classify and explain the semantic change");
    // the maintenance command must never run implicitly
    expect(goldenCliSource).toContain("ukibori-renderer` and review the JSON diff");
  });

  it("the golden file is a reviewable JSON artifact (no binary dumps)", () => {
    expect(goldensFilePathExists()).toBe(true);
    const goldens = JSON.parse(
      readFileSync(resolve(packageRoot, "test-browser", "goldens", "cpu-goldens.json"), "utf8"),
    );
    expect(goldens.format).toBe("ukibori-cpu-goldens-v1");
    for (const record of goldens.goldens) {
      for (const buffer of record.buffers) {
        expect(buffer.digest).toMatch(/^[0-9a-f]{64}$/);
        // probes are human-readable (x, y, value), never binary
        expect(JSON.stringify(buffer.probes)).not.toContain("\\u0000");
      }
    }
  });

  it("the vitest suite verifies the goldens (only verification runs implicitly)", () => {
    const goldenTest = readFileSync(resolve(packageRoot, "src", "cpu-goldens.test.ts"), "utf8");
    expect(goldenTest).toContain("await runner.verify(goldens)");
    expect(goldenTest).toContain("recomputes every golden digest and finds zero changes");
    expect(goldenTest).toContain("goldens:update -w ukibori-renderer");
  });
});

describe("#30 CI gate — anchored marker semantics (never substring search)", () => {
  it("PASS exits zero and SKIP is a capability-dependent non-failing outcome", () => {
    expect(ciOutcome("UKIBORI_WEBGPU_PASS real adapter parity: 79 fixtures\nSUMMARY {}").exitCode).toBe(0);
    expect(ciOutcome("UKIBORI_WEBGPU_SKIP no WebGPU adapter available\nSUMMARY {}").exitCode).toBe(0);
    expect(ciOutcome("UKIBORI_WEBGPU_SKIP no WebGPU adapter available\nSUMMARY {}").reason).toContain("capability-dependent");
  });

  it("FAIL exits nonzero and can NEVER be converted to SKIP or PASS", () => {
    // a FAIL detail line containing PASS/SKIP words must not flip the gate
    const log =
      "UKIBORI_WEBGPU_FAIL fixture mismatches: 42 texels\n" +
      "  UKIBORI_WEBGPU_SKIP appears in details\n" +
      "  UKIBORI_WEBGPU_PASS appears in details\n" +
      "SUMMARY {}";
    expect(ciOutcome(log).exitCode).toBe(1);
    expect(ciOutcome(log).marker).toBe("UKIBORI_WEBGPU_FAIL");
    expect(ciOutcome("UKIBORI_WEBGPU_FAIL shader compilation failed").exitCode).toBe(1);
    expect(ciOutcome("UKIBORI_WEBGPU_FAIL device validation errors").exitCode).toBe(1);
    expect(ciOutcome("UKIBORI_WEBGPU_FAIL harness threw").exitCode).toBe(1);
  });

  it("a malformed or missing marker fails the job", () => {
    expect(ciOutcome("").exitCode).toBe(1);
    expect(ciOutcome("no marker at all\nUKIBORI_WEBGPU_PASS later").exitCode).toBe(1);
    // forged suffix tokens are NOT markers
    expect(ciOutcome("UKIBORI_WEBGPU_SKIP-evil\n").exitCode).toBe(1);
    expect(ciOutcome("UKIBORI_WEBGPU_PASS_evil\n").exitCode).toBe(1);
    expect(parseResultMarker("UKIBORI_WEBGPU_RUNNING\n")).toBeNull();
  });

  it("the gate and the runner share the same anchored parser", () => {
    // the CI decision must go through parseResultMarker (anchored first line)
    expect(summarizeSource).toContain("import { parseResultMarker } from \"./test-webgpu.mjs\";");
    expect(summarizeSource).toContain("const marker = parseResultMarker(logText);");
    // never by substring search
    expect(summarizeSource).not.toContain(".includes(");
    expect(summarizeSource).toContain("the first line, parsed by the shared anchored");
    // FAIL is never translatable
    expect(summarizeSource).toContain("FAIL can never become SKIP or PASS");
  });

  it("parses the SUMMARY JSON lines for the job summary (adapter + totals)", () => {
    const log =
      "UKIBORI_WEBGPU_PASS real adapter parity\n" +
      "SUMMARY {\"adapter\":{\"vendor\":\"Apple\",\"device\":\"Metal\"},\"fixtures\":79,\"normalMismatches\":0,\"shadowMismatches\":0,\"presentHard\":0}\n" +
      "  fixture rounded-flat-dpr1: PASS";
    const summaries = parseSummaryLines(log);
    expect(summaries.length).toBe(1);
    expect(summaries[0].adapter.vendor).toBe("Apple");
    expect(summaries[0].fixtures).toBe(79);
    // malformed summary lines never decide the outcome
    expect(parseSummaryLines("UKIBORI_WEBGPU_PASS\nSUMMARY {broken")).toEqual([]);
  });

  it("the harness emits the SUMMARY line right after the marker with adapter + per-pass totals", () => {
    expect(paritySource).toContain("SUMMARY \" + JSON.stringify(summaryData)");
    expect(paritySource).toContain("summaryData.adapter = {");
    expect(paritySource).toContain("adapter.info?.vendor ?? null");
    expect(paritySource).toContain("normalMismatches = totalNormalMismatches");
    expect(paritySource).toContain("shadowMismatches = totalShadowMismatches");
    expect(paritySource).toContain("casterMismatches = totalCasterMismatches");
    expect(paritySource).toContain("diffuseMismatches = totalDiffuseMismatches");
    expect(paritySource).toContain("specularMismatches = totalSpecularMismatches");
    expect(paritySource).toContain("colorHard = totalColorHard");
    expect(paritySource).toContain("presentHard = totalPresentHard");
    expect(paritySource).toContain("presentAlphaBad = totalPresentAlphaBad");
    expect(paritySource).toContain("fixtures = fixtureResults.length");
  });
});

describe("#30 real-WebGPU CI workflow — golden gate", () => {
  it("runs on a GitHub-hosted macOS job with Chrome and the real runner", () => {
    expect(workflowSource).toContain("runs-on: macos-latest");
    expect(workflowSource).toContain("name: webgpu-golden-gate");
    expect(workflowSource).toContain("npm run test:webgpu -w ukibori-renderer");
    // the workflow documents that the GPU is never disabled; the actual
    // steps never pass --disable-gpu or replace the gate with mocks
    expect(workflowSource).toContain("never --disable-gpu, never mocks");
    const workflowSteps = workflowSource.slice(workflowSource.indexOf("jobs:"));
    expect(workflowSteps).not.toContain("--disable-gpu");
    expect(workflowSteps).not.toContain("mock");
  });

  it("installs with npm ci and runs the golden/contract tests", () => {
    expect(workflowSource).toContain("npm ci");
    expect(workflowSource).toContain("npm test");
    expect(workflowSource).toContain("npm run test:golden -w ukibori-renderer");
  });

  it("captures the full harness log as an artifact and emits a job summary", () => {
    expect(workflowSource).toContain("> webgpu.log 2>&1");
    expect(workflowSource).toContain("actions/upload-artifact@v4");
    expect(workflowSource).toContain("name: webgpu-harness-log");
    expect(workflowSource).toContain("if-no-files-found: error");
    expect(workflowSource).toContain("if: always()");
    // the job summary goes through GITHUB_STEP_SUMMARY in the summarize script
    expect(summarizeSource).toContain("GITHUB_STEP_SUMMARY");
  });

  it("translates ONLY an anchored parsed SKIP; FAIL and missing markers fail the job", () => {
    // the workflow gate is the summarize script (anchored-marker semantics)
    expect(workflowSource).toContain("summarize-webgpu.mjs webgpu-result.txt");
    expect(workflowSource).toContain("WEBGPU_RESULT_PATH=webgpu-result.txt npm run test:webgpu");
    expect(workflowSource).toContain("Anchored-marker CI gate");
    // the local runner keeps SKIP as a failure; only the CI gate translates
    expect(runnerSource).toContain("SKIP is a failure: only a real-adapter PASS counts");
    // the gate marks capability-dependent SKIP as non-failing
    expect(summarizeSource).toContain("capability-dependent SKIP");
  });

  it("the runner serves the catalog and oracle modules to the harness", () => {
    expect(runnerSource).toContain('"catalog.mjs", "oracle.mjs"');
  });
});

function goldensFilePathExists() {
  try {
    readFileSync(resolve(packageRoot, "test-browser", "goldens", "cpu-goldens.json"), "utf8");
    return true;
  } catch {
    return false;
  }
}
