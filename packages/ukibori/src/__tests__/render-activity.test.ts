import { describe, expect, it } from "vitest";
import { assertRenderIdle, renderSerial } from "../../test-browser/render-activity";

describe("press browser render activity assertions", () => {
  it("rejects CPU redraws while the GPU counter stays unchanged", () => {
    const before = { gpuRenderSerial: 0, sceneBuildSerial: 7 };
    const after = { ...before, sceneBuildSerial: 8 };
    expect(() => assertRenderIdle(
      { backend: "cpu", serial: renderSerial(before, "cpu") },
      { serial: renderSerial(after, "cpu") },
    )).toThrow("cpu did not settle: 7 -> 8");
  });

  it("rejects GPU submissions while the scene counter stays unchanged", () => {
    const before = { gpuRenderSerial: 7, sceneBuildSerial: 4 };
    const after = { ...before, gpuRenderSerial: 8 };
    expect(() => assertRenderIdle(
      { backend: "webgpu", serial: renderSerial(before, "webgpu") },
      { serial: renderSerial(after, "webgpu") },
    )).toThrow("webgpu did not settle: 7 -> 8");
  });

  it.each(["cpu", "webgpu"])("accepts unchanged %s render counters", backend => {
    const debug = { gpuRenderSerial: 2, sceneBuildSerial: 7 };
    expect(() => assertRenderIdle(
      { backend, serial: renderSerial(debug, backend) },
      { serial: renderSerial({ ...debug }, backend) },
    )).not.toThrow();
  });
});
