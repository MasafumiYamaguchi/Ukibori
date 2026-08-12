import { afterEach, describe, expect, it } from "vitest";
import { WasmCpuBackend } from "./backend";
import { WasmNormalKernel } from "./kernel";
import { selectWasmBackend, resetWasmSelectionCache } from "./selection";
import { byteLength } from "../buffer";
import type { BufferSpec } from "../types";

/**
 * #33 WasmCpuBackend contract: it is a RenderBackend whose kind/capability
 * report states the WASM path, whose buffers behave exactly like CPU host
 * buffers, and whose disposal releases the kernel (idempotent).
 */

const SPEC: BufferSpec = { width: 4, height: 3, channels: 4, format: "u8" };

afterEach(() => {
  resetWasmSelectionCache();
});

describe("#33 WasmCpuBackend", () => {
  it("reports kind wasm with compute/readback/upload capabilities", async () => {
    const selection = await selectWasmBackend({ force: "wasm" }, "backend-cap");
    const backend = new WasmCpuBackend(selection.kernel!, selection);
    expect(backend.kind).toBe("wasm");
    expect(backend.capabilities).toEqual({
      backend: "wasm",
      compute: true,
      readback: true,
      upload: true,
    });
    // the selection evidence travels with the backend (stage + reason)
    expect(backend.selection.stage).toBe("normal");
    expect(backend.selection.fallbackReason).toBeNull();
  });

  it("createBuffer returns host buffers with write/read semantics", async () => {
    const selection = await selectWasmBackend({ force: "wasm" }, "backend-buffers");
    const backend = new WasmCpuBackend(selection.kernel!, selection);
    const buffer = await backend.createBuffer(SPEC);
    expect(buffer.spec).toEqual(SPEC);
    const bytes = new Uint8Array(byteLength(SPEC));
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = i % 251;
    }
    await buffer.writeBytes(bytes);
    const read = await buffer.readBytes();
    expect(Array.from(read)).toEqual(Array.from(bytes));
    buffer.dispose();
  });

  it("rejects new work after disposal (idempotent)", async () => {
    const selection = await selectWasmBackend({ force: "wasm" }, "backend-dispose");
    const backend = new WasmCpuBackend(selection.kernel!, selection);
    const kernel = backend.kernel;
    backend.dispose();
    backend.dispose(); // idempotent
    await expect(backend.createBuffer(SPEC)).rejects.toThrow(/disposed/);
    // the kernel itself is disposed too
    await expect(kernel.computeNormals(new Float32Array(4), 2, 2, {})).rejects.toThrow(/disposed/);
  });

  it("a disposed backend does not poison a fresh selection", async () => {
    const selection = await selectWasmBackend({ force: "wasm" }, "backend-poison");
    const backend = new WasmCpuBackend(selection.kernel!, selection);
    backend.dispose();
    const fresh = await selectWasmBackend({ force: "wasm" }, "backend-poison");
    expect(fresh.selected).toBe("wasm");
    expect(fresh.kernel).not.toBeNull();
  });
});
