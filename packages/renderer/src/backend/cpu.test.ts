import { describe, expect, it } from "vitest";
import { CpuBackend } from "./cpu";
import { readElement } from "../buffer";

describe("CpuBackend", () => {
  it("reports CPU compute capabilities", () => {
    const backend = new CpuBackend();
    expect(backend.kind).toBe("cpu");
    expect(backend.capabilities).toEqual({
      backend: "cpu",
      compute: true,
      readback: true,
      upload: true,
    });
    backend.dispose();
  });

  it("creates buffers and roundtrips bytes", async () => {
    const backend = new CpuBackend();
    const spec = { width: 3, height: 2, channels: 2, format: "f32" } as const;
    const buf = await backend.createBuffer(spec);
    const bytes = new Uint8Array(3 * 2 * 2 * 4);
    const view = new DataView(bytes.buffer);
    view.setFloat32(0, 0.25, true);
    view.setFloat32(8, 1.5, true);
    await buf.writeBytes(bytes);
    const out = await buf.readBytes();
    expect(out.byteLength).toBe(bytes.byteLength);
    expect(new DataView(out.buffer).getFloat32(0, true)).toBe(0.25);
    expect(readElement(out, spec, 1, 0, 0)).toBe(1.5);
    buf.dispose();
    backend.dispose();
  });
});
