// #46 DOM benchmark helper unit tests (jsdom): drain termination, warmup/
// timed frame selection, and the counter instrumentation contract.
import { describe, expect, it } from "vitest";
import { drainLoop, selectTimedFrames, installCounter } from "./dom-bench-helpers.mjs";

describe("drainLoop", () => {
  it("terminates when nothing is pending", async () => {
    const outcome = await drainLoop({
      wait: () => Promise.resolve(),
      hasPending: () => false,
      flush: () => {},
    });
    expect(outcome.drained).toBe(true);
    expect(outcome.passes).toBe(1);
    expect(outcome.waited).toBe(true);
  });

  it("skipIdleWait skips the wait entirely when nothing is pending", async () => {
    const outcome = await drainLoop({
      wait: () => Promise.resolve(),
      hasPending: () => false,
      flush: () => {},
      skipIdleWait: true,
    });
    expect(outcome.drained).toBe(true);
    expect(outcome.passes).toBe(0);
    expect(outcome.waited).toBe(false);
  });

  it("keeps draining while work keeps being scheduled", async () => {
    let scheduled = 3;
    const outcome = await drainLoop({
      wait: () => Promise.resolve(),
      hasPending: () => scheduled > 0,
      flush: () => {
        scheduled -= 1;
      },
    });
    expect(outcome.drained).toBe(true);
    expect(outcome.passes).toBe(4);
  });

  it("terminates at the cap instead of looping forever", async () => {
    const outcome = await drainLoop({
      wait: () => Promise.resolve(),
      hasPending: () => true, // never quiescent
      flush: () => {},
      maxPasses: 5,
    });
    expect(outcome.drained).toBe(false);
    expect(outcome.passes).toBe(5);
  });

  it("flushes before deciding the next pass", async () => {
    const flushed = [];
    let pending = true;
    await drainLoop({
      wait: () => Promise.resolve(),
      hasPending: () => pending,
      flush: () => {
        flushed.push("flush");
        pending = false;
      },
    });
    // pass 1 sees pending and flushes; pass 2 sees nothing pending and
    // flushes once more before returning — the loop always flushes the
    // final scheduled callback before quiescence is decided
    expect(flushed.length).toBe(2);
  });
});

describe("selectTimedFrames", () => {
  it("excludes the warmup frames from the timed set", () => {
    const perFrame = Array.from({ length: 25 }, (_, i) => i);
    const { timed, actualSamples } = selectTimedFrames(perFrame, 5, 20);
    expect(actualSamples).toBe(20);
    expect(timed[0]).toBe(5);
    expect(timed[timed.length - 1]).toBe(24);
  });

  it("reports a shortfall when fewer frames than samples were recorded", () => {
    const { timed, actualSamples, expectedSamples } = selectTimedFrames([1, 2, 3], 5, 20);
    expect(actualSamples).toBe(0);
    expect(expectedSamples).toBe(20);
    expect(timed).toEqual([]);
  });
});

describe("installCounter", () => {
  it("counts calls and accumulates wall time on window.getComputedStyle", () => {
    // jsdom does not define getComputedStyle as an OWN property of window;
    // real browsers do. Emulate the browser shape before instrumenting.
    Object.defineProperty(window, "getComputedStyle", {
      value: window.getComputedStyle.bind(window),
      writable: true,
      configurable: true,
    });
    const counter = { calls: 0, ms: 0 };
    const restore = installCounter(window, "getComputedStyle", counter);
    try {
      getComputedStyle(document.body);
      getComputedStyle(document.body);
      expect(counter.calls).toBe(2);
    } finally {
      restore();
    }
    // restore removes the wrapper: counting stops
    const after = counter.calls;
    getComputedStyle(document.body);
    expect(counter.calls).toBe(after);
  });

  it("does not double-wrap an already instrumented function", () => {
    Object.defineProperty(window, "getComputedStyle", {
      value: window.getComputedStyle.bind(window),
      writable: true,
      configurable: true,
    });
    const counter = { calls: 0, ms: 0 };
    const restoreA = installCounter(window, "getComputedStyle", counter);
    const restoreB = installCounter(window, "getComputedStyle", counter);
    try {
      getComputedStyle(document.body);
      expect(counter.calls).toBe(1);
    } finally {
      restoreA();
      restoreB(); // second restore is a no-op-safe double restore
    }
  });

  it("counts Element.prototype.getBoundingClientRect calls", () => {
    const counter = { calls: 0, ms: 0 };
    const restore = installCounter(Element.prototype, "getBoundingClientRect", counter);
    try {
      document.createElement("div").getBoundingClientRect();
      expect(counter.calls).toBe(1);
    } finally {
      restore();
    }
  });
});