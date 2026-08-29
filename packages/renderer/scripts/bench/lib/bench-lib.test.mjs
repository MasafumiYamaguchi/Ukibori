// #46 benchmark-lib unit tests: schema recursive validation + stats median
// contract. These run under vitest with the workspace `*.test.mjs` glob.
import { describe, expect, it } from "vitest";
import { median, summarizeSeries } from "./stats.mjs";
import { createResultDocument, validateResultDocument } from "./schema.mjs";
import { isWorkingTreeDirty } from "./env-node.mjs";
import { detectHeadless } from "./env-browser.mjs";

describe("headless detection", () => {
  it("a HeadlessChrome UA is headless even without the webdriver flag", () => {
    expect(
      detectHeadless({ userAgent: "Mozilla/5.0 (X) AppleWebKit/537.36 HeadlessChrome/151.0.0.0 Safari/537.36", webdriver: false }),
    ).toBe(true);
  });
  it("a regular Chrome UA is headless only via the webdriver flag", () => {
    expect(detectHeadless({ userAgent: "Mozilla/5.0 (X) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36", webdriver: false })).toBe(false);
    expect(detectHeadless({ userAgent: "Mozilla/5.0 (X) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36", webdriver: true })).toBe(true);
  });
});

describe("working-tree provenance", () => {
  it("a clean porcelain output means a clean tree", () => {
    expect(isWorkingTreeDirty({ porcelain: "" })).toBe(false);
    expect(isWorkingTreeDirty({ porcelain: null })).toBe(false);
    expect(isWorkingTreeDirty({ porcelain: "  " })).toBe(false);
  });
  it("any porcelain entry means a dirty tree", () => {
    expect(isWorkingTreeDirty({ porcelain: " M packages/renderer/x.mjs\n" })).toBe(true);
    expect(isWorkingTreeDirty({ porcelain: "?? benchmark-results.json" })).toBe(true);
  });
});

function validDoc(metrics = {}, parameters = {}) {
  return createResultDocument({
    environment: { os: "test" },
    cases: [{ id: "t/case", parameters, metrics }],
  });
}

describe("stats median contract", () => {
  it("odd count returns the middle value", () => {
    expect(median([3, 1, 2])).toBe(2);
  });
  it("even count returns the mean of the two middle values", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it("unsorted input is sorted before selection", () => {
    expect(median([10, 1, 9, 2])).toBe((2 + 9) / 2);
  });
  it("summarizeSeries median delegates to the same definition", () => {
    expect(summarizeSeries([1, 2, 3, 4]).median).toBe(2.5);
    expect(summarizeSeries([1, 2, 3]).median).toBe(2);
  });
  it("summarizeSeries reports samples/p95/min/max", () => {
    const summary = summarizeSeries([1, 2, 3, 4, 5]);
    expect(summary.samples).toBe(5);
    expect(summary.min).toBe(1);
    expect(summary.max).toBe(5);
    expect(summary.p95).toBe(5);
  });
  it("empty series summarizes to nulls", () => {
    const summary = summarizeSeries([]);
    expect(summary.samples).toBe(0);
    expect(summary.median).toBeNull();
    expect(summary.p95).toBeNull();
  });
});

describe("schema recursive validation", () => {
  it("accepts a valid timing summary", () => {
    const doc = validDoc({
      gpuTimestampMs: { samples: 3, median: 0.1, p95: 0.2, min: 0.05, max: 0.3 },
    });
    expect(validateResultDocument(doc)).toEqual([]);
  });
  it("accepts null gpuTimestampMs (explicit unsupported)", () => {
    const doc = validDoc({ gpuTimestampMs: null });
    expect(validateResultDocument(doc)).toEqual([]);
  });
  it("rejects nested median NaN with a path", () => {
    const doc = validDoc({ gpuTimestampMs: { samples: 3, median: NaN, p95: 0.2, min: 0, max: 0.3 } });
    const problems = validateResultDocument(doc);
    expect(problems.some((p) => p.includes("gpuTimestampMs.median") && p.includes("not finite"))).toBe(true);
  });
  it("rejects nested p95 Infinity with a path", () => {
    const doc = validDoc({ gpuTimestampMs: { samples: 3, median: 0.1, p95: Infinity, min: 0, max: 0.3 } });
    const problems = validateResultDocument(doc);
    expect(problems.some((p) => p.includes("gpuTimestampMs.p95") && p.includes("not finite"))).toBe(true);
  });
  it("rejects NaN in an arbitrary nested metric", () => {
    const doc = validDoc({ reconstructionRatio: NaN });
    const problems = validateResultDocument(doc);
    expect(problems.some((p) => p.includes("reconstructionRatio") && p.includes("not finite"))).toBe(true);
  });
  it("rejects Infinity nested inside an array", () => {
    const doc = validDoc({ executedPerFrame: [0, 1, Infinity] });
    const problems = validateResultDocument(doc);
    expect(problems.some((p) => p.includes("executedPerFrame[2]") && p.includes("not finite"))).toBe(true);
  });
  it("rejects a non-canonical timing key name", () => {
    const doc = validDoc({ shadowMs: 0.1 });
    const problems = validateResultDocument(doc);
    expect(problems.some((p) => p.includes("shadowMs") && p.includes("canonical timing suffix"))).toBe(true);
  });
  it("accepts canonical-suffix keys with summary structure", () => {
    const doc = validDoc({
      heightGpuTimestampMs: { samples: 3, median: 0.1, p95: 0.2, min: 0.05, max: 0.3 },
      planningHostMs: { samples: 3, median: 0.01, p95: 0.02, min: 0, max: 0.02 },
    });
    expect(validateResultDocument(doc)).toEqual([]);
  });
  it("accepts the #46 review metric names (uploadWallMs, callbackHostMsPerFrame)", () => {
    const doc = validDoc({
      uploadWallMs: { samples: 20, median: 0.2, p95: 0.3, min: 0.1, max: 0.4 },
      callbackHostMsPerFrame: { samples: 20, median: 0.1, p95: 0.2, min: 0, max: 0.3 },
      settleWallMsPerFrame: { samples: 20, median: 3.0, p95: 4.0, min: 2.0, max: 5.0 },
      measureHostMsPerFrame: { samples: 20, median: 0.05, p95: 0.1, min: 0, max: 0.2 },
      sceneBuildHostMsPerFrame: { samples: 20, median: 0.1, p95: 0.2, min: 0, max: 0.3 },
      shadowGpuTimestampMs: { samples: 20, median: 1.8, p95: 2.0, min: 1.5, max: 2.2 },
      partialToFullRatio: 0.38,
    });
    expect(validateResultDocument(doc)).toEqual([]);
  });
  it("rejects ambiguous timing names that are not canonical suffixes", () => {
    for (const key of ["uploadMs", "settleMs", "measureMs", "sceneMs", "frameMs"]) {
      const doc = validDoc({ [key]: 0.1 });
      const problems = validateResultDocument(doc);
      expect(problems.some((p) => p.includes(key) && p.includes("canonical timing suffix"))).toBe(true);
    }
  });
  it("rejects a timing summary missing required keys", () => {
    const doc = validDoc({ gpuTimestampMs: { samples: 3, median: 0.1 } });
    const problems = validateResultDocument(doc);
    expect(problems.some((p) => p.includes("gpuTimestampMs.p95") && p.includes("missing"))).toBe(true);
  });
  it("rejects non-integer samples count", () => {
    const doc = validDoc({ gpuTimestampMs: { samples: 1.5, median: 0.1, p95: 0.2, min: 0, max: 0.3 } });
    const problems = validateResultDocument(doc);
    expect(problems.some((p) => p.includes("gpuTimestampMs.samples"))).toBe(true);
  });
});