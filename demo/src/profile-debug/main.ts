import { createScene, lightScene, toRgbaBytes } from "ukibori-renderer";
import type { HeightProfile, Shape } from "ukibori-renderer";
import { rasterizeSvgPath } from "ukibori-dom";
import { createProfileComparisonScene, PROFILE_PRESETS } from "../../../packages/renderer/src/profile-fixture";
import { evaluateProfile } from "../../../packages/renderer/src/profile";

const shapeInput = document.querySelector<HTMLSelectElement>("#shape")!;
const lightInput = document.querySelector<HTMLInputElement>("#light")!;
const powerInput = document.querySelector<HTMLInputElement>("#power")!;
const colors = ["#202a44", "#b86b00", "#087d73", "#7155c8", "#ca4763", "#285bd7", "#8b521f"];

function selectedShape(): Shape {
  if (shapeInput.value === "mask") {
    const alpha = new Uint8Array(56 * 56);
    for (let y = 0; y < 56; y++) for (let x = 0; x < 56; x++) {
      if ((x >= 14 && x < 42) || (y >= 14 && y < 42)) alpha[y * 56 + x] = 255;
    }
    return { kind: "mask", mask: { width: 56, height: 56, alpha } };
  }
  if (shapeInput.value === "svg") {
    const points = Array.from({ length: 48 }, (_, i) => {
      const radius = i % 4 < 2 ? 27 : 22;
      const angle = i / 48 * Math.PI * 2;
      return `${i === 0 ? "M" : "L"}${28 + radius * Math.cos(angle)},${28 + radius * Math.sin(angle)}`;
    }).join(" ") + " Z";
    return { kind: "mask", mask: rasterizeSvgPath({ kind: "svgPath", d: points, viewBox: [0, 0, 56, 56] }, 56, 56) };
  }
  return { kind: "roundedRect", radius: 8 };
}

function renderFields() {
  const started = performance.now();
  try {
    const source = createProfileComparisonScene(selectedShape());
    const scene = createScene({ ...source, light: { ...source.light, direction: { x: Number(lightInput.value), y: -0.4, z: 1 } } });
    const buffers = lightScene(scene);
    const fields = document.querySelector("#fields")!;
    fields.replaceChildren();
    for (const [name, buffer] of [["Lighting", buffers.color], ["Height", buffers.height], ["Normals", buffers.normal], ["Visibility", buffers.visibility]] as const) {
      if (buffer === undefined) continue;
      const figure = document.createElement("figure");
      const heading = document.createElement("h2"); heading.textContent = name;
      const labels = document.createElement("div"); labels.className = "labels";
      PROFILE_PRESETS.forEach((kind) => { const span = document.createElement("span"); span.textContent = kind; labels.append(span); });
      const canvas = document.createElement("canvas");
      const rgba = toRgbaBytes({ spec: buffer.spec, bytes: new Uint8Array(buffer.data.buffer, buffer.data.byteOffset, buffer.data.byteLength) });
      canvas.width = rgba.width; canvas.height = rgba.height;
      canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(rgba.data), rgba.width, rgba.height), 0, 0);
      figure.append(heading, labels, canvas); fields.append(figure);
    }
    document.querySelector("#error")!.textContent = "";
    document.querySelector("#status")!.textContent = `CPU reference · ${(performance.now() - started).toFixed(0)} ms`;
  } catch (error) { document.querySelector("#error")!.textContent = String(error); }
}

function renderGraph() {
  const exponent = Number(powerInput.value);
  document.querySelector("#power-value")!.textContent = String(exponent);
  const profiles: HeightProfile[] = [...PROFILE_PRESETS.map((kind) => ({ kind })),
    { kind: "power", exponent }, { kind: "power", exponent, bias: "out" }];
  const names = [...PROFILE_PRESETS, "power in", "power out"];
  const canvas = document.querySelector<HTMLCanvasElement>("#graph")!;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = "12px system-ui";
  ctx.strokeStyle = "#d4d9df"; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    ctx.beginPath(); ctx.moveTo(40 + i * 140, 20); ctx.lineTo(40 + i * 140, 210); ctx.stroke();
    ctx.fillStyle = "#444"; ctx.fillText(String(i / 4), 35 + i * 140, 230);
  }
  profiles.forEach((profile, index) => {
    ctx.strokeStyle = colors[index]; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i <= 200; i++) {
      const x = 40 + i / 200 * 560, y = 210 - evaluateProfile(profile, -i / 200, 1, 1) * 190;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.fillStyle = colors[index]; ctx.fillText(names[index], 615, 32 + index * 26);
  });
  const table = document.createElement("table");
  const header = table.insertRow(); ["Curve", "0", "0.25", "0.5", "0.75", "1"].forEach((s) => { const th = document.createElement("th"); th.textContent = s; header.append(th); });
  profiles.forEach((profile, i) => {
    const row = table.insertRow(); row.insertCell().textContent = names[i];
    for (const t of [0, 0.25, 0.5, 0.75, 1]) row.insertCell().textContent = evaluateProfile(profile, -t, 1, 1).toFixed(4);
  });
  document.querySelector("#samples")!.replaceChildren(table);
}

shapeInput.addEventListener("change", renderFields);
lightInput.addEventListener("change", renderFields);
powerInput.addEventListener("input", renderGraph);
renderFields(); renderGraph();
