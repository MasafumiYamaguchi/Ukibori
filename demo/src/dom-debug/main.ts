import { UkiboriDom } from "ukibori-dom";
import type { BufferData, HostBuffer } from "ukibori-renderer";
import { toCategoryRgba, toRgbaBytes } from "ukibori-renderer";

/**
 * #20 demo: a real DOM button + text stage whose physical layer is rendered
 * by Ukibori onto a pointer-events:none overlay. No React — this exercises
 * the framework-agnostic DOM integration layer directly.
 */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---- DOM ----
const panel = $<HTMLDivElement>("panel");
const button = $<HTMLButtonElement>("play");
const icon = $<HTMLSpanElement>("icon");
const badge = $<HTMLDivElement>("badge");
const label = $<HTMLSpanElement>("play-label");
const statusEl = $<HTMLDivElement>("status");

// Surface page-level failures in the status line for the debug page.
window.addEventListener("error", (event) => {
  statusEl.textContent = `page error: ${event.message}`;
});
window.addEventListener("unhandledrejection", (event) => {
  statusEl.textContent = `unhandled rejection: ${String(event.reason)}`;
});

// ---- mask rasterization stays app-side (#19 contract) ----
function maskFromIcon(
  draw: (ctx: CanvasRenderingContext2D, size: number) => void,
  size: number,
): { width: number; height: number; alpha: Float32Array } {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("canvas 2d unavailable");
  }
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = "#fff";
  draw(ctx, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  const alpha = new Float32Array(size * size);
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = data[i * 4 + 3] / 255;
  }
  return { width: size, height: size, alpha };
}

// Play triangle (28x28) — the icon participates in the physical scene as a
// mask relief while the button's own label stays plain DOM text.
const PLAY_MASK = maskFromIcon((ctx, size) => {
  const u = size / 4;
  ctx.beginPath();
  ctx.moveTo(u * 1.35, u);
  ctx.lineTo(u * 3.6, u * 2);
  ctx.lineTo(u * 1.35, u * 3);
  ctx.closePath();
  ctx.fill();
}, 28);

function bufferData(buffer: HostBuffer): BufferData {
  return {
    spec: buffer.spec,
    bytes: new Uint8Array(buffer.data.buffer, buffer.data.byteOffset, buffer.data.byteLength),
  };
}

function drawToCanvas(
  canvas: HTMLCanvasElement,
  image: { width: number; height: number; data: Uint8ClampedArray },
): void {
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    return;
  }
  ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
}

// ---- layer ----
let buttonState = { elevation: 7, thickness: 2.5, radius: 12 };

const stage = $<HTMLElement>("stage");

const layer = new UkiboriDom({
  light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1 },
  margin: 48,
  dpr: 1,
  shadow: { bias: 0.5 },
  // The stage is the opaque container that wraps the surfaces: the overlay
  // canvas is inserted inside it so it paints above the stage's background
  // (isolation: isolate) but below the surfaces' own content.
  overlay: { stage },
  schedule: (cb) =>
    requestAnimationFrame(() => {
      cb();
      refreshDebug();
    }),
  onError: (error) => {
    console.error(error);
    statusEl.textContent = `render error: ${error instanceof Error ? error.message : String(error)}`;
  },
});

function iconOptions() {
  return {
    id: "icon",
    shape: { kind: "mask", mask: PLAY_MASK } as const,
    elevation: buttonState.elevation + buttonState.thickness,
    thickness: 1,
    bevelWidth: 1.1,
    material: "metal",
  };
}

function badgeOptions() {
  return {
    id: "badge",
    shape: { kind: "roundedRect", radius: 999 } as const,
    elevation: 13,
    thickness: 1.5,
    bevelWidth: 2,
    material: "metal",
  };
}

// Panel (base layer), button (raised surface, real DOM <button>), icon (mask
// relief on the button top). The button casts onto the panel; the panel onto
// the page base plane (#18 multi-surface semantics).
layer.register(panel, {
  id: "panel",
  shape: { kind: "roundedRect", radius: 18 },
  elevation: 0,
  thickness: 3,
  bevelWidth: 5,
  material: "matte",
});
layer.register(button, {
  id: "play",
  shape: { kind: "roundedRect", radius: buttonState.radius },
  elevation: buttonState.elevation,
  thickness: buttonState.thickness,
  bevelWidth: 3.5,
  material: "silicone",
});
layer.register(icon, iconOptions());

// ---- controls ----
const two = (value: number) => value.toFixed(2);

function bindSlider(
  id: string,
  onInput: (value: number) => void,
  format: (value: number) => string = (v) => String(v),
): void {
  const input = $(id) as HTMLInputElement;
  const output = $(`o-${id}`);
  const sync = () => {
    output.textContent = format(Number(input.value));
    onInput(Number(input.value));
  };
  input.addEventListener("input", sync);
  sync();
}

const light = { x: -0.6, y: -0.8, z: 1 };
bindSlider("lx", (v) => {
  light.x = v;
  layer.setLight({ ...light });
}, two);
bindSlider("ly", (v) => {
  light.y = v;
  layer.setLight({ ...light });
}, two);
bindSlider("lz", (v) => {
  light.z = v;
  layer.setLight({ ...light });
}, two);
bindSlider("intensity", (v) => layer.setIntensity(v), two);
bindSlider("elevation", (v) => {
  buttonState.elevation = v;
  applyButtonOptions();
});
bindSlider("thickness", (v) => {
  buttonState.thickness = v;
  applyButtonOptions();
});
bindSlider("radius", (v) => {
  buttonState.radius = v;
  applyButtonOptions();
});
bindSlider("bias", (v) => layer.setShadow({ bias: v }), two);

function applyButtonOptions(): void {
  layer.updateSurface("play", {
    shape: { kind: "roundedRect", radius: buttonState.radius },
    elevation: buttonState.elevation,
    thickness: buttonState.thickness,
  });
  // The icon relief sits on the button top, so it follows the button's top z.
  layer.updateSurface("icon", { elevation: buttonState.elevation + buttonState.thickness });
}

$<HTMLSelectElement>("dpr").addEventListener("change", (event) => {
  layer.setDpr(Number((event.target as HTMLSelectElement).value));
});
$<HTMLSelectElement>("material").addEventListener("change", (event) => {
  const material = (event.target as HTMLSelectElement).value;
  for (const id of ["panel", "play", "icon", "badge"]) {
    if (layer.registry.has(id)) {
      layer.updateSurface(id, { material });
    }
  }
});

// Mount / unmount: the retained scene node is added/removed.
$<HTMLButtonElement>("toggle-icon").addEventListener("click", () => {
  if (layer.registry.has("icon")) {
    layer.unregister("icon");
  } else {
    layer.register(icon, iconOptions());
  }
});
$<HTMLButtonElement>("toggle-badge").addEventListener("click", () => {
  if (layer.registry.has("badge")) {
    layer.unregister("badge");
    badge.hidden = true;
  } else {
    badge.hidden = false;
    layer.register(badge, badgeOptions());
  }
});

// The DOM button stays interactive: click, focus and ARIA remain DOM-owned.
button.addEventListener("click", () => {
  label.textContent = "Clicked — still a DOM button ✓";
  window.setTimeout(() => {
    label.textContent = "Press me — real DOM button";
  }, 1200);
});

// ---- debug views ----
function refreshDebug(): void {
  const buffers = layer.debugBuffers();
  const objectId = layer.debugObjectId();
  const state = layer.debugState();
  if (buffers !== null) {
    drawToCanvas($("buf-height"), toRgbaBytes(bufferData(buffers.height), { min: 0, max: 16 }));
    if (objectId !== null) {
      drawToCanvas($("buf-object"), toCategoryRgba(bufferData(objectId)));
    }
    drawToCanvas(
      $("buf-vis"),
      toRgbaBytes(bufferData(buffers.visibility ?? buffers.height), { min: 0, max: 1 }),
    );
    drawToCanvas($("buf-color"), toRgbaBytes(bufferData(buffers.color)));
  }
  const region = state.region === null
    ? "empty"
    : `(${state.region.x.toFixed(0)}, ${state.region.y.toFixed(0)}) ${state.region.w.toFixed(0)}x${state.region.h.toFixed(0)}`;
  statusEl.textContent =
    `region ${region} · dpr ${state.dpr} · target ${state.renderSize?.width ?? "-"}x${state.renderSize?.height ?? "-"} · ` +
    `render ${state.lastRenderMs.toFixed(1)}ms · nodes ${state.nodeCount} · dirty ${state.dirtyCount}`;
}
