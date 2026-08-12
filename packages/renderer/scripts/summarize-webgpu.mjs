#!/usr/bin/env node
// #30 CI gate for the real-WebGPU parity run.
//
// The workflow runs the local runner (`npm run test:webgpu -w ukibori-renderer`)
// and captures its FULL stdout/stderr into a log file; the local runner keeps
// its strict semantics (SKIP exits nonzero — only a real-adapter PASS counts
// locally). THIS script translates the captured log into the CI outcome:
//
//   node scripts/summarize-webgpu.mjs <log-file>
//
// Decision table (anchored, parsed — NEVER substring search):
//
//   first-line marker (UKIBORI_WEBGPU_PASS/FAIL/SKIP, anchored regex from
//   test-webgpu.mjs) decides:
//     PASS            -> exit 0 (parity gate passed)
//     SKIP            -> exit 0 ONLY as a capability-dependent outcome
//                        (no WebGPU/adapter/Chrome in this environment);
//                        the reason stays visible in the summary and log
//     FAIL            -> exit 1 (a real mismatch / shader / validation /
//                        harness error; FAIL can NEVER be converted to
//                        SKIP or PASS)
//     no marker       -> exit 1 (malformed or missing marker; the harness
//                        threw before writing one)
//
// A FAIL detail line that happens to contain the word `UKIBORI_WEBGPU_PASS`
// or `UKIBORI_WEBGPU_SKIP` later in the text must NOT flip the outcome: only
// the first line, parsed by the shared anchored `parseResultMarker`, decides.
//
// The script also prints a concise job summary (markdown) with adapter/
// backend (when exposed), the marker, fixture totals and per-pass mismatch
// totals parsed from the harness `SUMMARY ` JSON line, and appends it to
// `$GITHUB_STEP_SUMMARY` when that environment variable is set.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// @ts-expect-error - scripts/test-webgpu.mjs has no type declarations
import { parseResultMarker } from "./test-webgpu.mjs";

const MARKER_PASS = "UKIBORI_WEBGPU_PASS";
const MARKER_SKIP = "UKIBORI_WEBGPU_SKIP";
const MARKER_FAIL = "UKIBORI_WEBGPU_FAIL";

/**
 * Parse the harness SUMMARY lines (anchored `SUMMARY ` prefix, one JSON
 * object per line). The summary is informational only — the OUTCOME is
 * decided exclusively by the anchored first-line marker.
 */
export function parseSummaryLines(text) {
  const summaries = [];
  for (const line of String(text).split("\n")) {
    const match = /^SUMMARY ([{].*[}])[ \t]*$/.exec(line);
    if (match === null) {
      continue;
    }
    try {
      const value = JSON.parse(match[1]);
      if (typeof value === "object" && value !== null) {
        summaries.push(value);
      }
    } catch {
      // malformed summary lines never decide the outcome
    }
  }
  return summaries;
}

/**
 * The CI outcome for one log: { marker, exitCode, reason }.
 * Only `marker` decides; FAIL is never translatable.
 */
export function ciOutcome(logText) {
  const marker = parseResultMarker(logText);
  if (marker === null) {
    return {
      marker: null,
      exitCode: 1,
      reason: "malformed or missing marker on the first line (harness throw?)",
    };
  }
  if (marker === MARKER_PASS) {
    return { marker, exitCode: 0, reason: "real-adapter parity PASS" };
  }
  if (marker === MARKER_SKIP) {
    return {
      marker,
      exitCode: 0,
      reason:
        "capability-dependent SKIP (no WebGPU/adapter/Chrome in this environment): " +
        "translated from the anchored parsed marker, not a parity claim",
    };
  }
  // FAIL can never become SKIP or PASS.
  return { marker, exitCode: 1, reason: "real mismatch/error FAIL" };
}

function markdownSummary(logText) {
  const marker = parseResultMarker(logText);
  const summaries = parseSummaryLines(logText);
  const data = summaries[summaries.length - 1] ?? {};
  const lines = [
    "## WebGPU golden gate",
    "",
    `- Marker: \`${marker ?? "(none)"}\``,
  ];
  if (data.adapter !== undefined && data.adapter !== null) {
    const adapter = data.adapter;
    lines.push(
      `- Adapter: \`${adapter.vendor ?? "?"}\` / \`${adapter.architecture ?? "?"}\` / ` +
        `\`${adapter.device ?? "?"}\``,
    );
  }
  lines.push(`- Fixtures: \`${data.fixtures ?? "?"}\` total, \`${data.texels ?? "?"}\` scene texels`);
  lines.push(
    `- Per-pass mismatches: normal \`${data.normalMismatches ?? "?"}\`, ` +
      `shadow visibility \`${data.shadowMismatches ?? "?"}\`, ` +
      `caster height \`${data.casterMismatches ?? "?"}\`, ` +
      `diffuse \`${data.diffuseMismatches ?? "?"}\`, ` +
      `specular \`${data.specularMismatches ?? "?"}\`, ` +
      `lighting RGBA8 hard \`${data.colorHard ?? "?"}\`, ` +
      `canvas hard \`${data.presentHard ?? "?"}\`, ` +
      `canvas bad-alpha \`${data.presentAlphaBad ?? "?"}\``,
  );
  lines.push(`- Canvas fixtures: \`${data.presentFixtures ?? "?"}\`, \`${data.presentTexels ?? "?"}\` canvas texels`);
  if (data.benchmarkSpeedup !== undefined) {
    lines.push(`- Full-chain benchmark speedup: \`${data.benchmarkSpeedup}x\``);
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const logPath = process.argv[2];
  if (logPath === undefined) {
    console.error("usage: node scripts/summarize-webgpu.mjs <webgpu log file>");
    process.exit(1);
  }
  const logText = await readFile(resolve(process.cwd(), logPath), "utf8");
  const outcome = ciOutcome(logText);
  const summary = markdownSummary(logText);
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + "\n", "utf8");
  }
  console.log(summary);
  console.log(`summarize-webgpu: ${outcome.marker ?? "(no marker)"} -> exit ${outcome.exitCode} (${outcome.reason})`);
  process.exit(outcome.exitCode);
}

// Run as a CLI only when this file is the entry module; importing it from
// tests (ciOutcome / parseSummaryLines) must not read any file.
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  main().catch((error) => {
    console.error(`summarize-webgpu: failed: ${error}`);
    process.exit(1);
  });
}
