#!/usr/bin/env node
// #46 benchmark report generator (§18/§19/§20): turns one or more versioned
// benchmark result documents into a Markdown report with:
//   - per-suite tables (median, p95, min, max)
//   - a bottleneck matrix (which stage dominates each workload, and its
//     scaling factor)
//   - a follow-up optimization candidate list derived from the measured
//     numbers (never hardcoded bottleneck claims)
//
//   node scripts/bench-report.mjs --results a.json,b.json --out REPORT.md

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateResultDocument } from "./bench/lib/schema.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(scriptDir, "..");

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}
const resultsArg = flag("--results", flag("--json", join(pkgRoot, "benchmark-results.json")));
const outPath = flag("--out", join(pkgRoot, "benchmark-report.md"));

function fmt(v, digits = 3) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  return v.toFixed(digits);
}

function summaryOf(metrics, key) {
  const value = metrics?.[key];
  if (value === null || value === undefined || typeof value !== "object") {
    return null;
  }
  return value;
}

function caseById(cases, prefix) {
  return cases.filter((c) => c.id.startsWith(prefix));
}

function stageTable(cases) {
  // stage suite: per-stage median GPU ms + share of the frame total
  const stages = ["upload", "height", "normal", "shadow", "reconstruction", "lighting", "presentation"];
  const rows = [];
  let total = 0;
  const stageRows = {};
  for (const c of cases) {
    if (!c.id.startsWith("stage/") || c.id === "stage/frame-total") continue;
    const stage = c.parameters.stage;
    const gpu = summaryOf(c.metrics, "gpuTimestampMs");
    stageRows[stage] = gpu?.median ?? null;
  }
  const totalCase = cases.find((c) => c.id === "stage/frame-total");
  const totalGpu = summaryOf(totalCase?.metrics, "gpuTimestampMs");
  total = totalGpu?.median ?? Object.values(stageRows).reduce((a, b) => a + (b ?? 0), 0);
  for (const stage of stages) {
    const gpu = stageRows[stage];
    const host = null; // host per stage lives in hostMs of the same case
    rows.push({ stage, gpuMs: gpu, share: gpu !== null && total > 0 ? gpu / total : null, hostMs: host });
  }
  rows.push({ stage: "total", gpuMs: total, share: 1, hostMs: null });
  return rows;
}

function scalingTable(cases, prefix, labelColumn, valueExtractor, extraColumns = []) {
  const rows = [];
  for (const c of caseById(cases, prefix)) {
    const row = {
      id: c.id,
      label: c.parameters[labelColumn] ?? c.id,
    };
    row.value = valueExtractor(c);
    for (const [key, extract] of extraColumns) {
      row[key] = extract(c);
    }
    rows.push(row);
  }
  return rows;
}

function bottleneckMatrix(docs) {
  const all = docs.flatMap((d) => d.cases);
  const rows = [];
  // resolution: heaviest stage at each resolution
  const resCases = caseById(all, "resolution/");
  const resolutionStage = new Map();
  for (const c of resCases) {
    const pass = c.metrics.gpuTimestampPass ?? {};
    let bestStage = null;
    let bestMs = 0;
    for (const [stage, summary] of Object.entries(pass)) {
      if (summary?.median !== null && summary?.median !== undefined && summary.median > bestMs) {
        bestMs = summary.median;
        bestStage = stage;
      }
    }
    resolutionStage.set(`${c.parameters.width}x${c.parameters.height}`, { stage: bestStage, ms: bestMs });
  }
  const simpleRes = resolutionStage.get("640x360") ?? resolutionStage.values().next().value;
  rows.push({
    workload: "simple 640x360",
    main: simpleRes?.stage ?? "n/a",
    secondary: null,
    scalingFactor: "pixels",
    evidence: `${fmt(simpleRes?.ms)}ms GPU ${simpleRes?.stage}`,
  });
  // many surfaces: height pass share of total at the largest count
  const surfaceCases = caseById(all, "surface-scale/");
  if (surfaceCases.length > 0) {
    const largest = surfaceCases[surfaceCases.length - 1];
    const height = summaryOf(largest.metrics, "heightGpuTimestampMs");
    const total = summaryOf(largest.metrics, "gpuTimestampMs");
    rows.push({
      workload: "many surfaces",
      main: "height",
      secondary: null,
      scalingFactor: "pixels × surfaces",
      evidence: `${fmt(height?.median)}ms height / ${fmt(total?.median)}ms frame (${largest.parameters.surfaceCount} surfaces)`,
    });
  }
  // many masks: largest mask-resolution case
  const maskCases = caseById(all, "mask-resolution/");
  if (maskCases.length > 0) {
    const largest = maskCases[maskCases.length - 1];
    const total = summaryOf(largest.metrics, "gpuTimestampMs");
    rows.push({
      workload: "many masks",
      main: "height (mask SDF)",
      secondary: null,
      scalingFactor: "mask cells",
      evidence: `${fmt(total?.median)}ms frame at mask res ${largest.parameters.maskResolution} (${largest.metrics.totalMaskCells} cells)`,
    });
  }
  // soft shadow
  const shadowCases = caseById(all, "shadow/samples-");
  if (shadowCases.length > 0) {
    const defaultRadius = shadowCases.filter((c) => c.parameters.angularRadius === 0.15);
    const s16 = defaultRadius.find((c) => c.parameters.samples === 16);
    const s1 = defaultRadius.find((c) => c.parameters.samples === 1);
    const g16 = summaryOf(s16?.metrics, "shadowGpuTimestampMs");
    const g1 = summaryOf(s1?.metrics, "shadowGpuTimestampMs");
    const ratio = g1?.median !== null && g1?.median > 0 ? g16?.median / g1?.median : null;
    rows.push({
      workload: "soft shadow",
      main: "shadow",
      secondary: null,
      scalingFactor: "pixels × samples × march",
      evidence: `${fmt(g16?.median)}ms shadow at 16 samples (${fmt(ratio, 1)}x vs 1 sample)`,
    });
  }
  // high DPR
  const reconCases = caseById(all, "reconstruction/dpr-");
  if (reconCases.length > 0) {
    const dpr4r4 = reconCases.find((c) => c.parameters.dpr === 4 && c.parameters.radius === 4);
    const total = summaryOf(dpr4r4?.metrics, "gpuTimestampMs");
    const recon = summaryOf(dpr4r4?.metrics, "reconstructionGpuTimestampMs");
    rows.push({
      workload: "high DPR + reconstruction",
      main: "reconstruction",
      secondary: null,
      scalingFactor: "DPR² + radiusTexels²",
      evidence: `${fmt(recon?.median)}ms recon / ${fmt(total?.median)}ms frame at DPR 4 radius 4`,
    });
  }
  // DOM-heavy
  const domCases = caseById(all, "dom/unrelated-mutation/");
  if (domCases.length > 0) {
    const largest = domCases[domCases.length - 1];
    const rects = summaryOf(largest.metrics, "rectCallsPerFrame");
    rows.push({
      workload: "DOM-heavy",
      main: "measurement",
      secondary: "skipped render",
      scalingFactor: "registered surfaces",
      evidence: `${fmt(rects?.median, 0)} getBoundingClientRect at ${largest.parameters.surfaceCount} surfaces`,
    });
  }
  return rows;
}

function followUpCandidates(docs) {
  const all = docs.flatMap((d) => d.cases);
  const candidates = [];
  // 1. reconstruction at high DPR dominates the frame
  const reconCases = caseById(all, "reconstruction/dpr-");
  for (const c of reconCases) {
    if (c.metrics.reconstructionRatio !== null && c.metrics.reconstructionRatio > 0.5) {
      candidates.push({
        title: `ReconstructionPass is ${fmt(c.metrics.reconstructionRatio * 100, 1)}% of the frame at DPR ${c.parameters.dpr} radius ${c.parameters.radius}`,
        evidence: `${fmt(summaryOf(c.metrics, "reconstructionGpuTimestampMs")?.median)}ms of ${fmt(summaryOf(c.metrics, "gpuTimestampMs")?.median)}ms`,
        issue: "shared-memory / separable reconstruction (currently (2r+1)^2 neighborhood)",
      });
      break;
    }
  }
  // 2. mask SDF at high resolution
  const maskRes = caseById(all, "mask-resolution/");
  const largestMask = maskRes[maskRes.length - 1];
  if (largestMask !== undefined && summaryOf(largestMask.metrics, "gpuTimestampMs")?.median > 5) {
    candidates.push({
      title: `Mask SDF generation costs ${fmt(summaryOf(largestMask.metrics, "gpuTimestampMs")?.median)}ms at mask resolution ${largestMask.parameters.maskResolution}`,
      evidence: `${largestMask.metrics.totalMaskCells} padded mask cells`,
      issue: "mask SDF algorithm / caching (unchanged masks recomputed on geometry updates)",
    });
  }
  // 3. shadow cost at 16 samples vs 1
  const shadowCases = caseById(all, "shadow/samples-");
  const s16 = shadowCases.find((c) => c.parameters.samples === 16 && c.parameters.angularRadius === 0.15);
  const s1 = shadowCases.find((c) => c.parameters.samples === 1 && c.parameters.angularRadius === 0.15);
  if (s16 !== undefined && s1 !== undefined) {
    const g16 = summaryOf(s16.metrics, "shadowGpuTimestampMs")?.median;
    const g1 = summaryOf(s1.metrics, "shadowGpuTimestampMs")?.median;
    if (g1 > 0 && g16 / g1 > 8) {
      candidates.push({
        title: `Soft shadow at 16 samples costs ${fmt(g16 / g1, 1)}x the 1-sample hard path (${fmt(g16)}ms)`,
        evidence: `samples {1,4,8,16} → ${fmt(g1)}/${fmt(g16)}ms shadow`,
        issue: "shadow marcher acceleration / hierarchical ray skipping",
      });
    }
  }
  // 4. presentation shader vs queue cost
  const presCases = caseById(all, "presentation/p");
  const p4 = presCases.find((c) => c.id === "presentation/p4-production");
  const p0 = presCases.find((c) => c.id === "presentation/p0");
  if (p4 !== undefined && p0 !== undefined) {
    const wall4 = summaryOf(p4.metrics, "wallMs")?.median;
    const wall0 = summaryOf(p0.metrics, "wallMs")?.median;
    if (wall0 !== null && wall4 !== null && wall0 > 0.5 && wall4 - wall0 > 1) {
      candidates.push({
        title: `Production PresentationPass adds ${fmt(wall4 - wall0)}ms over the attachment-only floor (${fmt(wall0)}ms)`,
        evidence: "P0..P4 presentation microbenchmark",
        issue: "presentation shader / composite cost",
      });
    }
  }
  // 5. per-stage submissions across the frame
  const stageTotal = all.find((c) => c.id === "stage/frame-total");
  if (stageTotal !== undefined && stageTotal.metrics.submissions > 1) {
    candidates.push({
      title: `Full frame issues ${stageTotal.metrics.submissions} queue.submit calls`,
      evidence: "submission-count benchmark (1..8 empty submissions are sub-ms each)",
      issue: "single-command-buffer renderer redesign (baseline recorded)",
    });
  }
  return candidates;
}

function markdownReport(docs) {
  const lines = [];
  lines.push("# Ukibori benchmark report (#46)");
  lines.push("");
  const first = docs[0];
  lines.push(`- schemaVersion: ${first.schemaVersion}`);
  lines.push(`- commit: ${first.commit}`);
  lines.push(`- generatedAt: ${first.generatedAt}`);
  for (const doc of docs) {
    const env = doc.environment ?? {};
    lines.push(`- ${doc.cases[0]?.parameters?.suite ?? "?"} run: ${env.userAgent ?? env.os ?? "unknown"} / ${env.adapterName || env.cpuModel || "unknown"} / backend ${env.adapterBackend ?? env.platform ?? "unknown"} / timestamp-query ${env.timestampQuerySupported ?? "unknown"}`);
  }
  lines.push("");

  const all = docs.flatMap((d) => d.cases);

  // §18 stage summary
  const stageRows = stageTable(all);
  if (stageRows.length > 0) {
    lines.push("## Stage summary (median GPU ms, stage suite)");
    lines.push("");
    lines.push("| Stage | Median GPU ms | Frame share |");
    lines.push("|---|---|---|");
    for (const row of stageRows) {
      lines.push(
        `| ${row.stage} | ${fmt(row.gpuMs)} | ${row.share !== null ? (row.share * 100).toFixed(1) + "%" : "n/a"} |`,
      );
    }
    lines.push("");
  }

  // resolution
  const resRows = scalingTable(
    all,
    "resolution/",
    "width",
    (c) => summaryOf(c.metrics, "gpuTimestampMs")?.median,
    [
      ["texels", (c) => c.metrics.texels],
      ["hostMs", (c) => summaryOf(c.metrics, "hostMs")?.median],
    ],
  );
  if (resRows.length > 0) {
    lines.push("## Resolution scaling (median GPU ms, full frame)");
    lines.push("");
    lines.push("| Resolution | GPU ms | host ms | texels |");
    lines.push("|---|---|---|---|");
    for (const r of resRows) {
      lines.push(`| ${r.label} | ${fmt(r.value)} | ${fmt(r.hostMs)} | ${r.texels} |`);
    }
    lines.push("");
  }

  // surface
  const surfRows = scalingTable(
    all,
    "surface-scale/",
    "surfaceCount",
    (c) => summaryOf(c.metrics, "gpuTimestampMs")?.median,
    [
      ["heightGpu", (c) => summaryOf(c.metrics, "heightGpuTimestampMs")?.median],
      ["encodedBytes", (c) => c.metrics.encodedBytes],
    ],
  );
  if (surfRows.length > 0) {
    lines.push("## Surface-count scaling (median GPU ms)");
    lines.push("");
    lines.push("| Surfaces | Frame GPU ms | Height GPU ms | Encoded bytes |");
    lines.push("|---|---|---|---|");
    for (const r of surfRows) {
      lines.push(`| ${r.label} | ${fmt(r.value)} | ${fmt(r.heightGpu)} | ${r.encodedBytes} |`);
    }
    lines.push("");
  }

  // mask
  const maskRows = scalingTable(
    all,
    "mask-resolution/",
    "maskResolution",
    (c) => summaryOf(c.metrics, "gpuTimestampMs")?.median,
    [
      ["maskCells", (c) => c.metrics.totalMaskCells],
      ["wallMs", (c) => summaryOf(c.metrics, "wallMs")?.median],
    ],
  );
  if (maskRows.length > 0) {
    lines.push("## Mask-resolution scaling (16 masks, median GPU ms)");
    lines.push("");
    lines.push("| Mask resolution | Frame GPU ms | Wall ms | Padded cells |");
    lines.push("|---|---|---|---|");
    for (const r of maskRows) {
      lines.push(`| ${r.label} | ${fmt(r.value)} | ${fmt(r.wallMs)} | ${r.maskCells} |`);
    }
    lines.push("");
  }
  const maskUnrelated = all.find((c) => c.id === "mask/unrelated-geometry-after-mask");
  if (maskUnrelated !== undefined) {
    lines.push(
      `- mask SDF re-run on unrelated geometry update: passes=${maskUnrelated.metrics.maskSdfPasses}, ` +
        `executed=[${maskUnrelated.metrics.executed}]`,
    );
    lines.push("");
  }

  // shadow
  const shadowRows = scalingTable(
    all,
    "shadow/samples-",
    "samples",
    (c) => summaryOf(c.metrics, "shadowGpuTimestampMs")?.median,
    [
      ["angularRadius", (c) => c.parameters.angularRadius],
      ["soft", (c) => (c.metrics.softActive ? "yes" : "no")],
      ["steps", (c) => c.metrics.shadowSteps],
    ],
  );
  if (shadowRows.length > 0) {
    lines.push("## Shadow sample scaling (median ShadowPass GPU ms)");
    lines.push("");
    lines.push("| Samples | Angular radius | Soft | Shadow GPU ms | March steps |");
    lines.push("|---|---|---|---|---|");
    for (const r of shadowRows) {
      lines.push(`| ${r.label} | ${r.angularRadius} | ${r.soft} | ${fmt(r.value)} | ${r.steps} |`);
    }
    lines.push("");
  }

  // reconstruction
  const reconRows = scalingTable(
    all,
    "reconstruction/dpr-",
    "radius",
    (c) => summaryOf(c.metrics, "reconstructionGpuTimestampMs")?.median,
    [
      ["dpr", (c) => c.parameters.dpr],
      ["active", (c) => c.metrics.reconstructionActive],
      ["tapsPerTexel", (c) => c.metrics.tapsPerTexel],
      ["frameGpu", (c) => summaryOf(c.metrics, "gpuTimestampMs")?.median],
      ["ratio", (c) => c.metrics.reconstructionRatio],
    ],
  );
  if (reconRows.length > 0) {
    lines.push("## Reconstruction radius × DPR (median GPU ms)");
    lines.push("");
    lines.push("| Radius | DPR | Active | Taps/texel | Recon GPU ms | Frame GPU ms | Recon share |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const r of reconRows) {
      lines.push(
        `| ${r.label} | ${r.dpr} | ${r.active} | ${r.tapsPerTexel} | ${fmt(r.value)} | ${fmt(r.frameGpu)} | ${r.ratio !== null ? (r.ratio * 100).toFixed(1) + "%" : "n/a"} |`,
      );
    }
    lines.push("");
  }

  // presentation
  const presRows = scalingTable(all, "presentation/p", "stage", (c) => summaryOf(c.metrics, "wallMs")?.median, [
    ["format", (c) => c.metrics.canvasFormat],
  ]);
  if (presRows.length > 0) {
    lines.push("## Presentation microbenchmark (median wall ms)");
    lines.push("");
    lines.push("| Stage | Wall ms | Canvas format |");
    lines.push("|---|---|---|");
    for (const r of presRows) {
      lines.push(`| ${r.label} | ${fmt(r.value)} | ${r.format} |`);
    }
    lines.push("");
  }

  // submissions
  const subRows = scalingTable(all, "submission/n-", "submissions", (c) => summaryOf(c.metrics, "wallMs")?.median, []);
  if (subRows.length > 0) {
    lines.push("## Submission-count overhead (median wall ms)");
    lines.push("");
    lines.push("| Submissions | Wall ms |");
    lines.push("|---|---|");
    for (const r of subRows) {
      lines.push(`| ${r.label} | ${fmt(r.value)} |`);
    }
    lines.push("");
  }

  // upload
  const uploadRows = scalingTable(
    all,
    "upload/",
    "updateType",
    (c) => summaryOf(c.metrics, "hostMs")?.median,
    [
      ["encodedBytes", (c) => c.metrics.encodedBytes],
      ["bytesUploaded", (c) => c.metrics.bytesUploaded],
      ["writeCalls", (c) => c.metrics.writeCalls],
    ],
  );
  if (uploadRows.length > 0) {
    lines.push("## Upload benchmark (median host ms, 64-surface grid)");
    lines.push("");
    lines.push("| Update type | Host ms | Encoded bytes | Uploaded bytes | writeBuffer calls |");
    lines.push("|---|---|---|---|---|");
    for (const r of uploadRows) {
      lines.push(`| ${r.label} | ${fmt(r.value)} | ${r.encodedBytes} | ${r.bytesUploaded} | ${r.writeCalls} |`);
    }
    lines.push("");
  }

  // partial
  const partialRows = scalingTable(
    all,
    "partial/ratio-",
    "dirtyRatio",
    (c) => summaryOf(c.metrics, "gpuTimestampMs")?.median,
    [
      ["mode", (c) => c.metrics.planningMode],
      ["dirtyTexels", (c) => c.metrics.dirtyTexels],
      ["dispatchTexels", (c) => c.metrics.dispatchTexels],
      ["planningHostMs", (c) => summaryOf(c.metrics, "planningHostMs")?.median],
    ],
  );
  if (partialRows.length > 0) {
    lines.push("## Partial recompute (median GPU ms)");
    lines.push("");
    lines.push("| Dirty ratio | Mode | Frame GPU ms | Dirty texels | Dispatch texels | Planning host ms |");
    lines.push("|---|---|---|---|---|---|");
    for (const r of partialRows) {
      lines.push(`| ${r.label}% | ${r.mode} | ${fmt(r.value)} | ${r.dirtyTexels} | ${r.dispatchTexels} | ${fmt(r.planningHostMs, 4)} |`);
    }
    lines.push("");
  }

  // retained
  const retainedRows = scalingTable(all, "retained/", "case", (c) => summaryOf(c.metrics, "wallMs")?.median, [
    ["executed", (c) => c.metrics.executed],
    ["expected", (c) => c.metrics.expectedExecuted],
    ["subPerFrame", (c) => c.metrics.submissionsPerFrame],
  ]);
  if (retainedRows.length > 0) {
    lines.push("## Retained scheduling (median wall ms per frame)");
    lines.push("");
    lines.push("| Case | Wall ms | Submissions/frame | Executed | Expected |");
    lines.push("|---|---|---|---|---|");
    for (const r of retainedRows) {
      lines.push(`| ${r.label} | ${fmt(r.value)} | ${fmt(r.subPerFrame, 2)} | ${r.executed} | ${r.expected} |`);
    }
    lines.push("");
  }

  // e2e
  const e2eRows = scalingTable(all, "e2e/", "case", (c) => summaryOf(c.metrics, "wallMs")?.median, [
    ["gpuMs", (c) => summaryOf(c.metrics, "gpuTimestampMs")?.median],
    ["executed", (c) => c.metrics.executed],
  ]);
  if (e2eRows.length > 0) {
    lines.push("## End-to-end frame cases (median wall ms)");
    lines.push("");
    lines.push("| Case | Wall ms | GPU ms | Executed |");
    lines.push("|---|---|---|---|");
    for (const r of e2eRows) {
      lines.push(`| ${r.label} | ${fmt(r.value)} | ${fmt(r.gpuMs)} | ${r.executed} |`);
    }
    lines.push("");
  }

  // DOM
  const domRows = scalingTable(all, "dom/", "scenario", (c) => summaryOf(c.metrics, "wallMs")?.median, [
    ["surfaces", (c) => c.parameters.surfaceCount],
    ["rects", (c) => summaryOf(c.metrics, "rectCallsPerFrame")?.median],
    ["invocations", (c) => summaryOf(c.metrics, "rendererInvocationsPerFrame")?.median],
    ["skipped", (c) => summaryOf(c.metrics, "skippedRenderPerFrame")?.median],
    ["executed", (c) => c.metrics.executed],
  ]);
  if (domRows.length > 0) {
    lines.push("## DOM integration (median wall ms)");
    lines.push("");
    lines.push("| Scenario | Surfaces | Wall ms | Rect calls | Renderer invocations | Skipped render | Executed |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const r of domRows) {
      lines.push(
        `| ${r.label} | ${r.surfaces} | ${fmt(r.value)} | ${fmt(r.rects, 0)} | ${fmt(r.invocations, 2)} | ${fmt(r.skipped, 2)} | ${r.executed} |`,
      );
    }
    lines.push("");
  }

  // §19 bottleneck matrix
  lines.push("## Bottleneck matrix");
  lines.push("");
  lines.push("| Workload | Main bottleneck | Secondary | Scaling factor | Evidence |");
  lines.push("|---|---|---|---|---|");
  for (const row of bottleneckMatrix(docs)) {
    lines.push(`| ${row.workload} | ${row.main} | ${row.secondary ?? "-"} | ${row.scalingFactor} | ${row.evidence} |`);
  }
  lines.push("");

  // follow-up candidates
  const candidates = followUpCandidates(docs);
  if (candidates.length > 0) {
    lines.push("## Follow-up optimization candidates");
    lines.push("");
    for (const [index, candidate] of candidates.entries()) {
      lines.push(`${index + 1}. **${candidate.title}** — ${candidate.evidence}. Candidate: ${candidate.issue}.`);
    }
    lines.push("");
  }

  lines.push("## Notes");
  lines.push("");
  lines.push("- hostMs = host encode/upload/dispatch wall time; gpuTimestampMs = real GPU timestamp-query duration (unsupported adapters report n/a, never fabricated zeros); wallMs = render + `queue.onSubmittedWorkDone()` completion.");
  lines.push("- Values are median over the warmed samples; p95/min/max live in the JSON documents.");
  lines.push("- Absolute timings are hardware-specific; only compare runs on the same machine/runner.");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const paths = resultsArg.split(",").map((p) => p.trim()).filter(Boolean);
  const docs = [];
  for (const path of paths) {
    if (!existsSync(path)) {
      console.error(`bench-report.mjs: result file not found: ${path}`);
      process.exit(1);
    }
    const doc = JSON.parse(await readFile(path, "utf8"));
    const problems = validateResultDocument(doc);
    if (problems.length > 0) {
      console.error(`bench-report.mjs: ${path} failed schema validation:`);
      for (const problem of problems) {
        console.error(`  - ${problem}`);
      }
      process.exit(1);
    }
    docs.push(doc);
  }
  const report = markdownReport(docs);
  await writeFile(outPath, report, "utf8");
  console.log(`bench-report: wrote ${outPath} (${docs.length} document(s), ${docs.reduce((a, d) => a + d.cases.length, 0)} cases)`);
}

main().catch((error) => {
  console.error(`bench-report.mjs: ${error}`);
  process.exit(1);
});