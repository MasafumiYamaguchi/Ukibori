import { act } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Surface, Ukibori } from "../index";

/**
 * Static scenes stay idle (#21): after the initial render and any one-time
 * layout change, scheduling stops — no continuous React/RAF render loop.
 */

const flushAsync = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe("static scene settling", () => {
  it("stops scheduling after mount settles", async () => {
    let scheduled = 0;
    const { unmount } = render(
      <Ukibori
        schedule={(cb) => {
          scheduled++;
          cb();
        }}
      >
        <Surface id="a" elevation={2} thickness={1}>
          A
        </Surface>
        <Surface id="b" elevation={4} thickness={2}>
          B
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    const afterSettle = scheduled;
    expect(afterSettle).toBeGreaterThan(0);
    // No external changes: scheduling must stop.
    await flushAsync();
    await flushAsync();
    expect(scheduled).toBe(afterSettle);
    unmount();
  });

  it("settles again after a one-time prop update", async () => {
    let scheduled = 0;
    const { rerender } = render(
      <Ukibori
        schedule={(cb) => {
          scheduled++;
          cb();
        }}
      >
        <Surface id="a" elevation={2} thickness={1}>
          A
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    const afterMount = scheduled;

    rerender(
      <Ukibori
        schedule={(cb) => {
          scheduled++;
          cb();
        }}
      >
        <Surface id="a" elevation={8} thickness={2}>
          A
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    const afterUpdate = scheduled;
    expect(afterUpdate).toBeGreaterThan(afterMount);

    await flushAsync();
    await flushAsync();
    expect(scheduled).toBe(afterUpdate);
  });
});
