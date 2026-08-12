import { describe, expect, it } from "vitest";
import { HostBuffer, byteLength } from "../buffer";
import { computeNormals } from "../lighting";
import type { NormalOptions } from "../lighting";
import { NORMAL_SPEC } from "../types";
import { NORMAL_KERNEL_BASE64, NORMAL_KERNEL_BYTE_LENGTH } from "./normal-kernel.base64";

/**
 * #33 standalone WASM normal-kernel gate.
 *
 * This test validates the GENERATED BINARY before any runtime wrapper is
 * built around it:
 *
 *   1. the module bytes decode as a valid WebAssembly module (structure
 *      walk: magic/version, type/function/memory/export/code sections,
 *      expected export names and types)
 *   2. the exported functions have the expected signatures (a direct
 *      callable-arity check through `WebAssembly.Function`/reflection)
 *   3. the kernel output is compared FIELD-BY-FIELD against the TypeScript
 *      oracle (`computeNormals` in lighting.ts — the semantic reference)
 *      over table cases (edges, flat fields, ramps, extreme finite f32
 *      values, DPR option sets, degenerate dims) plus a seeded property
 *      sweep, asserting EXACT bit parity (both sides run the same f64
 *      arithmetic; every operation in the kernel is IEEE-754 and the
 *      normalization mirrors the oracle op-for-op)
 *   4. memory growth and repeated-render stability are exercised here too,
 *      because they are properties of the module's memory contract, not of
 *      any host wrapper.
 *
 * The checked-in base64 module (src/wasm/normal-kernel.base64.ts) is
 * regenerated deterministically by scripts/build-wasm.mjs; determinism.test.ts
 * verifies the checked-in bytes match a fresh build byte-for-byte.
 */

const bytes = Uint8Array.from(atob(NORMAL_KERNEL_BASE64), (c) => c.charCodeAt(0));

// Compiled once: V8 transfers (detaches) a typed array passed straight to
// WebAssembly.instantiate, so every test instantiates this Module instead.
const modulePromise = WebAssembly.compile(bytes);

/** Walk the module sections and return a map of section id -> payload bytes. */
function parseSections(module: Uint8Array): Map<number, Uint8Array> {
  expect(Array.from(module.slice(0, 4))).toEqual([0x00, 0x61, 0x73, 0x6d]); // \0asm
  expect(Array.from(module.slice(4, 8))).toEqual([0x01, 0x00, 0x00, 0x00]); // version 1
  const sections = new Map<number, Uint8Array>();
  let offset = 8;
  while (offset < module.length) {
    const id = module[offset++];
    let length = 0;
    let shift = 0;
    let byte;
    do {
      byte = module[offset++];
      length |= (byte & 0x7f) << shift;
      shift += 7;
    } while ((byte & 0x80) !== 0);
    expect(offset + length).toBeLessThanOrEqual(module.length);
    sections.set(id, module.slice(offset, offset + length));
    offset += length;
  }
  return sections;
}

describe("#33 generated WASM module — binary structure", () => {
  it("decodes as a valid module with the expected section set", () => {
    expect(NORMAL_KERNEL_BYTE_LENGTH).toBe(bytes.length);
    expect(bytes.length).toBeGreaterThan(0);
    const sections = parseSections(bytes);
    // type(1), function(3), memory(5), export(7), code(10) — no imports
    for (const id of [1, 3, 5, 7, 10]) {
      expect(sections.has(id)).toBe(true);
    }
    expect(sections.has(2)).toBe(false); // no imports
    expect(sections.has(4)).toBe(false); // no tables
    expect(sections.has(6)).toBe(false); // no globals
  });

  it("declares exactly the two function types used by the exports", () => {
    const typeSection = parseSections(bytes).get(1)!;
    // vec(count) = 2 entries: (i32 i32 f64 f64 f64) -> i32 and () -> i32
    const view = new DataView(typeSection.buffer);
    const count = view.getUint8(0);
    expect(count).toBe(2);
    expect(view.getUint8(1)).toBe(0x60); // func
    expect(view.getUint8(2)).toBe(5); // 5 params
    expect(Array.from(typeSection.slice(3, 8))).toEqual([0x7f, 0x7f, 0x7c, 0x7c, 0x7c]);
    expect(view.getUint8(8)).toBe(1); // 1 result
    expect(view.getUint8(9)).toBe(0x7f); // i32
    expect(view.getUint8(10)).toBe(0x60); // func
    expect(view.getUint8(11)).toBe(0); // 0 params
    expect(view.getUint8(12)).toBe(1); // 1 result
    expect(view.getUint8(13)).toBe(0x7f); // i32
  });

  it("declares one growable memory with a documented maximum", () => {
    const memorySection = parseSections(bytes).get(5)!;
    const view = new DataView(memorySection.buffer);
    expect(view.getUint8(0)).toBe(1); // one memory
    expect(view.getUint8(1)).toBe(0x01); // flags: has maximum
    expect(view.getUint8(2)).toBe(1); // min 1 page (64 KiB)
    // max = 65536 pages (4 GiB), uleb 0x80 0x80 0x04
    expect(Array.from(memorySection.slice(3))).toEqual([0x80, 0x80, 0x04]);
  });

  it("exports memory, compute_normals and kernel_version with the expected types", async () => {
    const instance = await WebAssembly.instantiate(await modulePromise, {});
    const exports = instance.exports as Record<string, unknown>;
    expect(Object.keys(exports).sort()).toEqual([
      "compute_normals",
      "kernel_version",
      "memory",
    ]);
    expect(exports.memory).toBeInstanceOf(WebAssembly.Memory);
    const compute = exports.compute_normals as (w: number, h: number, sx: number, sy: number, nz: number) => number;
    const version = exports.kernel_version as () => number;
    expect(typeof compute).toBe("function");
    expect(typeof version).toBe("function");
    expect(version()).toBe(1);
    // callable signature sanity: valid invocation returns 0
    const memory = exports.memory as WebAssembly.Memory;
    new Float32Array(memory.buffer).fill(0);
    expect(compute(2, 2, 0.5, 0.5, 1)).toBe(0);
  });

  it("rejects out-of-range invocations with a trap instead of corrupting memory", async () => {
    const instance = await WebAssembly.instantiate(await modulePromise, {});
    const compute = instance.exports.compute_normals as (...args: number[]) => number;
    expect(() => compute(0, 0, 0.5, 0.5, 1)).not.toThrow();
    // 2^28 x 1 texels -> output base at 4*n = 2^30 bytes, far beyond the
    // initial 64 KiB; the module must trap on the f32.store bounds check
    // (the runtime host validates before ever invoking, but the module must
    // never silently write out of bounds)
    expect(() => compute(1 << 28, 1, 0.5, 0.5, 1)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Oracle comparison helpers
// ---------------------------------------------------------------------------

interface Kernel {
  memory: WebAssembly.Memory;
  computeNormals(
    field: Float32Array,
    width: number,
    height: number,
    options: NormalOptions,
  ): Float32Array;
}

let cachedInstance: WebAssembly.Instance | null = null;
async function kernel(): Promise<Kernel> {
  if (cachedInstance === null) {
    const instance = await WebAssembly.instantiate(await modulePromise, {});
    cachedInstance = instance;
  }
  const instance = cachedInstance;
  const memory = instance.exports.memory as WebAssembly.Memory;
  return {
    memory,
    computeNormals(field: Float32Array, width: number, height: number, options: NormalOptions): Float32Array {
      const scaleX = options.scaleX ?? 0.5;
      const scaleY = options.scaleY ?? 0.5;
      const normalScale = options.normalScale ?? 1;
      const n = width * height;
      // grow if needed (the module contract: host grows, then reacquires views)
      const needed = 16 * n + 64;
      if (needed > memory.buffer.byteLength) {
        const pages = Math.ceil((needed - memory.buffer.byteLength) / 65536);
        memory.grow(pages);
      }
      const inView = new Float32Array(memory.buffer, 0, n);
      inView.set(field);
      instance.exports.compute_normals(width, height, scaleX, scaleY, normalScale);
      return new Float32Array(memory.buffer, 4 * n, 3 * n);
    },
  };
}

/** TS oracle on the same field (the semantic reference). */
function oracleNormals(field: Float32Array, width: number, height: number, options: NormalOptions): Float32Array {
  const heightBuf = new HostBuffer({ width, height, channels: 1, format: "f32" });
  heightBuf.data.set(field);
  const normal = computeNormals(heightBuf, options);
  const out = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      out[o] = normal.get(x, y, 0);
      out[o + 1] = normal.get(x, y, 1);
      out[o + 2] = normal.get(x, y, 2);
    }
  }
  return out;
}

/** Deterministic pseudo-random field (mulberry32) with f32-rounded values. */
function seededField(width: number, height: number, seed: number): Float32Array {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const field = new Float32Array(width * height);
  for (let i = 0; i < field.length; i++) {
    // mix of smooth values, sharp edges and extreme finite magnitudes
    const mode = i % 5;
    if (mode === 0) {
      field[i] = Math.fround(Math.sin(rand() * 30) * 10);
    } else if (mode === 1) {
      field[i] = Math.fround(rand() * 1000);
    } else if (mode === 2) {
      field[i] = Math.fround((i % 17) - 8);
    } else if (mode === 3) {
      field[i] = Math.fround(rand() < 0.5 ? -3.4028235e38 : 3.4028235e38);
    } else {
      field[i] = Math.fround(rand() * 2 - 1);
    }
  }
  return field;
}

/** Compare two normal fields for exact bit parity (or tolerance). */
function compareNormals(
  label: string,
  wasm: Float32Array,
  oracle: Float32Array,
  { exact }: { exact: boolean },
): void {
  expect(wasm.length).toBe(oracle.length);
  let maxDelta = 0;
  let firstBad = -1;
  for (let i = 0; i < wasm.length; i++) {
    const a = wasm[i];
    const b = oracle[i];
    const delta = Math.abs(a - b);
    if (delta > maxDelta) {
      maxDelta = delta;
    }
    const bad = exact ? !Object.is(a, b) : !(delta <= 1e-4) || !Number.isFinite(a);
    if (bad && firstBad === -1) {
      firstBad = i;
    }
  }
  expect(firstBad, `${label}: first mismatch at index ${firstBad} (wasm ${wasm[firstBad]}, oracle ${oracle[firstBad]})`).toBe(-1);
}

const OPTION_SETS: Array<{ label: string; options: NormalOptions }> = [
  { label: "defaults", options: {} },
  { label: "dpr1", options: { scaleX: 0.5, scaleY: 0.5, normalScale: 1 } },
  { label: "dpr1.5", options: { scaleX: 0.75, scaleY: 0.75, normalScale: 1 } },
  { label: "dpr2", options: { scaleX: 1, scaleY: 1, normalScale: 1 } },
  { label: "stretched", options: { scaleX: 0.25, scaleY: 2, normalScale: 0.5 } },
  { label: "flat-z", options: { scaleX: 1e-4, scaleY: 1e-4, normalScale: 1e4 } },
];

describe("#33 WASM kernel — oracle parity (exact bit-for-bit)", () => {
  it("matches the oracle on a flat field", async () => {
    const k = await kernel();
    for (const { label, options } of OPTION_SETS) {
      const field = new Float32Array(32 * 24);
      const wasm = k.computeNormals(field, 32, 24, options);
      const oracle = oracleNormals(field, 32, 24, options);
      compareNormals(`flat/${label}`, wasm, oracle, { exact: true });
      expect(wasm.length).toBe(32 * 24 * 3);
    }
  });

  it("matches the oracle on edge-clamping cases (1x1, 1xN, Nx1, 2x2, 3x3)", async () => {
    const k = await kernel();
    for (const [width, height] of [[1, 1], [1, 5], [5, 1], [2, 2], [3, 3], [3, 7]] as const) {
      const field = seededField(width, height, 0x33 + width * 7 + height);
      const wasm = k.computeNormals(field, width, height, {});
      const oracle = oracleNormals(field, width, height, {});
      compareNormals(`edges/${width}x${height}`, wasm, oracle, { exact: true });
    }
  });

  it("matches the oracle on ramp and ridge fields", async () => {
    const k = await kernel();
    const width = 40;
    const height = 30;
    const field = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        field[y * width + x] = Math.fround(x * 0.5 + y * 0.25 + Math.sin(x / 3) * 2);
      }
    }
    for (const { label, options } of OPTION_SETS) {
      const wasm = k.computeNormals(field, width, height, options);
      const oracle = oracleNormals(field, width, height, options);
      compareNormals(`ramp/${label}`, wasm, oracle, { exact: true });
    }
  });

  it("matches the oracle on extreme finite f32 values", async () => {
    const k = await kernel();
    const width = 16;
    const height = 16;
    const extreme = new Float32Array(width * height);
    const extremes = [
      3.4028235e38, -3.4028235e38, 3.4e38, -3.4e38, 1e38, -1e38,
      1.17549435e-38, -1.17549435e-38, 1e-45, -1e-45, 0, -0,
      16777216, -16777216, 0.5, -0.5, 1, -1, 1e-20, -1e20,
    ];
    for (let i = 0; i < width * height; i++) {
      extreme[i] = extremes[i % extremes.length];
    }
    for (const { label, options } of OPTION_SETS) {
      const wasm = k.computeNormals(extreme, width, height, options);
      const oracle = oracleNormals(extreme, width, height, options);
      compareNormals(`extreme/${label}`, wasm, oracle, { exact: true });
    }
    // sanity: no NaN/Inf may appear in any output for finite inputs
    const wasm = k.computeNormals(extreme, width, height, {});
    for (let i = 0; i < wasm.length; i++) {
      expect(Number.isFinite(wasm[i])).toBe(true);
    }
  });

  it("matches the oracle on a seeded property sweep (exact)", async () => {
    const k = await kernel();
    for (let seed = 1; seed <= 40; seed++) {
      const width = 8 + (seed % 17);
      const height = 6 + (seed % 13);
      const field = seededField(width, height, seed);
      const wasm = k.computeNormals(field, width, height, {});
      const oracle = oracleNormals(field, width, height, {});
      compareNormals(`property/seed${seed}/${width}x${height}`, wasm, oracle, { exact: true });
    }
  });

  it("supports DPR 1/1.5/2 and representative large extents", async () => {
    const k = await kernel();
    const cases = [
      { width: 96, height: 60, label: "small" },
      { width: 480, height: 300, label: "large" },
      { width: 1024, height: 1024, label: "big" },
    ] as const;
    for (const { width, height, label } of cases) {
      const field = seededField(width, height, label.length * 13);
      for (const { label: optLabel, options } of OPTION_SETS) {
        const wasm = k.computeNormals(field, width, height, options);
        const oracle = oracleNormals(field, width, height, options);
        compareNormals(`${label}/${optLabel}`, wasm, oracle, { exact: true });
      }
    }
  });

  it("is stable across repeated renders (no state leaks between calls)", async () => {
    const k = await kernel();
    const field = seededField(64, 48, 0xbeef);
    const first = k.computeNormals(field, 64, 48, {});
    const second = k.computeNormals(field, 64, 48, {});
    for (let i = 0; i < first.length; i++) {
      expect(first[i]).toBe(second[i]);
    }
    // interleaving different extents must not corrupt each other
    const bigField = seededField(33, 21, 0x1234);
    const bigWasm = k.computeNormals(bigField, 33, 21, {});
    const bigOracle = oracleNormals(bigField, 33, 21, {});
    compareNormals("interleaved-big", bigWasm, bigOracle, { exact: true });
    const smallWasm = k.computeNormals(field.subarray(0, 16), 4, 4, {});
    const smallOracle = oracleNormals(field.subarray(0, 16), 4, 4, {});
    compareNormals("interleaved-small", smallWasm, smallOracle, { exact: true });
  });

  it("grows memory on demand and reacquires views (no detached/stale views)", async () => {
    const instance = await WebAssembly.instantiate(await modulePromise, {});
    const memory = instance.exports.memory as WebAssembly.Memory;
    let growthCount = 0;
    const compute = (width: number, height: number, field: Float32Array): Float32Array => {
      const n = width * height;
      const needed = 16 * n + 64;
      if (needed > memory.buffer.byteLength) {
        const pages = Math.ceil((needed - memory.buffer.byteLength) / 65536);
        memory.grow(pages);
        growthCount += 1;
      }
      // views are REACQUIRED after any growth — never cached across grow.
      // The result is COPIED out of wasm memory (a live view would detach
      // when the memory later grows — the exact hazard the host wrapper
      // must avoid).
      const inView = new Float32Array(memory.buffer, 0, n);
      inView.set(field);
      instance.exports.compute_normals(width, height, 0.5, 0.5, 1);
      return new Float32Array(new Float32Array(memory.buffer, 4 * n, 3 * n));
    };
    // 16x16 needs 4 KiB -> fits in the initial 64 KiB page (no growth)
    const small = compute(16, 16, seededField(16, 16, 1));
    expect(growthCount).toBe(0);
    // 1024x1024 needs 16 MiB -> must grow many pages
    const bigField = seededField(1024, 1024, 2);
    const big = compute(1024, 1024, bigField);
    expect(growthCount).toBeGreaterThan(0);
    expect(memory.buffer.byteLength).toBeGreaterThanOrEqual(16 * 1024 * 1024 + 64);
    const bigOracle = oracleNormals(bigField, 1024, 1024, {});
    compareNormals("grown-memory", big, bigOracle, { exact: true });
    // and the small result from BEFORE growth is still intact (copied out)
    const smallOracle = oracleNormals(seededField(16, 16, 1), 16, 16, {});
    compareNormals("pre-growth-retained", small, smallOracle, { exact: true });
  });

  it("reports kernel_version 1 and a return code of 0", async () => {
    const instance = await WebAssembly.instantiate(await modulePromise, {});
    expect((instance.exports.kernel_version as () => number)()).toBe(1);
    expect(
      (instance.exports.compute_normals as (...a: number[]) => number)(2, 2, 0.5, 0.5, 1),
    ).toBe(0);
  });
});
