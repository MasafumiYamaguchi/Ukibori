import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  COLOR_SPEC,
  HEIGHT_SPEC,
  createRenderer,
  isWebGpuSupported,
  readBufferData,
  toRgbaBytes,
} from "ukibori-renderer";
import type { RgbaImage } from "ukibori-renderer";

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

export function RendererDebug(): ReactElement {
  const heightCanvas = useRef<HTMLCanvasElement>(null);
  const colorCanvas = useRef<HTMLCanvasElement>(null);
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
            <h2>Test pattern (CPU path, buffer readback → RGBA)</h2>
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
              (toRgbaBytes) → canvas. The SDF/height/normal/shadow pipeline is implemented by
              the renderer issues (#13+).
            </p>
          </section>
        </>
      )}
    </main>
  );
}
