#!/usr/bin/env node
// Build the Issue #48 before/after report from two complete #46 browser
// benchmark documents.  All measurements and metadata are copied from the
// artifacts; this script never accepts timing values on the command line.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(scriptDir, "..");
const repoRoot = resolve(pkgRoot, "..", "..");

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const beforePath = resolve(flag("--before", join(pkgRoot, "benchmark-results-issue-48-before.json")));
const afterPath = resolve(flag("--after", join(pkgRoot, "benchmark-results-issue-48-after.json")));
const artifactCommit = flag("--artifact-commit", "pending-artifact-commit");

const outputBefore = join(pkgRoot, "benchmark-results-issue-48-before.json");
const outputAfter = join(pkgRoot, "benchmark-results-issue-48-after.json");
const outputCompact = join(pkgRoot, "benchmark-results-issue-48.json");
const outputReport = join(repoRoot, "ISSUE_48_PERFORMANCE_REPORT.md");

const REQUIRED_CASES = Object.freeze([
  "stage/shadow",
  "stage/frame-total",
  "shadow/samples-8/radius-0.15",
  "shadow/travel-short",
  "shadow/travel-medium",
  "shadow/travel-long",
  "shadow/worst/dense-caster",
  "shadow/worst/near-blocker",
  "shadow/worst/max-height-fast-exit",
  "shadow/worst/dense-overlap",
]);

const WORST_CASES = new Set([
  "shadow/worst/dense-caster",
  "shadow/worst/near-blocker",
  "shadow/worst/max-height-fast-exit",
  "shadow/worst/dense-overlap",
]);

function fail(message) {
  throw new Error(`issue-48 report: ${message}`);
}

async function readJson(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    fail(`cannot read ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`invalid JSON in ${path}: ${error.message}`);
  }
}

function assertDocument(doc, label) {
  if (doc === null || typeof doc !== "object") fail(`${label} is not an object`);
  if (doc.schemaVersion !== 1) fail(`${label}.schemaVersion must be 1`);
  if (typeof doc.commit !== "string" || doc.commit.length < 7) fail(`${label}.commit is missing`);
  if (doc.workingTreeDirty !== false) fail(`${label}.workingTreeDirty must be false`);
  if (doc.environment?.timestampQuerySupported !== true) {
    fail(`${label}.environment.timestampQuerySupported must be true`);
  }
  if (!Array.isArray(doc.cases) || doc.cases.length === 0) fail(`${label}.cases is empty`);
}

function byId(doc) {
  const map = new Map(doc.cases.map((entry) => [entry.id, entry]));
  if (map.size !== doc.cases.length) fail("benchmark case IDs are not unique");
  return map;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function sameParameters(a, b, id) {
  const left = JSON.stringify(stable(a.parameters ?? {}));
  const right = JSON.stringify(stable(b.parameters ?? {}));
  if (left !== right) fail(`${id} parameters differ between before/after artifacts`);
}

function summary(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") fail("timing metric is not a summary object");
  const out = {};
  for (const key of ["samples", "median", "p95", "min", "max"]) {
    out[key] = value[key] ?? null;
  }
  return out;
}

function round(value, digits = 3) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function delta(before, after) {
  const a = before?.median;
  const b = after?.median;
  if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || a === 0) return null;
  return {
    milliseconds: round(b - a, 6),
    percent: round(((b - a) / a) * 100, 3),
    regression: b > a,
  };
}

function metricFor(entry, id) {
  const metrics = entry.metrics ?? {};
  const isShadowCase = id === "stage/shadow" || id.startsWith("shadow/");
  const shadowGpu = id === "stage/shadow" ? metrics.gpuTimestampMs : metrics.shadowGpuTimestampMs;
  const frameGpu = id === "stage/frame-total" || id.startsWith("shadow/") ? metrics.gpuTimestampMs : null;
  const timing = {
    wallMs: summary(metrics.wallMs),
    hostMs: summary(metrics.hostMs),
    shadowHostMs: summary(metrics.shadowHostMs),
    shadowGpuTimestampMs: summary(shadowGpu),
    frameGpuTimestampMs: summary(frameGpu),
  };
  const workload = isShadowCase
    ? {
        shadowSteps: metrics.shadowSteps ?? null,
        shadowSampleCount: metrics.shadowSampleCount ?? metrics.effectiveSamples ?? null,
        shadowAngularRadius: metrics.shadowAngularRadius ?? entry.parameters?.angularRadius ?? null,
        renderExtent: metrics.renderExtent ?? null,
        texels: metrics.texels ?? null,
        rayBoundSearch: metrics.rayBoundSearch ?? null,
        rayBoundSearchIterationUpperBound: metrics.rayBoundSearchIterationUpperBound ?? null,
        casterAabbCulling: metrics.casterAabbCulling ?? null,
        casterAabbPadTexels: metrics.casterAabbPadTexels ?? null,
        casterAabb: metrics.casterAabb ?? null,
        frameLogicalArea: metrics.frameLogicalArea ?? null,
        unionCasterAabbArea: metrics.unionCasterAabbArea ?? null,
        casterAabbCoverageRatio: metrics.casterAabbCoverageRatio ?? null,
      }
    : null;
  const resources = {
    submissions: metrics.submissions ?? null,
    dispatches: metrics.dispatches ?? null,
    bytesUploaded: metrics.bytesUploaded ?? null,
    newAllocations: metrics.newAllocations ?? null,
    extraShadowPasses: metrics.extraShadowPasses ?? null,
    extraShadowDispatches: metrics.extraShadowDispatches ?? null,
    extraShadowUploads: metrics.extraShadowUploads ?? null,
    extraShadowStorageBytes: metrics.extraShadowStorageBytes ?? null,
  };
  return {
    warmups: entry.parameters?.warmups ?? null,
    samples: entry.parameters?.samples ?? null,
    timing,
    workload,
    resources,
  };
}

function pairCase(beforeEntry, afterEntry) {
  const id = afterEntry.id;
  sameParameters(beforeEntry, afterEntry, id);
  const before = metricFor(beforeEntry, id);
  const after = metricFor(afterEntry, id);
  return {
    id,
    parameters: afterEntry.parameters,
    before,
    after,
    delta: {
      shadowGpuTimestampMs: delta(before.timing.shadowGpuTimestampMs, after.timing.shadowGpuTimestampMs),
      frameGpuTimestampMs: delta(before.timing.frameGpuTimestampMs, after.timing.frameGpuTimestampMs),
      wallMs: delta(before.timing.wallMs, after.timing.wallMs),
      hostMs: delta(before.timing.hostMs, after.timing.hostMs),
    },
  };
}

function formatNumber(value, digits = 3) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function formatTiming(timing) {
  if (timing === null) return "n/a";
  return `${formatNumber(timing.median)} / ${formatNumber(timing.p95)}`;
}

function formatTimingDetailed(timing, warmups, samples) {
  if (timing === null) return "n/a";
  return `${formatNumber(timing.median)}/${formatNumber(timing.p95)}/${formatNumber(timing.min)}/${formatNumber(timing.max)} ms (n=${timing.samples ?? samples ?? "n/a"}, w=${warmups ?? "n/a"})`;
}

function formatDelta(entry) {
  const value = entry?.percent;
  return typeof value === "number" ? `${value >= 0 ? "+" : ""}${value.toFixed(1)}%` : "n/a";
}

function markdown(compact) {
  const env = compact.environment.optimized;
  const conditions = compact.conditions;
  const rows = compact.cases.filter((entry) => REQUIRED_CASES.includes(entry.id));
  const regressionShadow = compact.regressions.shadowGpuTimestampMs;
  const regressionFrame = compact.regressions.frameGpuTimestampMs;
  const lines = [
    "# Issue #48 ShadowPass ray-march optimization",
    "",
    "このレポートは、同一条件の clean な #46 実機WebGPUベンチマーク2本から機械生成したものです。数値は手入力していません。",
    "",
    "## Provenance",
    "",
    `- Baseline commit: \`${compact.baselineCommit}\` (workingTreeDirty=${compact.provenance.baselineWorkingTreeDirty})`,
    `- Optimized commit: \`${compact.optimizedCommit}\` (workingTreeDirty=${compact.provenance.optimizedWorkingTreeDirty})`,
    `- Benchmark artifact commit: \`${compact.benchmarkArtifactCommit}\``,
    `- Adapter: ${env.adapterVendor ?? "unknown"} / ${env.adapterArchitecture ?? "unknown"} / backend ${env.adapterBackend ?? "unknown"}`,
    `- Browser: ${env.browser ?? "unknown"} ${env.browserVersion ?? "unknown"}; timestamp-query=${env.timestampQuerySupported}`,
    "",
    "## Conditions and resource contract",
    "",
    `- Resolution ${conditions.resolution}, DPR ${conditions.dpr}, warmups ${conditions.warmups}, timed samples ${conditions.samples}.`,
    `- Shadow options: stepSize ${conditions.stepSize}, bias ${conditions.bias}; GPU timestamps are kept separate from host/wall timing.`,
    `- Algorithm: ${compact.algorithm.optimized}; no extra ShadowPass passes/dispatches/uploads/storage (${JSON.stringify(compact.resourceContract)}).`,
    "",
    "## Measured GPU timings",
    "",
    "Values are `median / p95` milliseconds; Δ is after vs before (negative is faster). The frame column is the full submitted frame where available.",
    "",
    "| Case | Shadow before → after | Δ | Frame before → after | Δ |",
    "|---|---:|---:|---:|---:|",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.id} | ${formatTiming(row.before.timing.shadowGpuTimestampMs)} → ${formatTiming(row.after.timing.shadowGpuTimestampMs)} | ${formatDelta(row.delta.shadowGpuTimestampMs)} | ${formatTiming(row.before.timing.frameGpuTimestampMs)} → ${formatTiming(row.after.timing.frameGpuTimestampMs)} | ${formatDelta(row.delta.frameGpuTimestampMs)} |`,
    );
  }
  lines.push(
    "",
    "## Worst-case workload metadata",
    "",
    "AABB coverage is `clamp(unionCasterAabbArea / frameLogicalArea, 0, 1)`. Both artifacts retain min/max/samples/warmups and all resource counters in the compact JSON and full JSON files.",
    "",
    "| Scenario | Samples / angular radius | Steps | AABB coverage | Before search | After search |",
    "|---|---:|---:|---:|---|---|",
  );
  for (const row of rows.filter((entry) => WORST_CASES.has(entry.id))) {
    const b = row.before.workload;
    const a = row.after.workload;
    lines.push(
      `| ${row.parameters.scenario} (${row.parameters.scene}) | ${row.parameters.shadowSamples} / ${formatNumber(row.parameters.angularRadius, 3)} | ${row.parameters.maxDistance} / ${row.parameters.stepSize} (${a.shadowSteps}) | ${formatNumber(a.casterAabbCoverageRatio, 4)} | ${b.rayBoundSearch ?? "n/a"} | ${a.rayBoundSearch ?? "n/a"} (${a.rayBoundSearchIterationUpperBound ?? "n/a"} iters) |`,
    );
  }
  lines.push(
    "",
    "### Worst-case complete timing summaries",
    "",
    "Each cell is `median / p95 / min / max ms (n=samples, w=warmups)`; these are the raw timestamp summaries used for the deltas above.",
    "",
    "| Scenario | Shadow before | Shadow after | Frame before | Frame after | Extra resources (after) |",
    "|---|---:|---:|---:|---:|---|",
  );
  for (const row of rows.filter((entry) => WORST_CASES.has(entry.id))) {
    const extra = row.after.resources;
    lines.push(
      `| ${row.parameters.scenario} | ${formatTimingDetailed(row.before.timing.shadowGpuTimestampMs, row.before.warmups, row.before.samples)} | ${formatTimingDetailed(row.after.timing.shadowGpuTimestampMs, row.after.warmups, row.after.samples)} | ${formatTimingDetailed(row.before.timing.frameGpuTimestampMs, row.before.warmups, row.before.samples)} | ${formatTimingDetailed(row.after.timing.frameGpuTimestampMs, row.after.warmups, row.after.samples)} | passes=${extra.extraShadowPasses}, dispatches=${extra.extraShadowDispatches}, uploads=${extra.extraShadowUploads}, storageBytes=${extra.extraShadowStorageBytes} |`,
    );
  }
  lines.push("", "## Regression accounting", "");
  if (regressionShadow.length === 0 && regressionFrame.length === 0) {
    lines.push("- No median ShadowPass or frame-total regressions were observed in the captured cases.");
  } else {
    lines.push(
      `- Median ShadowPass regressions (reported, not hidden): ${regressionShadow.length > 0 ? regressionShadow.map((entry) => `${entry.id} ${formatDelta(entry.delta)}`).join(", ") : "none"}.`,
      `- Median frame-total regressions (reported, not hidden): ${regressionFrame.length > 0 ? regressionFrame.map((entry) => `${entry.id} ${formatDelta(entry.delta)}`).join(", ") : "none"}.`,
      "- These cases remain in the comparison so the optimization is not presented as universally faster.",
    );
  }
  lines.push(
    "",
    "## Correctness gate",
    "",
    "- The real-WebGPU parity runner executes the explicit #48 adversarial fixture set (thin caster/AABB edge, bilinear support boundary, last valid step, negative-threshold cull guard, dense full-frame hard and soft) and fails on missing IDs, execution errors, or mismatches.",
    "- CPU oracle semantics remain unchanged; the checked-in parity run and unit/build/typecheck results are reported alongside this artifact in the task handoff.",
    "- Issue #48 は閉じていません。merge/close 判定は行っていません。",
    "",
    `Generated from: [before artifact](packages/renderer/benchmark-results-issue-48-before.json), [after artifact](packages/renderer/benchmark-results-issue-48-after.json), [compact summary](packages/renderer/benchmark-results-issue-48.json).`,
    "",
  );
  return lines.join("\n");
}

async function main() {
  const beforeDoc = await readJson(beforePath);
  const afterDoc = await readJson(afterPath);
  assertDocument(beforeDoc, "before");
  assertDocument(afterDoc, "after");
  if (beforeDoc.commit === afterDoc.commit) fail("baseline and optimized commits must differ");
  if (afterDoc.environment.devicePixelRatio !== 1 || beforeDoc.environment.devicePixelRatio !== 1) {
    fail("both artifacts must use DPR 1");
  }
  const beforeCases = byId(beforeDoc);
  const afterCases = byId(afterDoc);
  if (beforeCases.size !== afterCases.size) fail("before/after case counts differ");
  for (const id of beforeCases.keys()) {
    if (!afterCases.has(id)) fail(`after artifact is missing ${id}`);
  }
  for (const id of REQUIRED_CASES) {
    if (!beforeCases.has(id)) fail(`before artifact is missing required case ${id}`);
    if (!afterCases.has(id)) fail(`after artifact is missing required case ${id}`);
  }
  const cases = [...afterCases.keys()].map((id) => pairCase(beforeCases.get(id), afterCases.get(id)));
  const selectedAfter = afterCases.get("stage/shadow");
  const selectedParameters = selectedAfter?.parameters ?? {};
  const conditions = {
    resolution: selectedParameters.resolution ?? "640x360",
    dpr: afterDoc.environment.devicePixelRatio,
    warmups: selectedParameters.warmups ?? null,
    samples: selectedParameters.samples ?? null,
    stepSize: cases.find((entry) => entry.id === "shadow/travel-short")?.parameters.stepSize ?? null,
    bias: cases.find((entry) => entry.id === "shadow/worst/dense-caster")?.parameters.bias ?? null,
  };
  if (conditions.resolution !== "640x360" || conditions.warmups !== 5 || conditions.samples !== 20) {
    fail(`unexpected benchmark conditions: ${JSON.stringify(conditions)}`);
  }
  const optimizedShadow = cases.find((entry) => entry.id === "stage/shadow")?.after.workload;
  const baselineAlgorithm = beforeCases.get("stage/shadow")?.metrics?.shadowMarchAlgorithm;
  const optimizedAlgorithm = afterCases.get("stage/shadow")?.metrics?.shadowMarchAlgorithm;
  if (baselineAlgorithm !== "baseline-ray-march") {
    fail(`baseline artifact does not identify the baseline marcher (${baselineAlgorithm})`);
  }
  if (optimizedAlgorithm !== "ray-bound-prefix-binary-search+caster-aabb-empty-space") {
    fail(`optimized artifact does not identify the #48 algorithm (${optimizedAlgorithm})`);
  }
  const extraKeys = [
    "extraShadowPasses",
    "extraShadowDispatches",
    "extraShadowUploads",
    "extraShadowStorageBytes",
  ];
  const shadowCases = cases.filter((candidate) => candidate.id.startsWith("shadow/") || candidate.id === "stage/shadow");
  for (const entry of shadowCases) {
    for (const key of extraKeys) {
      const value = entry.after.resources[key];
      if (value !== 0) {
        fail(`${entry.id} reports ${key}=${value}; expected the no-extra-resource contract`);
      }
    }
  }
  const resourceContract = Object.fromEntries(
    extraKeys.map((key) => [key, Math.max(...shadowCases.map((entry) => entry.after.resources[key]))]),
  );
  const regressions = {
    shadowGpuTimestampMs: cases
      .filter((entry) => entry.delta.shadowGpuTimestampMs?.regression === true)
      .map((entry) => ({ id: entry.id, delta: entry.delta.shadowGpuTimestampMs })),
    frameGpuTimestampMs: cases
      .filter((entry) => entry.delta.frameGpuTimestampMs?.regression === true)
      .map((entry) => ({ id: entry.id, delta: entry.delta.frameGpuTimestampMs })),
  };
  const compact = {
    schemaVersion: 1,
    issue: 48,
    generatedAt: afterDoc.generatedAt,
    baselineCommit: beforeDoc.commit,
    optimizedCommit: afterDoc.commit,
    benchmarkArtifactCommit: artifactCommit,
    provenance: {
      baselineWorkingTreeDirty: beforeDoc.workingTreeDirty,
      optimizedWorkingTreeDirty: afterDoc.workingTreeDirty,
      baselineGeneratedAt: beforeDoc.generatedAt,
      optimizedGeneratedAt: afterDoc.generatedAt,
    },
    environment: {
      baseline: beforeDoc.environment,
      optimized: afterDoc.environment,
    },
    conditions,
    algorithm: {
      baseline: baselineAlgorithm,
      optimized: optimizedAlgorithm,
      optimizedRayBoundSearch: optimizedShadow?.rayBoundSearch ?? null,
    },
    resourceContract,
    cases,
    regressions,
  };
  await writeFile(outputBefore, `${JSON.stringify(beforeDoc, null, 2)}\n`, "utf8");
  await writeFile(outputAfter, `${JSON.stringify(afterDoc, null, 2)}\n`, "utf8");
  await writeFile(outputCompact, `${JSON.stringify(compact, null, 2)}\n`, "utf8");
  await writeFile(outputReport, markdown(compact), "utf8");
  console.log(`issue-48 report: wrote ${outputBefore}`);
  console.log(`issue-48 report: wrote ${outputAfter}`);
  console.log(`issue-48 report: wrote ${outputCompact}`);
  console.log(`issue-48 report: wrote ${outputReport}`);
  console.log(`issue-48 report: ${cases.length} paired cases; shadow regressions=${regressions.shadowGpuTimestampMs.length}; frame regressions=${regressions.frameGpuTimestampMs.length}`);
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
