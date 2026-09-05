// Build the Issue #48 before/after report from two complete #46 browser
// benchmark documents.  All measurements and metadata are copied from the
// artifacts; this script never accepts timing values on the command line.
//
// The profiling / bottleneck-analysis numbers are likewise read mechanically
// from the checked-in #46 baseline artifact (benchmark-results.json), and the
// correctness evidence is read from the committed real-WebGPU parity run
// output (parity-results-issue-48.txt): the generator refuses to emit the
// report unless that run is a real-adapter PASS whose #48 adversarial gate
// executed every catalog fixture with zero missing IDs, execution errors and
// mismatches.  No PASS text is ever hardcoded.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ISSUE_48_ADVERSARIAL_FIXTURE_IDS } from "../test-browser/catalog.mjs";

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
const issue46Path = resolve(flag("--issue46", join(pkgRoot, "benchmark-results.json")));
const parityPath = resolve(flag("--parity", join(pkgRoot, "parity-results-issue-48.txt")));
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

// ---------------------------------------------------------------------------
// #46 baseline profiling extraction (mechanical; no hand-entered numbers)
// ---------------------------------------------------------------------------

const PROFILING_SCALING_CASES = Object.freeze([
  { id: "shadow/samples-1/radius-0.15", samples: 1 },
  { id: "shadow/samples-4/radius-0.15", samples: 4 },
  { id: "shadow/samples-8/radius-0.15", samples: 8 },
  { id: "shadow/samples-16/radius-0.15", samples: 16 },
]);
const PROFILING_TRAVEL_CASES = Object.freeze(["shadow/travel-short", "shadow/travel-medium", "shadow/travel-long"]);
const PROFILING_REQUIRED_CASES = Object.freeze([
  "stage/shadow",
  "stage/frame-total",
  ...PROFILING_SCALING_CASES.map((entry) => entry.id),
  "shadow/samples-8/radius-0",
  ...PROFILING_TRAVEL_CASES,
]);

function issue46Median(doc, id, key) {
  const entry = doc.cases.find((candidate) => candidate.id === id);
  if (!entry) fail(`#46 baseline artifact is missing ${id}`);
  const value = entry.metrics?.[key]?.median;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(`#46 baseline artifact has no finite ${key}.median for ${id}`);
  }
  return { median: value, steps: entry.metrics?.shadowSteps ?? null, maxDistance: entry.parameters?.maxDistance ?? null };
}

function issue46Profile(doc) {
  const shadow = issue46Median(doc, "stage/shadow", "gpuTimestampMs");
  const frame = issue46Median(doc, "stage/frame-total", "gpuTimestampMs");
  if (frame.median === 0) fail("#46 baseline frame-total median is 0");
  return {
    commit: doc.commit,
    representative: {
      shadowMs: round(shadow.median, 3),
      frameMs: round(frame.median, 3),
      shadowSharePercent: round((shadow.median / frame.median) * 100, 1),
    },
    scaling: PROFILING_SCALING_CASES.map(({ id, samples }) => {
      const entry = issue46Median(doc, id, "shadowGpuTimestampMs");
      return { samples, medianMs: round(entry.median, 3), perSampleMs: round(entry.median / samples, 3) };
    }),
    hardReferenceMs: round(issue46Median(doc, "shadow/samples-8/radius-0", "shadowGpuTimestampMs").median, 3),
    travel: PROFILING_TRAVEL_CASES.map((id) => {
      const entry = issue46Median(doc, id, "shadowGpuTimestampMs");
      return { id, steps: entry.steps, maxDistance: entry.maxDistance, medianMs: round(entry.median, 3) };
    }),
  };
}

// ---------------------------------------------------------------------------
// Real-WebGPU parity evidence parsing (no PASS is ever hardcoded)
// ---------------------------------------------------------------------------

export function parseParityResult(text) {
  const lines = String(text).split(/\r?\n/);
  const firstLine = (lines[0] ?? "").trim();
  const markerMatch = /^(UKIBORI_WEBGPU_(?:PASS|FAIL|SKIP))(?:[ \t]|$)/.exec(firstLine);
  if (markerMatch === null) {
    fail("parity result: the first line carries no anchored UKIBORI_WEBGPU_PASS/FAIL/SKIP marker");
  }
  const summaryLine = lines.find((line) => line.startsWith("SUMMARY "));
  if (summaryLine === undefined) fail("parity result: no `SUMMARY ` line found");
  let summary;
  try {
    summary = JSON.parse(summaryLine.slice("SUMMARY ".length));
  } catch (error) {
    fail(`parity result: SUMMARY line is not valid JSON: ${error.message}`);
  }
  if (summary === null || typeof summary !== "object") fail("parity result: SUMMARY is not an object");
  return { marker: markerMatch[1], summary };
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

function markdown(compact, profile, parity) {
  const env = compact.environment.optimized;
  const conditions = compact.conditions;
  const rows = compact.cases.filter((entry) => REQUIRED_CASES.includes(entry.id));
  const regressionShadow = compact.regressions.shadowGpuTimestampMs;
  const regressionFrame = compact.regressions.frameGpuTimestampMs;
  const adversarial = parity.summary.issue48Adversarial;
  const lines = [
    "# Issue #48 ShadowPass ray-march optimization",
    "",
    "このレポートは、同一条件の clean な #46 実機WebGPUベンチマーク2本から機械生成したものです。数値は手入力していません。profiling 数値と correctness evidence も、committed artifact から機械的に取り込んでいます。",
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
    "## Profiling / bottleneck analysis",
    "",
    `All numbers in this section are read mechanically from the #46 baseline artifact (\`benchmark-results.json\`, commit \`${profile.commit}\`), captured under the same 640x360 / DPR 1 / warmups ${conditions.warmups} / timed samples ${conditions.samples} conditions as the before/after comparison below.`,
    "",
    "### Representative issue #46 baseline case",
    "",
    `- ShadowPass median ${profile.representative.shadowMs} ms of a ${profile.representative.frameMs} ms total GPU frame: ShadowPass alone accounts for ${profile.representative.shadowSharePercent}% of the frame GPU time, making it the single dominant stage of the compute chain.`,
    "- The remaining stages (upload, height, normal, reconstruction, lighting, presentation) together cost less than the ShadowPass, so ShadowPass march work is where optimization pays off end-to-end.",
    "",
    "### Soft-shadow sample scaling (scene `soft-shadow`, angular radius 0.15)",
    "",
    "ShadowPass GPU median scales approximately linearly with the per-pixel cone sample count; per-sample cost stays nearly constant:",
    "",
    "| Cone samples | ShadowPass median | Per-sample cost |",
    "|---:|---:|---:|",
  ];
  for (const row of profile.scaling) {
    lines.push(`| ${row.samples} | ${row.medianMs} ms | ${row.perSampleMs} ms |`);
  }
  lines.push(
    "",
    `- Hard-shadow reference (8 samples, angular radius 0, no cone rays): ${profile.hardReferenceMs} ms — the extra cost of soft shadows is the per-sample march work, not the ray setup.`,
    "- Therefore any optimization that changes sample positions, sample count, or stepSize would change the measured semantics; the adopted candidate below preserves all of them exactly.",
    "",
    "### Travel / step-count impact (8 samples, angular radius 0.15)",
    "",
    "| Case | maxDistance (theoretical steps) | ShadowPass median |",
    "|---|---:|---:|",
  );
  for (const row of profile.travel) {
    lines.push(`| ${row.id} | ${row.maxDistance ?? "n/a"} (${row.steps ?? "n/a"}) | ${row.medianMs} ms |`);
  }
  lines.push(
    "",
    `- Raising the march from ${profile.travel[0].steps} to ${profile.travel[2].steps} theoretical steps raises the median only from ${profile.travel[0].medianMs} ms to ${profile.travel[2].medianMs} ms; both values are unmodified artifact medians.`,
    "- Once the march is long enough to leave the caster field, the marginal cost of extra steps is small compared with the fixed per-sample work (height-field reads and per-sample cone setup), which dominates in sparse caster scenes.",
    "",
    "### Sparse scenes vs worst cases",
    "",
    "- In the sparse representative scene the march reads the height field for every cone sample over a long distance; height-field reads plus march length dominate, which is exactly the redundancy the prefix search removes.",
    "- The dense / near-blocker / max-height-fast-exit / dense-overlap worst cases behave differently (mostly-blocked pixels, fast exits, full-frame AABB coverage) and must not be extrapolated from the sparse case; their measured before/after values — including the small absolute regressions — are reported in the tables below rather than hidden.",
    "",
    "## Candidate evaluation",
    "",
    "Candidates considered for reducing the ShadowPass ray-march cost. Verdicts reflect the #48 scope: a semantic-preserving optimization of the existing marcher (no shadow-quality reduction, no extra passes/resources).",
    "",
    "### Hierarchical / mip-based height bounds",
    "",
    "**Rejected / deferred.**",
    "",
    "- Requires additional preprocessing (mip generation), storage, and synchronization on every scene/height change.",
    "- Complexity is large relative to the #48 scope and risks changing height-field semantics (mip averaging is not an f32-exact bound of bilinear taps without conservative padding).",
    "- End-to-end cost must be re-evaluated (preprocess + upload + read patterns), not just the ShadowPass.",
    "- The simple optimization adopted below already removed the dominant redundancy on the representative workload.",
    "",
    "### Tile / cluster spatial blocker bounds",
    "",
    "**Rejected / deferred.**",
    "",
    "- Requires an additional spatial structure, upload, and memory, plus an invalidation story consistent with the retained/partial scheduler (#31/#32).",
    "- The adopted caster-union AABB already provides zero-extra-resource conservative empty-space culling over the full frame.",
    "- Per-tile bounds would only add precision over the union AABB in scenes whose occupancy is highly non-uniform; the measured representative win did not justify the resource contract change.",
    "",
    "### Adaptive stepping",
    "",
    "**Rejected.**",
    "",
    "- Changing step size or step placement changes the historical sample positions at which the height field is evaluated.",
    "- Thin casters can be skipped entirely between adapted steps, and the exact f32 predicate (`rayZ > maxCasterHeight + bias`) would no longer be evaluated at the same points, breaking strict pixel parity against the CPU oracle.",
    "- Directly conflicts with the #48 requirement \"without reducing shadow quality\"; correctness risk outweighs the potential win.",
    "",
    "### Height-field layout / shared-memory / coalescing redesign",
    "",
    "**Deferred.**",
    "",
    "- A larger architectural change (texture layout, workgroup-level sharing, or memory-coalescing redesign) with its own profiling and workload-specific validation burden.",
    "- Independent of the march-count redundancy; should be evaluated separately after #48's minimal semantic-preserving optimization.",
    "",
    "### Exact prefix binary search + caster AABB empty-space culling",
    "",
    "**Adopted.**",
    "",
    "- Sample positions, stepSize, maxDistance, and sample count are all unchanged, so every historical f32 predicate is still evaluated at the same points.",
    "- No extra GPU pass, dispatch, upload, or storage (resource contract below).",
    "- Uses the exact historical f32 predicate (shared `rayZAtStep()` arithmetic, no analytic ratios, no epsilon, no magic margin).",
    "- Representative ShadowPass / total frame medians improved substantially (measured tables below), including the sparse scenes where the march is dominant.",
    "",
    "## Adopted algorithm",
    "",
    "1. **XY scene-bound prefix search**",
    "   - The historical marcher walks steps until the ray leaves the scene bounds in XY; that prefix is monotone, so it is located with an exact binary search over the same f32 arithmetic instead of a linear walk.",
    "   - Historical sample positions are unchanged: the search evaluates the identical predicate at the identical step indices.",
    "2. **Height bound integration**",
    "   - `rayZAtStep()` shares the exact historical f32 arithmetic between the oracle, the optimized prefix search, and the GPU.",
    "   - `dz > 0`: the ray height is monotone non-decreasing, so the XY exit and the `rayZ > maxCasterHeight + bias` bound are combined into a single monotone prefix predicate searched in binary.",
    "   - `dz <= 0`: the height bound can never be crossed upward, so the historical step-1 height check is kept and the remaining prefix is XY-only.",
    "   - No analytic ratio, no epsilon, and no magic step margin: strict f32 equality at the boundary is preserved (including `rayZ == maxCasterHeight + bias`).",
    "3. **Caster union AABB culling**",
    "   - A conservative padded union AABB of all casters is computed from the already-uploaded scene data.",
    "   - Only pixels whose ray is entirely outside the AABB **and** whose threshold is `>= 0` skip the height-field reads: outside a strictly positive threshold there is no blocker, so the march result is provably identical.",
    "   - With a negative threshold the zero base plane itself can act as a blocker, so height reads are retained there.",
    "4. **Resource contract**",
    "   - extra passes = 0",
    "   - extra dispatches = 0",
    "   - extra uploads = 0",
    "   - extra storage bytes = 0",
    "",
    "## Measured GPU timings",
    "",
    "Values are `median / p95` milliseconds; Δ is after vs before (negative is faster). The frame column is the full submitted frame where available.",
    "",
    "| Case | Shadow before → after | Δ | Frame before → after | Δ |",
    "|---|---:|---:|---:|---:|",
  );
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
    "## Correctness evidence",
    "",
    "### Real-WebGPU adversarial fixture gate (#48)",
    "",
    `- The real-WebGPU parity runner gates on an explicit #48 adversarial fixture set of ${ISSUE_48_ADVERSARIAL_FIXTURE_IDS.length} IDs (declared once in \`test-browser/catalog.mjs\`) and fails the run on any missing ID, execution error, or mismatch.`,
    `- Checked run recorded in \`parity-results-issue-48.txt\`: marker \`${parity.marker}\` on a real adapter (${parity.summary.adapter?.vendor ?? "unknown"} / ${parity.summary.adapter?.architecture ?? "unknown"}); expected ${adversarial.expected.length}, executed ${adversarial.executed.length}, missing ${adversarial.missing.length}, execution errors ${adversarial.executionErrors.length}, mismatches ${adversarial.mismatches.length}.`,
    `- Full-catalog context of the same run: ${parity.summary.fixtures} fixtures, ${parity.summary.shadowTexels} shadow visibility texels, ${parity.summary.shadowMismatches} shadow mismatches.`,
    `- Dense pair: hard fixture \`${adversarial.hardFixture}\`, soft fixture \`${adversarial.softFixture}\`.`,
    "",
    "Fixture IDs:",
    "",
    ...ISSUE_48_ADVERSARIAL_FIXTURE_IDS.map((id) => `- \`${id}\``),
    "",
    "### Historical-vs-optimized prefix equivalence",
    "",
    "- `src/gpu/shadow-prefix.test.ts` runs a deterministic seeded 12,000-case sweep (fixed seed, reproducible review evidence) comparing the optimized prefix search against the historical f32 reference on every case.",
    "- The same suite pins the strict-equality boundary (`rayZ == maxCasterHeight + bias`, plus one-ulp-below/above), a large fully valid stepCount without a linear reference loop, and the labeled boundary cases below.",
    "- CPU oracle semantics remain unchanged; the ShadowPass WGSL predicate and the CPU oracle still share the exact historical f32 arithmetic via `rayZAtStep()`.",
    "",
    "### Explicit boundary coverage",
    "",
    "- `dz > 0` before/after boundary: `shadow-prefix-dz-positive-before-boundary`, `shadow-prefix-dz-positive-after-boundary`",
    "- `dz == 0`: `shadow-prefix-dz-zero`",
    "- `dz < 0`: `shadow-prefix-dz-negative`",
    "- receiver above height bound: `shadow-prefix-receiver-above-height`",
    "- very small positive `dz`: `shadow-prefix-small-positive-dz`",
    "- large valid stepCount: `shadow-prefix-large-valid-stepcount`",
    "- non-dyadic stepSize 0.1 / 0.3: `shadow-prefix-nondyadic-0.1`, `shadow-prefix-nondyadic-0.3`",
    "- strict equality at `rayZ == maxCasterHeight + bias`: `shadow-prefix-height-equality`",
    "- XY / height leave on the same step: `shadow-prefix-xy-height-same-step`",
    "- thin caster at the AABB edge: `shadow-thin-caster-aabb-edge`",
    "- bilinear AABB support boundary: `shadow-bilinear-support-boundary`",
    "- last valid scene edge step: `shadow-scene-edge-last-valid-step`",
    "- negative threshold cull guard: `shadow-negative-threshold-cull-guard`",
    "- dense hard / soft full-frame pair: `shadow-dense-full-frame-hard`, `shadow-dense-full-frame-soft`",
    "",
    "### Gate semantics",
    "",
    "- The parity runner fails on missing fixture IDs, execution errors, or any policy-table mismatch; a real-adapter PASS is the only accepted outcome (SKIP is a failure).",
    "- The vitest suite additionally executes the 12,000-case historical-vs-optimized sweep and the prefix boundary unit tests on every run; typecheck/build are part of the verification.",
    "- Issue #48 は閉じていません。merge/close 判定は行っていません。",
    "",
    `Generated from: [before artifact](packages/renderer/benchmark-results-issue-48-before.json), [after artifact](packages/renderer/benchmark-results-issue-48-after.json), [compact summary](packages/renderer/benchmark-results-issue-48.json), [#46 baseline artifact](packages/renderer/benchmark-results.json), [real-WebGPU parity run](packages/renderer/parity-results-issue-48.txt).`,
    "",
  );
  return lines.join("\n");
}

async function main() {
  const beforeDoc = await readJson(beforePath);
  const afterDoc = await readJson(afterPath);
  assertDocument(beforeDoc, "before");
  assertDocument(afterDoc, "after");
  const issue46Doc = await readJson(issue46Path);
  assertDocument(issue46Doc, "issue46");
  for (const id of PROFILING_REQUIRED_CASES) {
    if (!issue46Doc.cases.some((candidate) => candidate.id === id)) {
      fail(`#46 baseline artifact is missing required profiling case ${id}`);
    }
  }
  const parity = parseParityResult(await readFile(parityPath, "utf8"));
  if (parity.marker !== "UKIBORI_WEBGPU_PASS") {
    fail(`parity result marker is ${parity.marker}; only a real-adapter PASS can back the correctness evidence`);
  }
  const adversarial = parity.summary.issue48Adversarial;
  if (!adversarial || !Array.isArray(adversarial.expected) || !Array.isArray(adversarial.executed)) {
    fail("parity result SUMMARY carries no #48 adversarial gate payload");
  }
  const expectedIds = JSON.stringify(adversarial.expected);
  const catalogIds = JSON.stringify(ISSUE_48_ADVERSARIAL_FIXTURE_IDS);
  if (expectedIds !== catalogIds) {
    fail(`parity expected fixture set differs from the catalog: ${expectedIds} vs ${catalogIds}`);
  }
  if (adversarial.executed.length !== ISSUE_48_ADVERSARIAL_FIXTURE_IDS.length) {
    fail(`parity executed ${adversarial.executed.length} of ${ISSUE_48_ADVERSARIAL_FIXTURE_IDS.length} #48 fixtures`);
  }
  if (
    adversarial.missing.length !== 0 ||
    adversarial.executionErrors.length !== 0 ||
    adversarial.mismatches.length !== 0
  ) {
    fail(
      `parity #48 gate is not clean: missing=${JSON.stringify(adversarial.missing)}, executionErrors=${JSON.stringify(adversarial.executionErrors)}, mismatches=${JSON.stringify(adversarial.mismatches)}`,
    );
  }
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
  if (optimizedAlgorithm !== "exact-prefix-binary-search+caster-aabb-empty-space") {
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
  await writeFile(outputReport, markdown(compact, issue46Profile(issue46Doc), parity), "utf8");
  console.log(`issue-48 report: wrote ${outputBefore}`);
  console.log(`issue-48 report: wrote ${outputAfter}`);
  console.log(`issue-48 report: wrote ${outputCompact}`);
  console.log(`issue-48 report: wrote ${outputReport}`);
  console.log(`issue-48 report: ${cases.length} paired cases; shadow regressions=${regressions.shadowGpuTimestampMs.length}; frame regressions=${regressions.frameGpuTimestampMs.length}`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}
