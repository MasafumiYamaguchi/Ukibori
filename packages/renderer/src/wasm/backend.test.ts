import { afterEach, describe, expect, it } from "vitest";
import { WasmCpuBackend } from "./backend";
import { WasmNormalKernel, resetKernelLoadCache } from "./kernel";
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
  resetKernelLoadCache();
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
    fresh.kernel!.dispose();
  });

  it("ownership regression: two backends, dispose one, the other stays usable", async () => {
    const [s1, s2] = await Promise.all([
      selectWasmBackend({ force: "wasm" }, "backend-owners"),
      selectWasmBackend({ force: "wasm" }, "backend-owners"),
    ]);
    const first = new WasmCpuBackend(s1.kernel!, s1);
    const second = new WasmCpuBackend(s2.kernel!, s2);
    expect(first.kernel).not.toBe(second.kernel);
    // both create usable buffers concurrently
    const b1 = await first.createBuffer(SPEC);
    const b2 = await second.createBuffer(SPEC);
    expect(b1.spec).toEqual(SPEC);
    expect(b2.spec).toEqual(SPEC);
    // disposing the first backend must not invalidate the second
    first.dispose();
    const bytes = new Uint8Array(byteLength(SPEC));
    await b2.writeBytes(bytes);
    await expect(first.createBuffer(SPEC)).rejects.toThrow(/disposed/);
    second.dispose();
    // all owners disposed -> a fresh selection reloads and works
    const fresh = await selectWasmBackend({ force: "wasm" }, "backend-owners");
    const backend = new WasmCpuBackend(fresh.kernel!, fresh);
    const b3 = await backend.createBuffer(SPEC);
    expect(b3.spec).toEqual(SPEC);
    backend.dispose();
  });
});
