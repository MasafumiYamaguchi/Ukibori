import { describe, expect, it } from "vitest";
import { createWebGpuBackend, isWebGpuSupported } from "./webgpu";

describe("WebGPU backend availability", () => {
  it("reports unsupported in Node (no navigator.gpu)", async () => {
    await expect(isWebGpuSupported()).resolves.toBe(false);
  });

  it("returns null backend when unsupported", async () => {
    await expect(createWebGpuBackend()).resolves.toBeNull();
  });
});
