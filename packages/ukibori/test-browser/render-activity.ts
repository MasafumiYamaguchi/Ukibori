import type { DomDebugState } from "ukibori-dom";

type RenderCounters = Pick<DomDebugState, "gpuRenderSerial" | "sceneBuildSerial">;

// Keep the chosen backend when checking a disposed layer: dispose releases
// the GPU pipeline, so debugState().backend can change after unmount.
export function renderSerial(debug: RenderCounters | null | undefined, backend: string): number {
  return (backend === "webgpu" ? debug?.gpuRenderSerial : debug?.sceneBuildSerial) ?? 0;
}

export function assertRenderIdle(before: { backend: string; serial: number }, after: { serial: number }, message = "did not settle"): void {
  if (before.serial !== after.serial) {
    throw new Error(`${before.backend} ${message}: ${before.serial} -> ${after.serial}`);
  }
}
