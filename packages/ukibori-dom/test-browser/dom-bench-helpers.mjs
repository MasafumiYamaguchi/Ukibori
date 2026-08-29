// #46 DOM benchmark helpers, extracted so the harness mechanics are unit
// testable without a browser: the bounded observer drain, the warmup/timed
// frame selection and the counter instrumentation (getBoundingClientRect /
// getComputedStyle) are pure enough to run under jsdom.

/**
 * Bounded observer drain: observers deliver on microtasks/tasks; each pass
 * waits once (the caller's `wait`), then flushes the scheduled renderer
 * callback. Loop until nothing was pending twice in a row (a render that
 * schedules nothing means the layer is quiescent), with a hard cap so a
 * broken harness cannot loop forever.
 *
 * With `skipIdleWait`, a scenario that produces NO event at all (e.g.
 * stable-page) skips the wait entirely when nothing is pending at the
 * start — the setTimeout(0) scheduler floor must not be billed as Ukibori
 * work. Returns the pass count and whether any wait happened.
 */
export async function drainLoop({ wait, hasPending, flush, maxPasses = 16, skipIdleWait = false }) {
  if (skipIdleWait && !hasPending()) {
    return { drained: true, passes: 0, waited: false };
  }
  for (let pass = 0; pass < maxPasses; pass++) {
    await wait();
    const wasPending = hasPending();
    flush();
    if (!wasPending) {
      return { drained: true, passes: pass + 1, waited: true };
    }
  }
  return { drained: false, passes: maxPasses, waited: true };
}

/**
 * Frame selection contract: time every frame, but only the last `samples`
 * frames enter the summary — the first `warmup` frames are warmup and are
 * never counted.
 */
export function selectTimedFrames(perFrame, warmup, samples) {
  const timed = perFrame.slice(warmup);
  return {
    timed,
    expectedSamples: samples,
    actualSamples: timed.length,
  };
}

/**
 * Frame-local timing decomposition: Ukibori work (the scheduled renderer
 * callbacks, `callbackHostMs`) vs the harness settle floor (the setTimeout
 * turns that let observers deliver, `settleWallMs`), summed into the total
 * scenario wall (`totalWallMs`). The settle floor is harness delay, never
 * renderer CPU work.
 */
export function decomposeFrameTiming({ triggerHostMs, callbackHostMs, settleWallMs, totalWallMs }) {
  return {
    callbackHostMs,
    settleWallMs,
    triggerHostMs,
    totalWallMs,
  };
}

/**
 * Benchmark-only counter instrumentation: wraps a function (e.g.
 * Element.prototype.getBoundingClientRect or window.getComputedStyle) to
 * count calls and accumulate wall time. Returns a restore function. The
 * marker property prevents double-wrapping across scenarios.
 */
export function installCounter(target, key, counter) {
  const desc = Object.getOwnPropertyDescriptor(target, key);
  if (desc === undefined || typeof desc.value !== "function") {
    return () => {};
  }
  if (desc.value.__ukiboriBench === true) {
    return () => {};
  }
  const original = desc.value;
  const wrapped = function (...args) {
    const t0 = performance.now();
    const result = original.apply(this, args);
    counter.ms += performance.now() - t0;
    counter.calls += 1;
    return result;
  };
  wrapped.__ukiboriBench = true;
  Object.defineProperty(target, key, { ...desc, value: wrapped });
  return () => {
    Object.defineProperty(target, key, { ...desc, value: original });
  };
}