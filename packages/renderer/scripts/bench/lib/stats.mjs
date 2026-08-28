// #46 shared benchmark statistics: median/p95/min/max over warmed samples.
//
// Every timing series in the suite flows through `summarizeSeries`, which
// always reports the sample count and the four required quantiles so a
// single-shot value can never be mistaken for a distribution.

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

export function summarizeSeries(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    median: sorted.length === 0 ? null : percentile(sorted, 0.5),
    p95: sorted.length === 0 ? null : percentile(sorted, 0.95),
    min: sorted.length === 0 ? null : sorted[0],
    max: sorted.length === 0 ? null : sorted[sorted.length - 1],
  };
}

export function formatMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "n/a";
  return `${ms.toFixed(3)}ms`;
}