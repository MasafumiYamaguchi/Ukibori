// #46 benchmark result document: a single versioned, machine-readable
// container shared by every suite (CPU, GPU, DOM).
//
// Schema contract:
//   {
//     "schemaVersion": 1,
//     "commit": "<git sha or 'unknown'>",
//     "generatedAt": "<ISO timestamp>",
//     "environment": { ... env metadata ... },
//     "cases": [
//       {
//         "id": "surface-scale/640x360/surfaces-128",
//         "parameters": { ... },
//         "metrics": { ... },
//         "notes": ["..."]   // optional
//       }
//     ]
//   }
//
// Timing honesty rule (#46 §1A/§23): a metric key may only be labeled
// `hostMs`, `gpuTimestampMs` or `wallMs` — never a bare `ms` when it could
// be confused with a GPU timestamp. `validateResultDocument` rejects any
// metric key that ENDS in `Ms` without one of the three canonical labels as
// its suffix (e.g. `shadowGpuTimestampMs` and `planningHostMs` are fine;
// `shadowMs` is not).

import { summarizeSeries } from "./stats.mjs";

export const BENCHMARK_SCHEMA_VERSION = 1;

const TIMING_KEY_RE = /Ms$/;
const CANONICAL_TIMING_SUFFIXES = ["hostMs", "gpuTimestampMs", "wallMs"];

function isCanonicalTimingKey(key) {
  const normalized = key.toLowerCase();
  return CANONICAL_TIMING_SUFFIXES.some((suffix) => normalized.endsWith(suffix.toLowerCase()));
}

export function createResultDocument({ environment, commit, cases = [], generatedAt }) {
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    commit: commit ?? "unknown",
    generatedAt: generatedAt ?? new Date().toISOString(),
    environment,
    cases,
  };
}

export function validateResultDocument(doc) {
  const problems = [];
  if (doc.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
    problems.push(
      `schemaVersion ${doc.schemaVersion} (expected ${BENCHMARK_SCHEMA_VERSION})`,
    );
  }
  if (typeof doc.commit !== "string" || doc.commit.length === 0) {
    problems.push("commit must be a non-empty string");
  }
  if (typeof doc.generatedAt !== "string" || doc.generatedAt.length === 0) {
    problems.push("generatedAt must be a non-empty string");
  }
  if (doc.environment === null || typeof doc.environment !== "object") {
    problems.push("environment must be an object");
  }
  if (!Array.isArray(doc.cases)) {
    problems.push("cases must be an array");
  } else {
    for (const [index, entry] of doc.cases.entries()) {
      if (typeof entry.id !== "string" || entry.id.length === 0) {
        problems.push(`cases[${index}].id must be a non-empty string`);
      }
      if (entry.parameters === null || typeof entry.parameters !== "object") {
        problems.push(`cases[${index}].parameters must be an object`);
      }
      if (entry.metrics === null || typeof entry.metrics !== "object") {
        problems.push(`cases[${index}].metrics must be an object`);
      } else {
        for (const key of Object.keys(entry.metrics)) {
          if (TIMING_KEY_RE.test(key) && !isCanonicalTimingKey(key)) {
            problems.push(
              `cases[${index}].metrics["${key}"] has no canonical timing suffix ` +
                `(${CANONICAL_TIMING_SUFFIXES.join("/")})`,
            );
          }
          const value = entry.metrics[key];
          if (typeof value === "number" && !Number.isFinite(value)) {
            problems.push(`cases[${index}].metrics["${key}"] is not finite (NaN/Infinity)`);
          }
        }
      }
    }
  }
  return problems;
}

export function collectTiming(series) {
  // series: { hostMs?: number[], gpuTimestampMs?: number[], wallMs?: number[] }
  const out = {};
  for (const [key, values] of Object.entries(series ?? {})) {
    if (!Array.isArray(values) || values.length === 0) {
      out[key] = null;
      continue;
    }
    out[key] = summarizeSeries(values);
  }
  return out;
}