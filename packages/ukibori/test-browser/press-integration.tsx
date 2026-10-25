import React, { useState } from "react";
import { flushSync } from "react-dom";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import * as Toggle from "@radix-ui/react-toggle";
import { Ukibori } from "../src/index";
import type { UkiboriBackend } from "../src/index";
import type { UkiboriDom } from "ukibori-dom";
import { assertRenderIdle, renderSerial } from "./render-activity";
import { PressSurface } from "../../../demo/src/interaction/PressSurface";
let layer: UkiboriDom | null = null, clicks = 0, config = { backend: "css" as UkiboriBackend, reducedMotion: false, disabled: false };
const errors: string[] = [];
const events: string[] = [];
document.addEventListener("keydown", event => events.push(`down:${event.key}:${event.defaultPrevented}`));
document.addEventListener("keyup", event => events.push(`up:${event.key}:${event.defaultPrevented}`));
const ready = (value: UkiboriDom | null) => { layer = value; };
function Example({ settings = config }: { settings?: typeof config }) {
  const [selected, setSelected] = useState(false);
  return <Ukibori backend={settings.backend} gpuProfiling highContrast={false} dpr={1} margin={4} onReady={ready}
    onError={error => errors.push(String(error))} style={{ position: "relative", width: 180, height: 100 }}>
    <Toggle.Root asChild pressed={selected} onPressedChange={setSelected} disabled={settings.disabled} aria-label="Toggle selection">
      <PressSurface selected={selected} reducedMotion={settings.reducedMotion} onClick={() => clicks++}
        style={{ position: "absolute", left: 20, top: 20, width: 100, height: 40, borderRadius: 8 }}>Toggle</PressSurface>
    </Toggle.Root>
  </Ukibori>;
}
const host = document.getElementById("root")!;
host.innerHTML = renderToString(<Example />);
const original = host.querySelector("button");
const root = hydrateRoot(host, <Example />, { onRecoverableError: error => errors.push(String(error)) });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const state = () => {
  const button = host.querySelector("button")!;
  const rect = button.getBoundingClientRect();
  const debug = layer?.debugState();
  const backend = debug?.backend ?? "css";
  return { progress: Number(button.dataset.progress), pressed: button.getAttribute("aria-pressed"), disabled: button.disabled,
    focused: document.activeElement === button, focusVisible: button.matches(":focus-visible"), clicks,
    sameNode: button === original, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
    backend, serial: renderSerial(debug, backend),
    errors: [...errors], events: [...events], hidden: document.hidden, documentFocused: document.hasFocus(), dirty: layer?.debugState().dirtyCount ?? 0 };
};
const frameSamples: unknown[] = [];
let observing = false, monitorFrame = 0, lastSerial = -1;
const timingTasks: Promise<unknown>[] = [];
function monitor() {
  if (!observing) return;
  if (layer) {
    const debug = layer.debugState();
    const serial = renderSerial(debug, debug.backend);
    if (serial !== lastSerial) {
      lastSerial = serial;
      const gpu = debug.gpuFrame;
      const row = { backend: debug.backend, renderHostMs: gpu?.hostRenderMs ?? debug.lastRenderMs,
        domMeasureHostMs: debug.lastMeasureMs, sceneBuildHostMs: debug.lastSceneBuildMs,
        dispatchCount: gpu?.frame.frame.dispatchCount ?? null, maskSdfPasses: gpu?.frame.height.maskSdfPasses ?? null,
        progress: state().progress, passGpuMs: null as unknown };
      frameSamples.push(row);
      if (gpu) timingTasks.push(gpu.frame.gpuTiming.then(timing => { row.passGpuMs = timing.status === "ok" ? timing.passGpuMs : null; }));
    }
  }
  monitorFrame = requestAnimationFrame(monitor);
}
const probe = {
  async prepare(backend: UkiboriBackend, reducedMotion = false, disabled = false) {
    observing = false; cancelAnimationFrame(monitorFrame);
    config = { backend, reducedMotion, disabled }; flushSync(() => root.render(<Example settings={config} />));
    const deadline = performance.now() + 20000;
    while (state().backend !== backend || (backend !== "css" && layer?.debugState().nodeCount !== 1)) {
      if (performance.now() > deadline) throw new Error(`backend timeout: ${JSON.stringify(state())}`);
      await delay(20);
    }
    await delay(200);
    lastSerial = layer ? renderSerial(layer.debugState(), backend) : -1;
    observing = true; monitorFrame = requestAnimationFrame(monitor);
    return state();
  }, state,
  async idle() { await delay(250); const a = state(); await delay(120); const b = state(); assertRenderIdle(a, b); return b; },
  cancel() { const button = host.querySelector("button")!; button.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1, isPrimary: true })); },
  async finish() {
    observing = false; cancelAnimationFrame(monitorFrame);
    const active = layer, before = state(); root.unmount(); await delay(200);
    await Promise.all(timingTasks);
    const afterSerial = renderSerial(active?.debugState(), before.backend);
    assertRenderIdle(before, { serial: afterSerial }, "render after unmount");
    return { before, afterSerial, errors, frameSamples };
  },
};
Object.assign(window, { pressProbe: probe });
document.getElementById("result")!.textContent = "READY";
