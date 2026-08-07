import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  COLOR_SPEC,
  HEIGHT_SPEC,
  createRenderer,
  createScene,
  generateSdfDebug,
  isWebGpuSupported,
  readBufferData,
  sampleLine,
  toRgbaBytes,
} from "ukibori-renderer";
import type { BufferData, RgbaImage } from "ukibori-renderer";

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

const SDF_SCENE = {
  width: 96,
  height: 60,
  surfaces: [
    {
      id: "button",
      position: { x: 18, y: 10 },
      size: { x: 60, y: 40 },
      elevation: 6,
      thickness: 2,
      bevelWidth: 4,
      shape: { kind: "roundedRect", radius: 10 } as const,
      profile: { kind: "bevel" } as const,
      material: "silicone",
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
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        draw(geometryHeightCanvas.current, toRgbaBytes(geoData, { min: 0, max: 8 }));
        drawLineGraph(crossSectionCanvas.current, geoData, 0, 8);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
                <p>height / bump map ([0, 8])</p>
                <canvas ref={geometryHeightCanvas} width={96} height={60} />
              </div>
            </div>
            <p>Height cross-section through the surface center (0 → 8)</p>
            <canvas ref={crossSectionCanvas} width={96} height={120} />
            <p>
              SDF (inside negative / boundary zero / outside positive) → bevel profile →
              elevation + local height. All buffers are real intermediate data, not CSS.
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
              (toRgbaBytes) → canvas.
            </p>
          </section>
        </>
      )}
    </main>
  );
}
