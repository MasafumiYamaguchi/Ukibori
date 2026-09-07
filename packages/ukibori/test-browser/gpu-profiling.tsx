import React from "react";
import { createRoot } from "react-dom/client";
import { Surface, Ukibori } from "../src/index";
import type { UkiboriDom } from "ukibori-dom";

const result = document.getElementById("result")!;
const requiredPasses = ["shadow", "reconstruction", "lighting", "presentation"] as const;

function finish(marker: string, detail: unknown) {
  result.textContent = `${marker}\n${JSON.stringify(detail, null, 2)}`;
}

async function waitForTimings(layer: UkiboriDom, afterSerial = -1) {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    const state = layer.debugState();
    const frame = state.gpuFrame;
    const timing = frame?.gpuTiming;
    if (
      state.gpuRenderSerial > afterSerial &&
      timing?.status === "ok" &&
      requiredPasses.every((pass) => Number.isFinite(timing.passGpuMs[pass]))
    ) {
      return timing;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `timed out waiting for resolved per-pass GPU timestamps: ${JSON.stringify(layer.debugState().gpuFrame)}`,
  );
}

function ProfilingDemo() {
  return (
    <Ukibori
      backend="webgpu"
      gpuProfiling
      angularRadius={0.12}
      shadow={{ samples: 8, reconstruction: { radius: 2 } }}
      dpr={1}
      style={{ position: "relative", width: 480, height: 320 }}
      onReady={(layer) => {
        if (layer === null) return;
        void (async () => {
          const timing = await waitForTimings(layer);
          const serial = layer.debugState().gpuRenderSerial;
          finish("UKIBORI_REACT_GPU_PROFILING_PASS", {
            gpuRenderSerial: serial,
            passGpuMs: timing.passGpuMs,
          });
        })().catch((error) => finish("UKIBORI_REACT_GPU_PROFILING_FAIL", String(error)));
      }}
      onError={(error) => finish("UKIBORI_REACT_GPU_PROFILING_FAIL", String(error))}
    >
      <Surface sceneId="profiled-card" elevation={8} thickness={3} style={{ width: 220, height: 120 }}>
        GPU profiling
      </Surface>
    </Ukibori>
  );
}

createRoot(document.getElementById("root")!).render(<ProfilingDemo />);
