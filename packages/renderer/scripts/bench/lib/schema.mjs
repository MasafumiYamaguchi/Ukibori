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
// Timing honesty rule (#46 #1A/#23): a metric key may only be labeled
// `hostMs`, `gpuTimestampMs` or `wallMs` - never a bare `ms` when it could
// be confused with a GPU timestamp. `validateResultDocument` rejects any
// metric key that ENDS in `Ms` without one of the three canonical labels as
// its suffix (e.g. `shadowGpuTimestampMs` and `planningHostMs` are fine;
// `shadowMs` is not).
//
// Recursive validation: every NUMBER anywhere under `metrics` (nested
// summaries, arrays, arbitrary containers) must be finite; `null` is
// explicitly allowed (unsupported timing etc.); NaN/Infinity are rejected
// with a path so JSON.stringify cannot silently null them.

import { summarizeSeries } from "./stats.mjs";

export const BENCHMARK_SCHEMA_VERSION = 1;

const TIMING_KEY_RE = /Ms$/;
const CANONICAL_TIMING_SUFFIXES = ["hostMs", "gpuTimestampMs", "wallMs"];
const SUMMARY_KEYS = ["samples", "median", "p95", "min", "max"];

function isCanonicalTimingKey(key) {
  const normalized = key.toLowerCase();
  return CANONICAL_TIMING_SUFFIXES.some((suffix) => normalized.endsWith(suffix.toLowerCase()));
}

/** Recursive finite-number scan with a path for error reporting. */
function scanNumbers(value, path, problems) {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      problems.push(`${path} is not finite (${value})`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanNumbers(entry, `${path}[${index}]`, problems));
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      scanNumbers(entry, `${path}.${key}`, problems);
    }
  }
}

function validateSummary(entry, path, problems) {
  if (entry === null || entry === undefined) {
    return; // null timing is explicit and allowed
  }
  if (typeof entry !== "object" || Array.isArray(entry)) {
    problems.push(`${path} must be an object summary or null`);
    return;
  }
  for (const key of SUMMARY_KEYS) {
    if (!(key in entry)) {
      problems.push(`${path}.${key} is missing`);
    }
  }
  if ("samples" in entry && (typeof entry.samples !== "number" || !Number.isInteger(entry.samples) || entry.samples < 0)) {
    problems.push(`${path}.samples must be a non-negative integer`);
  }
  for (const key of ["median", "p95", "min", "max"]) {
    if (key in entry && entry[key] !== null && typeof entry[key] !== "number") {
      problems.push(`${path}.${key} must be a number or null`);
    }
  }
  scanNumbers(entry, path, problems);
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
        for (const [key, value] of Object.entries(entry.metrics)) {
          const path = `cases[${index}].metrics.${key}`;
          if (TIMING_KEY_RE.test(key) && !isCanonicalTimingKey(key)) {
            problems.push(
              `${path} has no canonical timing suffix ` +
                `(${CANONICAL_TIMING_SUFFIXES.join("/")})`,
            );
          }
          if (isCanonicalTimingKey(key)) {
            validateSummary(value, path, problems);
          } else {
            scanNumbers(value, path, problems);
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