import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  COLOR_SPEC,
  HEIGHT_SPEC,
  composeSdfHeightField,
  createRenderer,
  createScene,
  generateSdfDebug,
  isWebGpuSupported,
  lightScene,
  marchShadowRay,
  readBufferData,
  sampleLine,
  toCategoryRgba,
  toRgbaBytes,
} from "ukibori-renderer";
import type { BufferData, RgbaImage, ShadowMarchSample } from "ukibori-renderer";

interface Status {
  webgpu: boolean;
  backend: string;
  compute: boolean;
  readback: boolean;
  upload: boolean;
}

function draw(canvas: HTMLCanvasElement | null, image: RgbaImage): void {
  if (!canvas) {
    return;
  }
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
}

function drawLineGraph(
  canvas: HTMLCanvasElement | null,
  data: BufferData,
  min: number,
  max: number,
): void {
  if (!canvas) {
    return;
  }
  const { width, height } = data.spec;
  const samples = sampleLine(data, 0, Math.floor(height / 2), width - 1, Math.floor(height / 2), width);
  canvas.width = width;
  canvas.height = 120;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  const pad = 8;
  const span = max - min;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#99a";
  ctx.beginPath();
  for (let x = 0; x <= canvas.width; x += 16) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, canvas.height);
  }
  ctx.stroke();
  ctx.strokeStyle = "#236";
  ctx.beginPath();
  samples.forEach((s, i) => {
    const px = pad + (i / (samples.length - 1)) * (canvas.width - pad * 2);
    const py = pad + (1 - (s.value - min) / span) * (canvas.height - pad * 2);
    if (i === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  });
  ctx.stroke();
}

function drawRayPlot(canvas: HTMLCanvasElement | null, samples: ShadowMarchSample[], receiverZ: number): void {
  if (!canvas) {
    return;
  }
  canvas.width = 320;
  canvas.height = 150;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  const pad = 12;
  const tMax = Math.max(samples[samples.length - 1]?.t ?? 1, 1);
  let zMax = receiverZ;
  for (const s of samples) {
    zMax = Math.max(zMax, s.height, s.rayZ);
  }
  const span = Math.max(zMax, 1);
  const px = (t: number) => pad + (t / tMax) * (canvas.width - pad * 2);
  const py = (z: number) => pad + (1 - z / span) * (canvas.height - pad * 2);

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#99a";
  ctx.beginPath();
  for (let x = 0; x <= canvas.width; x += 32) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, canvas.height);
  }
  ctx.stroke();

  // height samples along the ray (gray)
  ctx.strokeStyle = "#888";
  ctx.beginPath();
  samples.forEach((s, i) => {
    if (i === 0) {
      ctx.moveTo(px(s.t), py(s.height));
    } else {
      ctx.lineTo(px(s.t), py(s.height));
    }
  });
  ctx.stroke();

  // ray z (blue)
  ctx.strokeStyle = "#1a5fb4";
  ctx.beginPath();
  ctx.moveTo(px(0), py(receiverZ));
  for (const s of samples) {
    ctx.lineTo(px(s.t), py(s.rayZ));
  }
  ctx.stroke();

  // receiver (green) and blocking sample (red)
  ctx.fillStyle = "#26a269";
  ctx.beginPath();
  ctx.arc(px(0), py(receiverZ), 3, 0, Math.PI * 2);
  ctx.fill();
  const blocking = samples.find((s) => s.occluded);
  if (blocking) {
    ctx.fillStyle = "#e01b24";
    ctx.beginPath();
    ctx.arc(px(blocking.t), py(blocking.rayZ), 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px(blocking.t), py(blocking.height), 4, 0, Math.PI * 2);
    ctx.strokeStyle = "#e01b24";
    ctx.stroke();
  }
}

const SDF_SCENE = {
  width: 96,
  height: 60,
  surfaces: [
    {
      id: "button",
      position: { x: 18, y: 10 },
      size: { x: 60, y: 40 },
      // elevation 0: standalone smooth-profile PoC — the bevel rises
      // continuously from the base plane to the plateau (raised surfaces
      // with a side wall belong to the multi-surface scene, #18).
      elevation: 0,
      thickness: 2,
      bevelWidth: 4,
      shape: { kind: "roundedRect", radius: 10 } as const,
      profile: { kind: "bevel" } as const,
      material: "silicone",
      castsShadow: true,
      receivesShadow: true,
    },
  ],
  materials: {
    // identical baseColor/metallic/ior — only roughness differs
    "custom-glossy": { baseColor: { r: 0.6, g: 0.6, b: 0.6 }, roughness: 0.12, metallic: 0, ior: 1.5 },
    "custom-rough": { baseColor: { r: 0.6, g: 0.6, b: 0.6 }, roughness: 0.9, metallic: 0, ior: 1.5 },
    // identical baseColor/roughness/ior — only metallic differs
    "custom-dielectric": { baseColor: { r: 0.6, g: 0.6, b: 0.6 }, roughness: 0.4, metallic: 0, ior: 1.5 },
    "custom-metallic": { baseColor: { r: 0.6, g: 0.6, b: 0.6 }, roughness: 0.4, metallic: 1, ior: 1.5 },
  },
  light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1 },
};

const SHADOW_SCENE = {
  width: 96,
  height: 60,
  surfaces: [
    {
      // Raised button (top z = 4 + 2) casting a hard shadow on the base plane.
      id: "button",
      position: { x: 30, y: 8 },
      size: { x: 36, y: 44 },
      elevation: 4,
      thickness: 2,
      bevelWidth: 3,
      shape: { kind: "roundedRect", radius: 8 } as const,
      profile: { kind: "bevel" } as const,
      material: "silicone",
      castsShadow: true,
      receivesShadow: true,
    },
  ],
  light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1 },
};

const MULTI_SCENE = {
  width: 96,
  height: 60,
  surfaces: [
    // three layers: panel (base) <- button <- badge
    {
      id: "panel",
      position: { x: 6, y: 4 },
      size: { x: 84, y: 52 },
      elevation: 0,
      thickness: 0,
      shape: { kind: "roundedRect", radius: 8 } as const,
      profile: { kind: "flat" } as const,
      material: "matte",
      castsShadow: true,
      receivesShadow: true,
    },
    {
      id: "button",
      position: { x: 30, y: 14 },
      size: { x: 36, y: 32 },
      elevation: 4,
      thickness: 2,
      bevelWidth: 3,
      shape: { kind: "roundedRect", radius: 8 } as const,
      profile: { kind: "bevel" } as const,
      material: "silicone",
      castsShadow: true,
      receivesShadow: true,
    },
    {
      id: "badge",
      position: { x: 54, y: 26 },
      size: { x: 10, y: 8 },
      elevation: 8,
      thickness: 2,
      bevelWidth: 1,
      shape: { kind: "roundedRect", radius: 3 } as const,
      profile: { kind: "bevel" } as const,
      material: "metal",
      castsShadow: true,
      receivesShadow: true,
    },
  ],
  light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1 },
};

export function RendererDebug(): ReactElement {
  const heightCanvas = useRef<HTMLCanvasElement>(null);
  const colorCanvas = useRef<HTMLCanvasElement>(null);
  const sdfCanvas = useRef<HTMLCanvasElement>(null);
  const maskCanvas = useRef<HTMLCanvasElement>(null);
  const geometryHeightCanvas = useRef<HTMLCanvasElement>(null);
  const crossSectionCanvas = useRef<HTMLCanvasElement>(null);
  const normalCanvas = useRef<HTMLCanvasElement>(null);
  const diffuseCanvas = useRef<HTMLCanvasElement>(null);
  const specularCanvas = useRef<HTMLCanvasElement>(null);
  const litColorCanvas = useRef<HTMLCanvasElement>(null);
  const siliconeCanvas = useRef<HTMLCanvasElement>(null);
  const matteCanvas = useRef<HTMLCanvasElement>(null);
  const metalCanvas = useRef<HTMLCanvasElement>(null);
  const glossyCanvas = useRef<HTMLCanvasElement>(null);
  const roughCanvas = useRef<HTMLCanvasElement>(null);
  const dielectricCanvas = useRef<HTMLCanvasElement>(null);
  const metallicCanvas = useRef<HTMLCanvasElement>(null);
  const shadowHeightCanvas = useRef<HTMLCanvasElement>(null);
  const shadowMaskCanvas = useRef<HTMLCanvasElement>(null);
  const shadowColorCanvas = useRef<HTMLCanvasElement>(null);
  const shadowRayCanvas = useRef<HTMLCanvasElement>(null);
  const multiHeightCanvas = useRef<HTMLCanvasElement>(null);
  const multiObjectCanvas = useRef<HTMLCanvasElement>(null);
  const multiMaterialCanvas = useRef<HTMLCanvasElement>(null);
  const multiMaskCanvas = useRef<HTMLCanvasElement>(null);
  const multiColorCanvas = useRef<HTMLCanvasElement>(null);
  const [rayInfo, setRayInfo] = useState<{ x: number; y: number; occluded: boolean } | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [light, setLight] = useState({ x: -0.6, y: -0.8 });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const webgpu = await isWebGpuSupported();
        const { renderer, capabilities } = await createRenderer({});
        const height = await renderer.ensureTarget("height", HEIGHT_SPEC(96, 60));
        const color = await renderer.ensureTarget("color", COLOR_SPEC(96, 60));
        await renderer.renderTestPattern();
        if (cancelled) {
          renderer.dispose();
          return;
        }
        draw(heightCanvas.current, toRgbaBytes(await readBufferData(height)));
        draw(colorCanvas.current, toRgbaBytes(await readBufferData(color)));
        setStatus({
          webgpu,
          backend: capabilities.backend,
          compute: capabilities.compute,
          readback: capabilities.readback,
          upload: capabilities.upload,
        });
        renderer.dispose();

        // Issue #14: analytic rounded-rectangle SDF -> height field.
        const scene = createScene(SDF_SCENE);
        const { sdf, mask, height: geoHeight } = generateSdfDebug(scene);
        const sdfData = await readBufferData(sdf);
        const maskData = await readBufferData(mask);
        const geoData = await readBufferData(geoHeight);
        if (cancelled) {
          return;
        }
        draw(sdfCanvas.current, toRgbaBytes(sdfData, { min: -4, max: 4 }));
        draw(maskCanvas.current, toRgbaBytes(maskData));
        draw(geometryHeightCanvas.current, toRgbaBytes(geoData, { min: 0, max: 3 }));
        drawLineGraph(crossSectionCanvas.current, geoData, 0, 3);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const scene = createScene({ ...SDF_SCENE, light: { direction: { x: light.x, y: light.y, z: 1 }, intensity: 1 } });
    const { normal, diffuse, specular, color } = lightScene(scene);
    void (async () => {
      const normalImg = toRgbaBytes(await readBufferData(normal));
      const diffuseImg = toRgbaBytes(await readBufferData(diffuse), { min: 0, max: 1 });
      const specularImg = toRgbaBytes(await readBufferData(specular), { min: 0, max: 1 });
      const colorImg = toRgbaBytes(await readBufferData(color));
      draw(normalCanvas.current, normalImg);
      draw(diffuseCanvas.current, diffuseImg);
      draw(specularCanvas.current, specularImg);
      draw(litColorCanvas.current, colorImg);
      // #16: identical geometry/light; only material parameters differ
      const comparisons = [
        ["roughness low (0.12)", "custom-glossy", glossyCanvas],
        ["roughness high (0.9)", "custom-rough", roughCanvas],
        ["metallic 0", "custom-dielectric", dielectricCanvas],
        ["metallic 1", "custom-metallic", metallicCanvas],
        ["silicone", "silicone", siliconeCanvas],
        ["matte", "matte", matteCanvas],
        ["metal", "metal", metalCanvas],
      ] as const;
      for (const [, ref, canvas] of comparisons) {
        const presetScene = createScene({
          ...SDF_SCENE,
          surfaces: [{ ...SDF_SCENE.surfaces[0], material: ref }],
          light: { direction: { x: light.x, y: light.y, z: 1 }, intensity: 1 },
        });
        const presetColor = lightScene(presetScene).color;
        draw(canvas.current, toRgbaBytes(await readBufferData(presetColor)));
      }
    })();
  }, [light.x, light.y]);

  useEffect(() => {
    const scene = createScene({
      ...SHADOW_SCENE,
      light: { direction: { x: light.x, y: light.y, z: 1 }, intensity: 1 },
    });
    const { height, visibility, color } = lightScene(scene);
    void (async () => {
      draw(shadowHeightCanvas.current, toRgbaBytes(await readBufferData(height), { min: 0, max: 6 }));
      draw(shadowMaskCanvas.current, toRgbaBytes(await readBufferData(visibility!), { min: 0, max: 1 }));
      draw(shadowColorCanvas.current, toRgbaBytes(await readBufferData(color)));
      // ray debug: receiver = first shadowed pixel on the center row
      const row = Math.floor(shadowMaskCanvas.current ? 60 / 2 : 30);
      let rx = -1;
      for (let x = 0; x < 96; x++) {
        if (visibility!.get(x, row, 0) === 0) {
          rx = x;
          break;
        }
      }
      if (rx >= 0) {
        const samples = marchShadowRay(scene, height, rx + 0.5, row + 0.5);
        const receiverZ = height.get(rx, row, 0);
        drawRayPlot(shadowRayCanvas.current, samples, receiverZ);
        setRayInfo({ x: rx, y: row, occluded: samples.some((s) => s.occluded) });
      } else {
        setRayInfo(null);
      }
    })();
  }, [light.x, light.y]);

  useEffect(() => {
    const scene = createScene({
      ...MULTI_SCENE,
      light: { direction: { x: light.x, y: light.y, z: 1 }, intensity: 1 },
    });
    const composed = composeSdfHeightField(scene);
    const { visibility, color } = lightScene(scene);
    void (async () => {
      draw(multiHeightCanvas.current, toRgbaBytes(await readBufferData(composed.height), { min: 0, max: 10 }));
      draw(multiObjectCanvas.current, toCategoryRgba(await readBufferData(composed.objectId)));
      draw(multiMaterialCanvas.current, toCategoryRgba(await readBufferData(composed.materialId)));
      draw(multiMaskCanvas.current, toRgbaBytes(await readBufferData(visibility!), { min: 0, max: 1 }));
      draw(multiColorCanvas.current, toRgbaBytes(await readBufferData(color)));
    })();
  }, [light.x, light.y]);

  return (
    <main>
      <h1>Ukibori renderer debug</h1>
      {error !== null ? (
        <p style={{ color: "#a11" }}>Error: {error}</p>
      ) : (
        <>
          <section>
            <h2>Capabilities</h2>
            {status === null ? (
              <p>initializing…</p>
            ) : (
              <p>
                <span className="badge">WebGPU supported: {String(status.webgpu)}</span>
                <span className="badge">backend: {status.backend}</span>
                <span className="badge">compute: {String(status.compute)}</span>
                <span className="badge">readback: {String(status.readback)}</span>
                <span className="badge">upload: {String(status.upload)}</span>
              </p>
            )}
          </section>
          <section>
            <h2>Geometry #14 — SDF → height field</h2>
            <div className="row">
              <div>
                <p>signed distance ([-4, +4] grayscale)</p>
                <canvas ref={sdfCanvas} width={96} height={60} />
              </div>
              <div>
                <p>shape mask</p>
                <canvas ref={maskCanvas} width={96} height={60} />
              </div>
              <div>
                <p>height / bump map ([0, 3])</p>
                <canvas ref={geometryHeightCanvas} width={96} height={60} />
              </div>
            </div>
            <p>Height cross-section through the surface center (0 → 3)</p>
            <canvas ref={crossSectionCanvas} width={96} height={120} />
            <p>
              SDF (inside negative / boundary zero / outside positive) → bevel profile →
              elevation + local height. All buffers are real intermediate data, not CSS.
            </p>
          </section>
          <section>
            <h2>Lighting #15 — normals and shared-light shading</h2>
            <p>
              light x:{" "}
              <input
                type="range"
                min={-1}
                max={1}
                step={0.05}
                value={light.x}
                onChange={(e) => setLight((l) => ({ ...l, x: Number(e.target.value) }))}
              />
              light y:{" "}
              <input
                type="range"
                min={-1}
                max={1}
                step={0.05}
                value={light.y}
                onChange={(e) => setLight((l) => ({ ...l, y: Number(e.target.value) }))}
              />
            </p>
            <div className="row">
              <div>
                <p>normal (xyz → rgb)</p>
                <canvas ref={normalCanvas} width={96} height={60} />
              </div>
              <div>
                <p>diffuse only (N·L)</p>
                <canvas ref={diffuseCanvas} width={96} height={60} />
              </div>
              <div>
                <p>specular only</p>
                <canvas ref={specularCanvas} width={96} height={60} />
              </div>
              <div>
                <p>combined shading</p>
                <canvas ref={litColorCanvas} width={96} height={60} />
              </div>
            </div>
            <p>
              Move the light and watch the highlight slide continuously across the bevel —
              it is driven by the height-gradient normals, not a CSS offset.
            </p>
          </section>
          <section>
            <h2>Materials #16 — BRDF comparisons (same geometry and light)</h2>
            <p>Roughness (only roughness differs)</p>
            <div className="row">
              <div>
                <p>low 0.12</p>
                <canvas ref={glossyCanvas} width={96} height={60} />
              </div>
              <div>
                <p>high 0.9</p>
                <canvas ref={roughCanvas} width={96} height={60} />
              </div>
            </div>
            <p>Metallic workflow (only metallic differs)</p>
            <div className="row">
              <div>
                <p>metallic 0</p>
                <canvas ref={dielectricCanvas} width={96} height={60} />
              </div>
              <div>
                <p>metallic 1</p>
                <canvas ref={metallicCanvas} width={96} height={60} />
              </div>
            </div>
            <p>Presets</p>
            <div className="row">
              <div>
                <p>silicone</p>
                <canvas ref={siliconeCanvas} width={96} height={60} />
              </div>
              <div>
                <p>matte</p>
                <canvas ref={matteCanvas} width={96} height={60} />
              </div>
              <div>
                <p>metal</p>
                <canvas ref={metalCanvas} width={96} height={60} />
              </div>
            </div>
            <p>
              Cook-Torrance (GGX/Smith/Schlick) with the metallic workflow: dielectric F0 from
              IOR, metal uses baseColor as F0 with no diffuse term.
            </p>
          </section>
          <section>
            <h2>Cast shadows #17 — height-field ray traversal</h2>
            <div className="row">
              <div>
                <p>height (two-level: button on base)</p>
                <canvas ref={shadowHeightCanvas} width={96} height={60} />
              </div>
              <div>
                <p>shadow visibility mask (hard, 0/1)</p>
                <canvas ref={shadowMaskCanvas} width={96} height={60} />
              </div>
              <div>
                <p>combined shading with cast shadow</p>
                <canvas ref={shadowColorCanvas} width={96} height={60} />
              </div>
            </div>
            <p>
              Rays march from each pixel toward the light over the height field — the button
              casts its shadow on the base plane through real visibility tests, not a CSS
              offset/blur. Move the light sliders to see the shadow slide.
            </p>
            <p>
              Ray debug — receiver at the first shadowed pixel
              {rayInfo !== null ? ` (${rayInfo.x}, ${rayInfo.y})` : " (no shadow in the center row)"}
              , occluded: {rayInfo === null ? "n/a" : String(rayInfo.occluded)} — green = receiver,
              blue = ray z, gray = height samples, red = blocking sample
            </p>
            <canvas ref={shadowRayCanvas} width={320} height={150} />
          </section>
          <section>
            <h2>Scene #18 — three layers in one height field</h2>
            <div className="row">
              <div>
                <p>composed height (panel 0 / button 6 / badge 10)</p>
                <canvas ref={multiHeightCanvas} width={96} height={60} />
              </div>
              <div>
                <p>object ownership (per surface)</p>
                <canvas ref={multiObjectCanvas} width={96} height={60} />
              </div>
              <div>
                <p>material ownership</p>
                <canvas ref={multiMaterialCanvas} width={96} height={60} />
              </div>
            </div>
            <div className="row">
              <div>
                <p>shadow visibility mask</p>
                <canvas ref={multiMaskCanvas} width={96} height={60} />
              </div>
              <div>
                <p>final color (button + badge cast onto lower layers)</p>
                <canvas ref={multiColorCanvas} width={96} height={60} />
              </div>
            </div>
            <p>
              The badge (z=10) and button (z=6) share the panel's height field and cast hard
              shadows onto the layers below through the same light/material pipeline.
            </p>
          </section>
          <section>
            <h2>Verification loop (backend write → readback → RGBA)</h2>
            <div className="row">
              <div>
                <p>height (f32 x ramp → grayscale)</p>
                <canvas ref={heightCanvas} width={96} height={60} />
              </div>
              <div>
                <p>color (RGBA8 checkerboard)</p>
                <canvas ref={colorCanvas} width={96} height={60} />
              </div>
            </div>
            <p>
              This page proves the verification loop: backend write → readback → debug export
              (toRgbaBytes) → canvas. Geometry (#14) and lighting (#15) are implemented; cast
              shadows arrive in the shadow issue (#17).
            </p>
          </section>
        </>
      )}
    </main>
  );
}
