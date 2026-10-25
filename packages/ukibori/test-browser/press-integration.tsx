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
let layer: UkiboriDom | null = null, clicks = 0, config = { backend: "css" as UkiboriBackend, reducedMotion: false, disabled: false, effects: false };
// Test-only capability controls; never installed in the library or demo.
const params = new URLSearchParams(location.search);
let capturedDevice: GPUDevice | null = null;
if (params.has("no-gpu")) Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
else if (params.has("loss") && navigator.gpu) {
  const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
  navigator.gpu.requestAdapter = async options => {
    const adapter = await requestAdapter(options);
    if (adapter) {
      const requestDevice = adapter.requestDevice.bind(adapter);
      adapter.requestDevice = async descriptor => { capturedDevice = await requestDevice(descriptor); return capturedDevice; };
    }
    return adapter;
  };
}
const errors: string[] = [];
const events: string[] = [];
document.addEventListener("keydown", event => events.push(`down:${event.key}:${event.defaultPrevented}`));
document.addEventListener("keyup", event => events.push(`up:${event.key}:${event.defaultPrevented}`));
window.addEventListener("blur", () => events.push("window:blur"));
const ready = (value: UkiboriDom | null) => { layer = value; };
function Example({ settings = config }: { settings?: typeof config }) {
  const [selected, setSelected] = useState(false);
  return <Ukibori backend={settings.backend} gpuProfiling highContrast={false} dpr={1} margin={4} onReady={ready}
    angularRadius={0} shadow={{ samples: 1, maxDistance: 48 }}
    materials={{ silicone: { baseColor: { r: 0.4, g: 0.44, b: 0.5 }, roughness: 0.5, metallic: 0,
      grain: params.has("grain") ? { scale: 3, strength: 0.6, seed: 42 } : undefined,
      emissive: settings.effects ? { r: 0.25, g: 0.08, b: 0.01 } : undefined } }}
    compositing={{ emissive: settings.effects ? { bloom: { intensity: 0.5, radius: 8 } } : undefined }}
    onError={error => errors.push(String(error))} style={{ position: "relative", width: 180, height: 100 }}>
    <Toggle.Root asChild pressed={selected} onPressedChange={setSelected} disabled={settings.disabled} aria-label="Toggle selection">
      <PressSurface selected={selected} reducedMotion={settings.reducedMotion}
        onKeyDown={event => events.push(`button:down:${event.key}:${settings.disabled}`)}
        onKeyUp={event => events.push(`button:up:${event.key}:${settings.disabled}`)}
        onBlur={() => events.push("button:blur")}
        onPointerDown={event => events.push(`pointer:down:${event.pointerType}:${event.isPrimary}:${event.button}`)}
        onPointerCancel={() => events.push("pointer:cancel")} onClick={() => clicks++}
        style={{ position: "absolute", left: 20, top: 20, width: 100, height: 40, borderRadius: 8 }}>Toggle</PressSurface>
    </Toggle.Root>
  </Ukibori>;
}
const host = document.getElementById("root")!;
host.innerHTML = renderToString(<Example />);
const original = host.querySelector("button");
const root = hydrateRoot(host, <Example />, { onRecoverableError: error => errors.push(String(error)), onUncaughtError: error => errors.push(`uncaught: ${String(error)}`) });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const state = () => {
  const button = host.querySelector("button");
  if (!button) throw new Error(`missing button; errors=${JSON.stringify(errors)}; host=${host.outerHTML}; events=${JSON.stringify(events.slice(-20))}`);
  const rect = button.getBoundingClientRect();
  const debug = layer?.debugState();
  const backend = debug?.backend ?? "css";
  return { progress: Number(button.dataset.progress), pressed: button.getAttribute("aria-pressed"), disabled: button.disabled,
    focused: document.activeElement === button, focusVisible: button.matches(":focus-visible"), clicks,
    sameNode: button === original, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
    backend, grainEnabled: params.has("grain"), serial: renderSerial(debug, backend), renderSize: debug?.renderSize ?? null, fallbackReason: debug?.gpuFallbackReason ?? null,
    errors: [...errors], events: [...events], hidden: document.hidden, documentFocused: document.hasFocus(), dirty: layer?.debugState().dirtyCount ?? 0 };
};
const frameSamples: unknown[] = [];
let observing = false, monitorFrame = 0, lastSerial = -1, lastMeasureSerial = -1, lastBuildSerial = -1;
const timingTasks: Promise<unknown>[] = [];
function monitor() {
  if (!observing) return;
  if (layer) {
    const debug = layer.debugState();
    const serial = renderSerial(debug, debug.backend);
    if (serial !== lastSerial) {
      lastSerial = serial;
      const gpu = debug.gpuFrame;
      const row = { backend: debug.backend, effects: config.effects, renderSize: debug.renderSize, renderHostMs: gpu?.hostRenderMs ?? debug.lastRenderMs,
        domMeasureHostMs: debug.measureSerial > lastMeasureSerial ? debug.lastMeasureMs : 0,
        sceneBuildHostMs: debug.sceneBuildSerial > lastBuildSerial ? debug.lastSceneBuildMs : 0,
        dispatchCount: gpu?.frame.frame.dispatchCount ?? null, maskSdfPasses: gpu?.frame.height.maskSdfPasses ?? null,
        progress: state().progress, passGpuMs: null as unknown };
      lastMeasureSerial = debug.measureSerial; lastBuildSerial = debug.sceneBuildSerial;
      frameSamples.push(row);
      if (gpu) timingTasks.push(gpu.frame.gpuTiming.then(timing => { row.passGpuMs = timing.status === "ok" ? timing.passGpuMs : null; }));
    }
  }
  monitorFrame = requestAnimationFrame(monitor);
}
const probe = {
  token: crypto.randomUUID(),
  async prepare(backend: UkiboriBackend, reducedMotion = false, disabled = false, effects = false, expectedBackend = backend) {
    observing = false; cancelAnimationFrame(monitorFrame);
    config = { backend, reducedMotion, disabled, effects }; flushSync(() => root.render(<Example settings={config} />));
    const deadline = performance.now() + 20000;
    while (state().backend !== expectedBackend || (backend !== "css" && layer?.debugState().nodeCount !== 1)) {
      if (performance.now() > deadline) throw new Error(`backend timeout: ${JSON.stringify(state())}`);
      await delay(20);
    }
    await delay(200);
    lastSerial = layer ? renderSerial(layer.debugState(), backend) : -1;
    lastMeasureSerial = layer?.debugState().measureSerial ?? -1;
    lastBuildSerial = layer?.debugState().sceneBuildSerial ?? -1;
    observing = true; monitorFrame = requestAnimationFrame(monitor);
    return state();
  }, state,
  async samples() { await Promise.all(timingTasks); return frameSamples; },
  async environment() {
    const adapter = await navigator.gpu?.requestAdapter();
    return { userAgent: navigator.userAgent, platform: navigator.platform, viewport: [innerWidth, innerHeight], dpr: 1,
      cssStage: [180, 100], button: [100, 40], margin: 4, angularRadius: 0,
      shadow: { samples: 1, maxDistance: 48 }, bloom: { intensity: 0.5, radius: 8 },
      adapter: adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description } : null };
  },
  async loseDevice() {
    if (!capturedDevice) throw new Error("test did not capture a real GPU device");
    capturedDevice.destroy(); await capturedDevice.lost;
    const deadline = performance.now() + 20000;
    while (layer?.debugState().backend !== "cpu" || layer.debugState().dirtyCount !== 0) {
      if (performance.now() > deadline) throw new Error("device loss did not settle on CPU");
      await delay(20);
    }
    return state();
  },
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
