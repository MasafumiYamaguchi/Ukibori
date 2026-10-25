import { act } from "react";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSurfaceProgress } from "../index";

let frames: Map<number, FrameRequestCallback>, serial: number, time: number;
function step(ms: number) {
  time += ms;
  const callbacks = [...frames.values()]; frames.clear();
  act(() => { callbacks.forEach(callback => callback(time)); });
}
beforeEach(() => {
  frames = new Map(); serial = 0; time = 0;
  vi.spyOn(performance, "now").mockImplementation(() => time);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++serial, callback); return serial; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("opt-in surface progress", () => {
  it("renders intermediate press/release frames then becomes idle", () => {
    const hook = renderHook(({ target }) => useSurfaceProgress(target, { durationMs: 100, reducedMotion: false }), { initialProps: { target: 0 } });
    expect(frames.size).toBe(0);
    hook.rerender({ target: 1 });
    step(25); expect(hook.result.current).toBeGreaterThan(0); expect(hook.result.current).toBeLessThan(1);
    const pressed = hook.result.current;
    hook.rerender({ target: 0 });
    expect(frames.size).toBe(1);
    step(25); expect(hook.result.current).toBeLessThan(pressed); expect(hook.result.current).toBeGreaterThan(0);
    step(75); expect(hook.result.current).toBe(0); expect(frames.size).toBe(0);
    hook.rerender({ target: 0.375 }); step(100);
    expect(hook.result.current).toBe(0.375); expect(frames.size).toBe(0);
  });
  it("cancels on unmount and ignores a late browser callback", () => {
    const hook = renderHook(({ target }) => useSurfaceProgress(target, { reducedMotion: false }), { initialProps: { target: 0 } });
    hook.rerender({ target: 1 });
    const late = [...frames.values()][0]; hook.unmount();
    expect(frames.size).toBe(0); late(200); expect(frames.size).toBe(0);
  });
  it("snaps for reduced motion and zero duration", () => {
    const hook = renderHook(({ target, durationMs, reducedMotion }) => useSurfaceProgress(target, { durationMs, reducedMotion }), {
      initialProps: { target: 0, durationMs: 100, reducedMotion: true },
    });
    hook.rerender({ target: 1, durationMs: 100, reducedMotion: true }); expect(hook.result.current).toBe(1);
    hook.rerender({ target: 0.375, durationMs: 0, reducedMotion: false }); expect(hook.result.current).toBe(0.375);
    expect(frames.size).toBe(0);
  });
  it("follows live OS preferences and releases its listener", () => {
    const media = new EventTarget() as EventTarget & { matches: boolean };
    media.matches = false;
    const remove = vi.spyOn(media, "removeEventListener");
    vi.stubGlobal("matchMedia", () => media);
    const hook = renderHook(({ target }) => useSurfaceProgress(target), { initialProps: { target: 0 } });
    hook.rerender({ target: 1 }); step(20);
    act(() => { media.matches = true; media.dispatchEvent(new Event("change")); });
    expect(hook.result.current).toBe(1); expect(frames.size).toBe(0);
    hook.unmount(); expect(remove).toHaveBeenCalledTimes(1);
  });
});
