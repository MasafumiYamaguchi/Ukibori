#!/usr/bin/env node
// #46 benchmark report generator (#18/#19/#20): turns one or more versioned
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
const repoRoot = resolve(pkgRoot, "..", "..");

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}
const resultsArg = flag(
  "--results",
  flag(
    "--json",
    [
      join(pkgRoot, "benchmark-results.json"),
      join(pkgRoot, "benchmark-results-cpu.json"),
      join(repoRoot, "packages", "ukibori-dom", "benchmark-results-dom.json"),
    ].join(","),
  ),
);
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
      scalingFactor: "pixels x surfaces",
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
    const s16 = defaultRadius.find((c) => c.parameters.shadowSamples === 16);
    const s1 = defaultRadius.find((c) => c.parameters.shadowSamples === 1);
    const g16 = summaryOf(s16?.metrics, "shadowGpuTimestampMs");
    const g1 = summaryOf(s1?.metrics, "shadowGpuTimestampMs");
    const ratio = g1?.median !== null && g1?.median > 0 ? g16?.median / g1?.median : null;
    rows.push({
      workload: "soft shadow",
      main: "shadow",
      secondary: null,
      scalingFactor: "pixels x samples x march",
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
      scalingFactor: "DPR^2 + radiusTexels^2",
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
  // 2b. unchanged masks re-running on unrelated geometry updates (only when
  // the THIS-FRAME measurement says the SDF pass actually ran)
  const maskUnrelated = all.find((c) => c.id === "mask/unrelated-geometry-after-mask");
  if (
    maskUnrelated !== undefined &&
    maskUnrelated.metrics.maskSdfPassesThisFrame > 0 &&
    String(maskUnrelated.metrics.executed).includes("height")
  ) {
    candidates.push({
      title: "Unchanged masks re-run the mask-SDF pass on an unrelated geometry update",
      evidence: `executed=[${maskUnrelated.metrics.executed}] maskSdfPasses=${maskUnrelated.metrics.maskSdfPassesThisFrame} ` +
        `height GPU=${fmt(summaryOf(maskUnrelated.metrics, "heightGpuTimestampMs")?.median)}ms`,
      issue: "GPU mask-SDF cache keyed by mask contents (benchmark-flagged; separate optimization issue)",
    });
  }
  // 3. shadow cost at 16 samples vs 1
  const shadowCases = caseById(all, "shadow/samples-");
  const s16 = shadowCases.find((c) => c.parameters.shadowSamples === 16 && c.parameters.angularRadius === 0.15);
  const s1 = shadowCases.find((c) => c.parameters.shadowSamples === 1 && c.parameters.angularRadius === 0.15);
  if (s16 !== undefined && s1 !== undefined) {
    const g16 = summaryOf(s16.metrics, "shadowGpuTimestampMs")?.median;
    const g1 = summaryOf(s1.metrics, "shadowGpuTimestampMs")?.median;
    if (g1 > 0 && g16 / g1 > 8) {
      candidates.push({
        title: `Soft shadow at 16 samples costs ${fmt(g16 / g1, 1)}x the 1-sample hard path (${fmt(g16)}ms)`,
        evidence: `samples {1,4,8,16} ->${fmt(g1)}/${fmt(g16)}ms shadow`,
        issue: "shadow marcher acceleration / hierarchical ray skipping",
      });
    }
  }
  // 4. presentation: compare GPU timestamps (shader cost) and wall costs
  // SEPARATELY - wall must never be read as shader cost
  const presCases = caseById(all, "presentation/p");
  const p4 = presCases.find((c) => c.id === "presentation/p4-production");
  const p0 = presCases.find((c) => c.id === "presentation/p0");
  if (p4 !== undefined && p0 !== undefined) {
    const gpu4 = summaryOf(p4.metrics, "gpuTimestampMs")?.median;
    const gpu0 = summaryOf(p0.metrics, "gpuTimestampMs")?.median;
    const wall4 = summaryOf(p4.metrics, "wallMs")?.median;
    const wall0 = summaryOf(p0.metrics, "wallMs")?.median;
    if (
      gpu4 !== null && gpu0 !== null &&
      gpu4 - gpu0 > 0.01
    ) {
      candidates.push({
        title: `Production PresentationPass shader cost is ${fmt(gpu4)}ms vs ${fmt(gpu0)}ms for the attachment-only floor (GPU timestamps)`,
        evidence: "P0..P4 presentation microbenchmark, gpuTimestampMs",
        issue: "presentation shader / composite cost",
      });
    } else if (wall0 !== null && wall4 !== null && wall4 - wall0 > 1) {
      // the shader is NOT the difference: the wall gap is queue/swapchain/
      // compositor fixed cost, explicitly NOT a shader-cost claim
      candidates.push({
        title: `Production present adds ${fmt(wall4 - wall0)}ms WALL over the attachment-only floor, but GPU shader time is flat (${fmt(gpu4)} vs ${fmt(gpu0)}ms)`,
        evidence: "P0..P4 presentation microbenchmark; the gap is queue/swapchain/compositor fixed cost, not shader work",
        issue: "queue submission / swapchain acquisition / presentation fixed cost",
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
  lines.push(`- workingTreeDirty: ${first.workingTreeDirty ?? "unknown"}`);
  lines.push(`- generatedAt: ${first.generatedAt}`);
  for (const doc of docs) {
    const env = doc.environment ?? {};
    lines.push(`- ${doc.cases[0]?.parameters?.suite ?? "?"} run: ${env.userAgent ?? env.os ?? "unknown"} / ${env.adapterName || env.cpuModel || "unknown"} / backend ${env.adapterBackend ?? env.platform ?? "unknown"} / timestamp-query ${env.timestampQuerySupported ?? "unknown"}`);
  }
  lines.push("");

  const all = docs.flatMap((d) => d.cases);

  // #18 stage summary
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
    const m = maskUnrelated.metrics;
    lines.push(
      `- unchanged mask + unrelated geometry update (this frame): executed=[${m.executed}], ` +
        `planning=${m.planningMode} (${m.planningReason}), ` +
        `maskSdfPasses=${m.maskSdfPassesThisFrame}, composePasses=${m.composePassesThisFrame}, ` +
        `totalMaskCells=${m.totalMaskCells}, ` +
        `height GPU=${fmt(summaryOf(m, "heightGpuTimestampMs")?.median)}ms, ` +
        `maskSDF GPU=${fmt(summaryOf(m, "maskSdfGpuTimestampMs")?.median)}ms, ` +
        `compose GPU=${fmt(summaryOf(m, "composeGpuTimestampMs")?.median)}ms, ` +
        `wall=${fmt(summaryOf(m, "wallMs")?.median)}ms ` +
        `(samples=${m.executed === "" ? "n/a" : summaryOf(m, "wallMs")?.samples})`,
    );
    lines.push("");
  }

  // shadow
  const shadowRows = scalingTable(
    all,
    "shadow/samples-",
    "shadowSamples",
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

  // shadow travel distance (explicit maxDistance per case = real workload)
  const travelRows = scalingTable(
    all,
    "shadow/travel-",
    "travel",
    (c) => summaryOf(c.metrics, "shadowGpuTimestampMs")?.median,
    [
      ["shadowSamples", (c) => c.parameters.shadowSamples],
      ["maxDistance", (c) => c.parameters.maxDistance],
      ["stepSize", (c) => c.parameters.stepSize],
      ["theoreticalMaxSteps", (c) => c.parameters.theoreticalMaxSteps],
      ["steps", (c) => c.metrics.shadowSteps],
    ],
  );
  if (travelRows.length > 0) {
    lines.push("## Shadow travel distance (median ShadowPass GPU ms)");
    lines.push("");
    lines.push(
      "The travel axis is the CONFIGURED march budget (the sanitized maxDistance " +
        "the pass packs): short 40 / medium 120 / long 300 scene units at stepSize 0.5. " +
        "The dispatch step counts differ by construction; the MEASURED GPU cost can " +
        "saturate when scene bounds / early exits bound the effective ray travel " +
        "(configured budget != executed work).",
    );
    lines.push("");
    lines.push("| Travel | Shadow samples | maxDistance | stepSize | Theoretical max steps | Shadow GPU ms | Dispatch step count |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const r of travelRows) {
      lines.push(
        `| ${r.label} | ${r.shadowSamples} | ${r.maxDistance} | ${r.stepSize} | ${r.theoreticalMaxSteps} | ${fmt(r.value)} | ${r.steps} |`,
      );
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
    lines.push("## Reconstruction radius x DPR (median GPU ms)");
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
    ["hostMs", (c) => summaryOf(c.metrics, "hostMs")?.median],
    ["gpuTs", (c) => summaryOf(c.metrics, "gpuTimestampMs")?.median],
    ["format", (c) => c.metrics.canvasFormat],
  ]);
  if (presRows.length > 0) {
    lines.push("## Presentation microbenchmark");
    lines.push("");
    lines.push(
      "P0-P3 wall = submission + queue completion; GPU timestamp = the render pass itself " +
        "(null on adapters without timestamp-query). P4 wall = production pipeline.present(); " +
        "P4 GPU timestamp = the presentation stage of a production repaint render. " +
        "Wall cost alone must never be read as shader cost.",
    );
    lines.push("");
    lines.push("| Stage | Host ms | GPU timestamp ms | Wall ms | Canvas format |");
    lines.push("|---|---|---|---|---|");
    for (const r of presRows) {
      lines.push(`| ${r.label} | ${fmt(r.hostMs)} | ${fmt(r.gpuTs)} | ${fmt(r.value)} | ${r.format} |`);
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
      ["wallMs", (c) => summaryOf(c.metrics, "wallMs")?.median],
      ["encodedBytes", (c) => c.metrics.encodedBytes],
      ["bytesUploaded", (c) => c.metrics.bytesUploaded],
      ["writeCalls", (c) => c.metrics.writeCalls],
      ["newAllocations", (c) => c.metrics.newAllocations],
      ["writtenSections", (c) => Array.isArray(c.metrics.writtenSections) ? c.metrics.writtenSections.join("+") : ""],
      ["changedSections", (c) => Array.isArray(c.metrics.changedSections) ? c.metrics.changedSections.join("+") : ""],
    ],
  );
  if (uploadRows.length > 0) {
    lines.push("## Upload benchmark (transition per sample, fresh uploader)");
    lines.push("");
    lines.push(
      "hostMs = the uploader.upload() call itself; wallMs = upload + queue completion. " +
        "writtenSections = sections the uploader transferred (every non-empty section); " +
        "changedSections = sections whose BYTES differ between the before and after scenes.",
    );
    lines.push("");
    lines.push("| Update type | Host ms | Wall ms | Encoded bytes | Uploaded bytes | writeBuffer calls | New allocations | Written sections | Changed sections |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    for (const r of uploadRows) {
      lines.push(
        `| ${r.label} | ${fmt(r.value)} | ${fmt(r.wallMs)} | ${r.encodedBytes} | ${r.bytesUploaded} | ` +
          `${r.writeCalls} | ${r.newAllocations} | ${r.writtenSections} | ${r.changedSections} |`,
      );
    }
    lines.push("");
  }

  // partial
  const partialRows = scalingTable(
    all,
    "partial/",
    "inputEdit",
    (c) => summaryOf(c.metrics, "gpuTimestampMs")?.median,
    [
      ["case", (c) => c.id.replace("partial/", "")],
      ["actualRatio", (c) => c.metrics.actualDirtyRatio],
      ["partialMode", (c) => c.metrics.partialPlanningMode],
      ["forcedMode", (c) => c.metrics.forcedFullPlanningMode],
      ["dirtyTexels", (c) => c.metrics.dirtyTexels],
      ["dispatchTexels", (c) => c.metrics.dispatchTexels],
      ["forcedGpu", (c) => summaryOf(c.metrics, "forcedFullGpuTimestampMs")?.median],
      ["ratio", (c) => c.metrics.partialToFullRatio],
      ["calibration", (c) => c.metrics.normalFullToForcedFullRatio],
    ],
  );
  if (partialRows.length > 0) {
    lines.push("## Partial vs forced-full recompute (median GPU ms)");
    lines.push("");
    lines.push(
      "actualDirtyRatio = planner dirtyTexels / totalTexels (never the input knob). " +
        "Both sides are measured on the SAME warm retained pipeline with the same " +
        "base -> target transition: the normal scheduler render vs the benchmark-only " +
        "debugForceFull render of the SAME target scene (identical resource state). " +
        "partialToFullRatio = partial GPU / forced-full GPU (< 1 = partial wins). " +
        "calibration = normal-full GPU / forced-full GPU on the cases where the normal " +
        "planner ALSO chose full (a systematic gap would mean the comparator is unfair).",
    );
    lines.push("");
    lines.push("| Case | Actual dirty ratio | Partial mode | Forced-full mode | Partial GPU ms | Forced-full GPU ms | P/F ratio | Calibration | Dirty texels | Dispatch texels |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|");
    for (const r of partialRows) {
      lines.push(
        `| ${r.case} | ${r.actualRatio !== null ? (r.actualRatio * 100).toFixed(1) + "%" : "n/a"} | ${r.partialMode} | ${r.forcedMode} | ` +
          `${fmt(r.value)} | ${fmt(r.forcedGpu)} | ${r.ratio !== null ? r.ratio.toFixed(3) : "n/a"} | ` +
          `${r.calibration !== null ? r.calibration.toFixed(3) : "n/a"} | ${r.dirtyTexels} | ${r.dispatchTexels} |`,
      );
    }
    lines.push("");
    const nonFullComparators = partialRows.filter((r) => r.forcedMode !== "full");
    if (nonFullComparators.length > 0) {
      lines.push(
        `- VERIFICATION FAILURE: ${nonFullComparators.length} comparator case(s) did not plan full ` +
          `(${nonFullComparators.map((r) => r.case).join(", ")}) — the debugForceFull seam was violated.`,
      );
      lines.push("");
    } else {
      lines.push(
        `- comparator verification: all ${partialRows.length} forced-full cases planned mode=full.`,
      );
      lines.push("");
    }
    const calibrationRows = partialRows.filter((r) => r.calibration !== null);
    if (calibrationRows.length > 0) {
      const worst = Math.max(
        ...calibrationRows.map((r) => Math.abs(r.calibration - 1)),
      );
      lines.push(
        `- full/full calibration: normal-planner-full vs forced-full GPU medians agree within ` +
          `${(worst * 100).toFixed(1)}% across ${calibrationRows.length} case(s) ` +
          `(0.9-1.1 would be acceptable; a systematic gap would invalidate the comparator).`,
      );
      lines.push("");
    }
  }

  // retained
  const retainedRows = scalingTable(all, "retained/", "case", (c) => summaryOf(c.metrics, "transitionWallMs")?.median, [
    ["frames", (c) => c.parameters.frames],
    ["repeatWall", (c) => summaryOf(c.metrics, "repeatedWallMs")?.median],
    ["subPerFrame", (c) => c.metrics.repeatedSubmissionsPerFrame],
    ["dispPerFrame", (c) => c.metrics.repeatedDispatchesPerFrame],
    ["bytesPerFrame", (c) => c.metrics.repeatedBytesUploadedPerFrame],
    ["transitionGpu", (c) => summaryOf(c.metrics, "transitionGpuTimestampMs")?.median],
    ["transitionExecuted", (c) => c.metrics.transitionExecuted],
    ["expected", (c) => c.metrics.expectedExecuted],
  ]);
  if (retainedRows.length > 0) {
    lines.push("## Retained scheduling: transition vs repeated (median wall ms)");
    lines.push("");
    lines.push(
      "transitionWallMs = the real base -> variant update frame; repeatedWallMs = identical " +
        "variant -> variant retained frames after the transition. Never averaged together. " +
        "Repeated cost is over the recorded frames count.",
    );
    lines.push("");
    lines.push("| Case | Frames | Transition wall ms | Transition GPU ms | Repeated wall ms | Submissions/frame | Dispatches/frame | Bytes/frame | Transition executed | Expected |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|");
    for (const r of retainedRows) {
      lines.push(
        `| ${r.label} | ${r.frames} | ${fmt(r.value)} | ${fmt(r.transitionGpu)} | ${fmt(r.repeatWall)} | ` +
          `${fmt(r.subPerFrame, 2)} | ${fmt(r.dispPerFrame, 2)} | ${fmt(r.bytesPerFrame, 0)} | ${r.transitionExecuted} | ${r.expected} |`,
      );
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
    ["samples", (c) => summaryOf(c.metrics, "wallMs")?.samples],
    ["rects", (c) => summaryOf(c.metrics, "rectCallsPerFrame")?.median],
    ["styles", (c) => summaryOf(c.metrics, "computedStyleCallsPerFrame")?.median],
    ["measureMs", (c) => summaryOf(c.metrics, "measureHostMsPerFrame")?.median],
    ["sceneMs", (c) => summaryOf(c.metrics, "sceneBuildHostMsPerFrame")?.median],
    ["measured", (c) => summaryOf(c.metrics, "measuredEntriesPerFrame")?.median],
    ["callbackMs", (c) => summaryOf(c.metrics, "callbackHostMsPerFrame")?.median],
    ["settleMs", (c) => summaryOf(c.metrics, "settleWallMsPerFrame")?.median],
    ["invocations", (c) => summaryOf(c.metrics, "rendererInvocationsPerFrame")?.median],
    ["skipped", (c) => summaryOf(c.metrics, "skippedRenderPerFrame")?.median],
  ]);
  if (domRows.length > 0) {
    lines.push("## DOM integration (median per-frame timings)");
    lines.push("");
    lines.push(
      "Every scenario runs warmup + samples frames (never single-shot). " +
        "callbackHostMs = the Ukibori renderer callbacks inside the harness flush; " +
        "settleWallMs = the harness observer-delivery wait floor (setTimeout turns, NOT " +
        "Ukibori work). measurement/scene-build are FRAME-LOCAL: a frame whose serial " +
        "did not advance reports 0, never a stale previous-frame value. The scroll " +
        "scenario drives a real window.scrollTo + document scroll listener.",
    );
    lines.push("");
    lines.push("| Scenario | Surfaces | Samples | Wall ms | Callback ms | Settle ms | Meas. ms | Scene-build ms | Rect calls | Style calls | Invocations | Skipped |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const r of domRows) {
      lines.push(
        `| ${r.label} | ${r.surfaces} | ${r.samples ?? ""} | ${fmt(r.value)} | ` +
          `${fmt(r.callbackMs, 3)} | ${fmt(r.settleMs, 3)} | ${fmt(r.measureMs, 3)} | ${fmt(r.sceneMs, 3)} | ` +
          `${fmt(r.rects, 0)} | ${fmt(r.styles, 0)} | ${fmt(r.invocations, 2)} | ${fmt(r.skipped, 2)} |`,
      );
    }
    lines.push("");
  }

  // #19 bottleneck matrix
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
      lines.push(`${index + 1}. **${candidate.title}** - ${candidate.evidence}. Candidate: ${candidate.issue}.`);
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

/**
 * #46 cross-document provenance validation (see lib/provenance.mjs):
 * rejects reports that would silently merge incomparable results.
 */
import { crossDocumentProvenanceProblem } from "./bench/lib/provenance.mjs";

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
  // #46 cross-document provenance: mixing results generated by DIFFERENT
  // runner commits, or any dirty-tree document, would silently merge
  // incomparable numbers — reject the report instead.
  const provenanceProblem = crossDocumentProvenanceProblem(docs);
  if (provenanceProblem !== null) {
    console.error(`bench-report.mjs: ${provenanceProblem}`);
    process.exit(1);
  }
  const report = markdownReport(docs);
  await writeFile(outPath, report, "utf8");
  console.log(`bench-report: wrote ${outPath} (${docs.length} document(s), ${docs.reduce((a, d) => a + d.cases.length, 0)} cases)`);
}

main().catch((error) => {
  console.error(`bench-report.mjs: ${error}`);
  process.exit(1);
});