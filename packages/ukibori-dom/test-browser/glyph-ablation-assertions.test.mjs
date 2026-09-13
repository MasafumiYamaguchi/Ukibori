import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareShadowPasses,
  lightAssertionFailures,
  shadowAssertionFailures,
} from "../scripts/glyph-ablation.mjs";

/**
 * Focused fail-fast integrity tests for the glyph-ablation runner assertions.
 *
 * `lightAssertionFailures` must reject missing/malformed canvas, region and
 * dpr metadata per required direction, and must REQUIRE the DPR 1 / 1.5 / 2
 * visible group canvas summaries before cross-group scale checks — absence can
 * never pass. The current saved reports are asserted to pass so the committed
 * evidence stays bound to the same rules.
 */

const here = dirname(fileURLToPath(import.meta.url));
const artifact = (name) =>
  JSON.parse(readFileSync(resolve(here, "glyph-ablation-artifacts", "after", name), "utf8"));

const VISIBLE_GROUPS = [
  ["dpr-1-ink-visible", 1, [508, 348]],
  ["dpr-1.5-ink-visible", 1.5, [762, 522]],
  ["dpr-2-ink-visible", 2, [1016, 696]],
  ["dpr-1-ink-suppressed", 1, [508, 348]],
];

function validLightReport() {
  const report = {};
  for (const [key, dpr, canvas] of VISIBLE_GROUPS) {
    report[key] = {};
    for (const direction of ["left", "right", "top", "bottom"]) {
      report[key][direction] = {
        mean: [1, 1, 1],
        canvas: [...canvas],
        dpr,
        region: { x: -44, y: -54, w: 508, h: 348 },
        panelOpaque: true,
        opaqueCount: 1000,
      };
    }
    report[key]["delta-right-left"] = { n: 16, mean: 1, max: 2 };
    report[key]["delta-bottom-top"] = { n: 16, mean: 1, max: 2 };
  }
  return report;
}

describe("glyph-ablation light-matrix fail-fast assertions", () => {
  it("accepts the current saved light-response report", () => {
    expect(lightAssertionFailures(artifact("light-response-report.json"))).toEqual([]);
  });

  it("accepts a synthetic well-formed report", () => {
    expect(lightAssertionFailures(validLightReport())).toEqual([]);
  });

  it("fails a missing direction entry", () => {
    const report = validLightReport();
    delete report["dpr-2-ink-visible"].left;
    const failures = lightAssertionFailures(report).join("\n");
    expect(failures).toContain("dpr-2-ink-visible/left: missing entry");
  });

  it("fails a missing canvas", () => {
    const report = validLightReport();
    delete report["dpr-2-ink-visible"].left.canvas;
    expect(lightAssertionFailures(report).join("\n")).toContain(
      "dpr-2-ink-visible/left: missing/malformed canvas",
    );
  });

  it("fails a malformed canvas (wrong length / non-numeric)", () => {
    const report = validLightReport();
    report["dpr-2-ink-visible"].left.canvas = [1016];
    report["dpr-2-ink-visible"].right.canvas = [1016, "696"];
    const failures = lightAssertionFailures(report).join("\n");
    expect(failures).toContain("dpr-2-ink-visible/left: missing/malformed canvas");
    expect(failures).toContain("dpr-2-ink-visible/right: missing/malformed canvas");
  });

  it("fails a missing region", () => {
    const report = validLightReport();
    delete report["dpr-1-ink-visible"].top.region;
    expect(lightAssertionFailures(report).join("\n")).toContain(
      "dpr-1-ink-visible/top: missing/malformed region w/h",
    );
  });

  it("fails a malformed region w/h", () => {
    const report = validLightReport();
    report["dpr-1-ink-visible"].bottom.region = { w: "508", h: 348 };
    expect(lightAssertionFailures(report).join("\n")).toContain(
      "dpr-1-ink-visible/bottom: missing/malformed region w/h",
    );
  });

  it("fails a missing or non-numeric dpr", () => {
    const report = validLightReport();
    delete report["dpr-1.5-ink-visible"].left.dpr;
    report["dpr-1.5-ink-visible"].right.dpr = "1.5";
    const failures = lightAssertionFailures(report).join("\n");
    expect(failures).toContain("dpr-1.5-ink-visible/left: missing/non-numeric debugState dpr");
    expect(failures).toContain("dpr-1.5-ink-visible/right: missing/non-numeric debugState dpr");
  });

  it("fails a wrong requested dpr", () => {
    const report = validLightReport();
    report["dpr-2-ink-visible"].top.dpr = 1;
    expect(lightAssertionFailures(report).join("\n")).toContain(
      "dpr-2-ink-visible/top: debugState dpr 1 != requested 2",
    );
  });

  it("fails a wrong canvas for the region/dpr", () => {
    const report = validLightReport();
    report["dpr-1.5-ink-visible"].left.canvas = [508, 348];
    expect(lightAssertionFailures(report).join("\n")).toContain(
      "dpr-1.5-ink-visible/left: canvas 508x348 != expected 762x522 at dpr 1.5",
    );
  });

  it("fails a missing DPR-2 visible group before cross-group checks", () => {
    const report = validLightReport();
    delete report["dpr-2-ink-visible"];
    const failures = lightAssertionFailures(report).join("\n");
    expect(failures).toContain("missing group dpr-2-ink-visible");
    expect(failures).toContain("missing canvas summary for dpr-2-ink-visible");
  });

  it("fails when all DPR canvases are the same size (mislabeled DPR)", () => {
    const report = validLightReport();
    for (const key of ["dpr-1.5-ink-visible", "dpr-2-ink-visible"]) {
      for (const direction of ["left", "right", "top", "bottom"]) {
        report[key][direction].canvas = [508, 348];
        report[key][direction].dpr = 1;
      }
    }
    const failures = lightAssertionFailures(report).join("\n");
    expect(failures).toContain("is not 2x the dpr-1 canvas");
    expect(failures).toContain("did not scale above dpr-1");
  });
});

describe("glyph-ablation shadow fail-fast assertions", () => {
  it("accepts the current saved shadow-verification report", () => {
    expect(shadowAssertionFailures(artifact("shadow-verification-report.json"), "saved")).toEqual([]);
  });

  it("treats horizontalMax and secondary rayMax drift as pass instability", () => {
    const report = artifact("shadow-verification-report.json");
    const pass1 = { cases: report.cases };
    const pass2 = { cases: JSON.parse(JSON.stringify(report.cases)) };
    expect(compareShadowPasses(pass1, pass2).stable).toBe(true);
    pass2.cases.default["bias0.5"].horizontalMax += 1;
    const compared = compareShadowPasses(pass1, pass2);
    expect(compared.stable).toBe(false);
    expect(compared.differences.join("\n")).toContain("horizontalMax");
  });
});

describe("glyph-ablation bias-decision / fixture-fidelity assertions", () => {
  const deepCopy = () => JSON.parse(JSON.stringify(artifact("shadow-verification-report.json")));

  it("accepts the current saved report's bias decision and typography fixture", () => {
    const report = deepCopy();
    expect(report.biasDecision.defaultReceiverGain).toBeGreaterThan(0);
    expect(report.biasDecision.grazingReceiverGain).toBeGreaterThan(0);
    expect(shadowAssertionFailures(report, "saved")).toEqual([]);
  });

  it("rejects a bias decision with no default-light benefit", () => {
    const report = deepCopy();
    report.biasDecision.defaultReceiverGain = 0;
    expect(shadowAssertionFailures(report, "saved").join("\n")).toContain(
      "does not add default-light receiver shadow pixels",
    );
  });

  it("rejects a bias decision with no grazing-light benefit", () => {
    const report = deepCopy();
    report.biasDecision.grazingReceiverGain = -1;
    expect(shadowAssertionFailures(report, "saved").join("\n")).toContain(
      "does not add grazing-light receiver shadow pixels",
    );
  });

  it("rejects a side roundedRect change above the tolerance", () => {
    const report = deepCopy();
    report.biasDecision.sidePanelTolerance = 2;
    report.biasDecision.sidePanelReceiverChanged = 3;
    expect(shadowAssertionFailures(report, "saved").join("\n")).toContain(
      "side roundedRect receiver change 3 > tolerance 2",
    );
  });

  it("rejects a missing biasDecision", () => {
    const report = deepCopy();
    delete report.biasDecision;
    expect(shadowAssertionFailures(report, "saved").join("\n")).toContain("missing biasDecision");
  });

  it("rejects Playground typography drift (font weight)", () => {
    const report = deepCopy();
    report.fixture.typography.fontWeight = "700";
    expect(shadowAssertionFailures(report, "saved").join("\n")).toContain(
      "fixture fontWeight 700 != 800",
    );
  });

  it("rejects a mask that is not exactly 2x the logical box", () => {
    const report = deepCopy();
    report.fixture.mask.logical = [report.fixture.mask.width, report.fixture.mask.height];
    expect(shadowAssertionFailures(report, "saved").join("\n")).toContain("is not exactly 2x the logical box");
  });

  it("rejects a missing computed typography fixture", () => {
    const report = deepCopy();
    delete report.fixture.typography;
    expect(shadowAssertionFailures(report, "saved").join("\n")).toContain("missing fixture.typography");
  });
});
