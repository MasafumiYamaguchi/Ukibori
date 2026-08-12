#!/usr/bin/env node
// #33 deterministic WASM normal-kernel builder.
//
// This script emits the exact bytes of the ukibori normal-generation WASM
// module WITHOUT any external toolchain (no wat2wasm, no wabt, no binaryen,
// no emscripten). The module is described below as a small structured spec
// (WAT-style instructions + module sections) and encoded by the tiny
// assembler in this file, so the output is fully deterministic: building
// twice yields identical bytes, and the checked-in base64 copy in
// src/wasm/normal-kernel.base64.ts is verified byte-for-byte by the
// determinism test (src/wasm/determinism.test.ts).
//
// Usage:
//
//   node scripts/build-wasm.mjs                 # print the module hex digest
//   node scripts/build-wasm.mjs --emit          # regenerate the checked-in
//                                               # base64 TS module
//
// The human-audit WAT listing lives in src/wasm/normal-kernel.wat; the
// build script below is the SOURCE OF TRUTH for the binary (the WAT file
// documents the same instruction sequence and is pinned to it by the
// determinism test's comment checks).
//
// ## Kernel semantics (must mirror packages/renderer/src/lighting.ts
//    `computeNormals` exactly — the TypeScript oracle)
//
// For every texel (x, y) of the width*height f32 height field stored at
// memory offset 0 (row-major, tightly packed, f32):
//
//   x0 = max(x - 1, 0);  x1 = min(x + 1, width - 1)
//   y0 = max(y - 1, 0);  y1 = min(y + 1, height - 1)
//   dx = H(x1, y) - H(x0, y)          (f64 subtraction of f32 reads)
//   dy = H(x, y1) - H(x, y0)
//   nx = -dx * scaleX;  ny = -dy * scaleY;  nz = normalScale
//   m  = max(|nx|, |ny|, |nz|);  inv = 1 / m
//   a = nx * inv;  b = ny * inv;  c = nz * inv
//   len = Math.hypot(a, b, c)   (replicated exactly: the V8/Chrome
//     algorithm — max-scaled sqrt of squared ratios — so the f64 result is
//     bit-identical to the oracle's on every engine that runs this repo's
//     tests; every operation here is IEEE-754 f64 and therefore matches the
//     oracle's f64 arithmetic op-for-op)
//   N = (a / len, b / len, c / len)  stored as f32 xyz at memory offset
//       4 * width * height (row-major, tightly packed, 12 bytes per texel)
//
// The normalization is overflow-safe exactly like the oracle: nx/ny/nz are
// f64 products of f32 values, so they are always finite, and the
// max-component-first scaling keeps every reciprocal normal-range.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Minimal encoder
// ---------------------------------------------------------------------------

const uleb = (value) => {
  const out = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return out;
};

const sleb = (value) => {
  const out = [];
  let v = value;
  let more = true;
  while (more) {
    let byte = v & 0x7f;
    v >>= 7;
    if ((v === 0 && (byte & 0x40) === 0) || (v === -1 && (byte & 0x40) !== 0)) {
      more = false;
    } else {
      byte |= 0x80;
    }
    out.push(byte);
  }
  return out;
};

const bytes = (arr) => new Uint8Array(arr);

const section = (id, payload) => {
  const p = bytes(payload);
  return bytes([id, ...uleb(p.length), ...p]);
};

// ---------------------------------------------------------------------------
// The module spec. Instruction encoding (opcode table) — VERIFIED
// empirically against the engine (Node/V8, the same engine that runs the
// vitest suite and the Chrome browser gate) with one-function probe modules
// that execute each opcode and check its exact semantics and arity:
//
//   control: block 0x02, loop 0x03, if 0x04, else 0x05, end 0x0B, br 0x0C,
//            br_if 0x0D
//   variable:local.get 0x20, local.set 0x21, local.tee 0x22
//   i32:     const 0x41, eq 0x46, ne 0x47, lt_u 0x49, gt_u 0x4B, le_u 0x4D,
//            ge_u 0x4F, add 0x6A, sub 0x6B, mul 0x6C, div_u 0x6E, rem_u 0x70,
//            and 0x71, shl 0x74
//   f64:     const 0x44, eq 0x61, ne 0x62, lt 0x63, gt 0x64, le 0x65, ge 0x66,
//            abs 0x99, neg 0x9A, ceil 0x9B, floor 0x9C, trunc 0x9D,
//            nearest 0x9E, sqrt 0x9F, add 0xA0, sub 0xA1, mul 0xA2, div 0xA3,
//            min 0xA4, max 0xA5, copysign 0xA6
//   conv/mem:f32.load 0x2A, f32.store 0x38 (address pushed first, then the
//            value; memarg = [align, offset]), f64.promote_f32 0xBB,
//            f32.demote_f64 0xB6
//
//   value types: i32 0x7F, f64 0x7C, f32 0x7D; empty blocktype 0x40
//   blocktypes:  void 0x40, i32-result 0x7F
//
// NOTE on the numeric opcode range: f64 unary ops are 0x99..0x9E and f64
// binary ops are 0xA0..0xA6 (f64.sqrt is 0x9F); the conversion block starts
// at 0xA7. These values are what the engine accepts and executes correctly —
// do not "correct" them from memory; re-run the probe modules instead.
// ---------------------------------------------------------------------------

/** Locals of $compute_normals (params 0..4, then locals 5..27). The `t`
 * slot is reused: it holds the per-component scaled temp during the hypot
 * sum loop and the final `len` afterwards (their live ranges do not
 * overlap), so the local footprint stays at 11 i32 + 12 f64. */
const L = {
  w: 0, h: 1, sx: 2, sy: 3, nz: 4,
  n: 5, g: 6, tx: 7, ty: 8, x0: 9, x1: 10, y0: 11, y1: 12,
  row: 13, row0: 14, row1: 15,
  dx: 16, dy: 17, nx: 18, ny: 19, a: 20, b: 21, c: 22,
  m: 23, inv: 24, m2: 25, sum: 26, t: 27,
};

const I = (op, arg) => (arg === undefined ? { op } : { op, arg });

// Load/store memarg: align = log2(alignment) = 2 for 4-byte f32, offset 0.
const MEMARG = [0x02, 0x00];

/** $compute_normals body — mirrors the WAT in src/wasm/normal-kernel.wat. */
function computeNormalsBody() {
  const B = [];
  // n = width * height
  B.push(I("local.get", L.w), I("local.get", L.h), I("i32.mul"), I("local.set", L.n));
  B.push(I("block", 0x40), I("loop", 0x40));
  // if g >= n, exit
  B.push(I("local.get", L.g), I("local.get", L.n), I("i32.ge_u"), I("br_if", 1));
  // tx = g % w ; ty = g / w
  B.push(I("local.get", L.g), I("local.get", L.w), I("i32.rem_u"), I("local.set", L.tx));
  B.push(I("local.get", L.g), I("local.get", L.w), I("i32.div_u"), I("local.set", L.ty));
  // x0 = tx > 0 ? tx - 1 : 0  (branch so unsigned subtraction never wraps)
  B.push(I("local.get", L.tx), I("i32.const", 1), I("i32.ge_u"), I("if", 0x7f));
  B.push(I("local.get", L.tx), I("i32.const", 1), I("i32.sub"), I("else", 0x7f), I("i32.const", 0), I("end", 0x7f));
  B.push(I("local.set", L.x0));
  // x1 = min(tx + 1, width - 1)
  B.push(
    I("local.get", L.tx), I("i32.const", 1), I("i32.add"),
    I("local.get", L.w), I("i32.const", 1), I("i32.sub"),
    I("i32.lt_u"), I("if", 0x7f),
    I("local.get", L.tx), I("i32.const", 1), I("i32.add"),
    I("else", 0x7f),
    I("local.get", L.w), I("i32.const", 1), I("i32.sub"),
    I("end", 0x7f), I("local.set", L.x1),
  );
  // y0 = ty > 0 ? ty - 1 : 0
  B.push(I("local.get", L.ty), I("i32.const", 1), I("i32.ge_u"), I("if", 0x7f));
  B.push(I("local.get", L.ty), I("i32.const", 1), I("i32.sub"), I("else", 0x7f), I("i32.const", 0), I("end", 0x7f));
  B.push(I("local.set", L.y0));
  // y1 = min(ty + 1, height - 1)
  B.push(
    I("local.get", L.ty), I("i32.const", 1), I("i32.add"),
    I("local.get", L.h), I("i32.const", 1), I("i32.sub"),
    I("i32.lt_u"), I("if", 0x7f),
    I("local.get", L.ty), I("i32.const", 1), I("i32.add"),
    I("else", 0x7f),
    I("local.get", L.h), I("i32.const", 1), I("i32.sub"),
    I("end", 0x7f), I("local.set", L.y1),
  );
  // row = ty * w ; row0 = y0 * w ; row1 = y1 * w
  B.push(I("local.get", L.ty), I("local.get", L.w), I("i32.mul"), I("local.set", L.row));
  B.push(I("local.get", L.y0), I("local.get", L.w), I("i32.mul"), I("local.set", L.row0));
  B.push(I("local.get", L.y1), I("local.get", L.w), I("i32.mul"), I("local.set", L.row1));
  // dx = H[row + x1] - H[row + x0]
  B.push(I("local.get", L.row), I("local.get", L.x1), I("i32.add"), I("i32.const", 2), I("i32.shl"), I("f32.load"));
  B.push(I("f64.promote_f32"));
  B.push(I("local.get", L.row), I("local.get", L.x0), I("i32.add"), I("i32.const", 2), I("i32.shl"), I("f32.load"));
  B.push(I("f64.promote_f32"), I("f64.sub"), I("local.set", L.dx));
  // dy = H[row1 + tx] - H[row0 + tx]
  B.push(I("local.get", L.row1), I("local.get", L.tx), I("i32.add"), I("i32.const", 2), I("i32.shl"), I("f32.load"));
  B.push(I("f64.promote_f32"));
  B.push(I("local.get", L.row0), I("local.get", L.tx), I("i32.add"), I("i32.const", 2), I("i32.shl"), I("f32.load"));
  B.push(I("f64.promote_f32"), I("f64.sub"), I("local.set", L.dy));
  // nx = -dx * scaleX ; ny = -dy * scaleY
  B.push(I("local.get", L.dx), I("f64.neg"), I("local.get", L.sx), I("f64.mul"), I("local.set", L.nx));
  B.push(I("local.get", L.dy), I("f64.neg"), I("local.get", L.sy), I("f64.mul"), I("local.set", L.ny));
  // m = max(|nx|, |ny|, normalScale)
  B.push(
    I("local.get", L.nx), I("f64.abs"),
    I("local.get", L.ny), I("f64.abs"), I("f64.max"),
    I("local.get", L.nz), I("f64.max"), I("local.set", L.m),
  );
  // inv = 1 / m
  B.push(I("f64.const", 1), I("local.get", L.m), I("f64.div"), I("local.set", L.inv));
  // a = nx * inv ; b = ny * inv ; c = normalScale * inv
  B.push(I("local.get", L.nx), I("local.get", L.inv), I("f64.mul"), I("local.set", L.a));
  B.push(I("local.get", L.ny), I("local.get", L.inv), I("f64.mul"), I("local.set", L.b));
  B.push(I("local.get", L.nz), I("local.get", L.inv), I("f64.mul"), I("local.set", L.c));
  // m2 = max(|a|, |b|, |c|)
  B.push(
    I("local.get", L.a), I("f64.abs"),
    I("local.get", L.b), I("f64.abs"), I("f64.max"),
    I("local.get", L.c), I("f64.abs"), I("f64.max"), I("local.set", L.m2),
  );
  // len = m2 == 0 ? 0 : m2 * sqrt(sum((v / m2)^2))   — exact V8 Math.hypot
  // replication, computed in argument order a, b, c.
  B.push(I("f64.const", 0), I("local.set", L.t));
  B.push(I("block", 0x40));
  B.push(I("local.get", L.m2), I("f64.const", 0), I("f64.eq"), I("br_if", 0));
  B.push(I("f64.const", 0), I("local.set", L.sum));
  for (const comp of [L.a, L.b, L.c]) {
    B.push(
      I("local.get", comp), I("local.get", L.m2), I("f64.div"), I("local.tee", L.t),
      I("local.get", L.t), I("f64.mul"),
      I("local.get", L.sum), I("f64.add"), I("local.set", L.sum),
    );
  }
  B.push(I("local.get", L.m2), I("local.get", L.sum), I("f64.sqrt"), I("f64.mul"), I("local.set", L.t));
  B.push(I("end", 0x40));
  // out[g*3 + c] = comp / len  (base 4*n). f32.store pops the ADDRESS first
  // (operand 0 = i32), then the VALUE — so the address is pushed first.
  const outBase = (extra) => [
    I("local.get", L.n), I("local.get", L.g), I("i32.const", 3), I("i32.mul"), I("i32.add"),
    I("i32.const", 2), I("i32.shl"), I("i32.const", extra), I("i32.add"),
  ];
  B.push(...outBase(0), I("local.get", L.a), I("local.get", L.t), I("f64.div"), I("f32.demote_f64"), I("f32.store"));
  B.push(...outBase(4), I("local.get", L.b), I("local.get", L.t), I("f64.div"), I("f32.demote_f64"), I("f32.store"));
  B.push(...outBase(8), I("local.get", L.c), I("local.get", L.t), I("f64.div"), I("f32.demote_f64"), I("f32.store"));
  // g += 1 ; continue
  B.push(I("local.get", L.g), I("i32.const", 1), I("i32.add"), I("local.set", L.g), I("br", 0));
  B.push(I("end", 0x40), I("end", 0x40));
  B.push(I("i32.const", 0));
  B.push(I("end", 0x40)); // function end
  return B;
}

/** Encode one instruction (plus the f64.const literal payload inline). */
function encodeInstruction(insn) {
  switch (insn.op) {
    // control
    case "block": return [0x02, ...uleb(insn.arg)];
    case "loop": return [0x03, ...uleb(insn.arg)];
    case "if": return [0x04, ...uleb(insn.arg)];
    case "else": return [0x05];
    case "end": return [0x0b];
    case "br": return [0x0c, ...uleb(insn.arg)];
    case "br_if": return [0x0d, ...uleb(insn.arg)];
    // variable
    case "local.get": return [0x20, ...uleb(insn.arg)];
    case "local.set": return [0x21, ...uleb(insn.arg)];
    case "local.tee": return [0x22, ...uleb(insn.arg)];
    // i32
    case "i32.const": return [0x41, ...sleb(insn.arg)];
    case "i32.eq": return [0x46];
    case "i32.ge_u": return [0x4f];
    case "i32.lt_u": return [0x49];
    case "i32.add": return [0x6a];
    case "i32.sub": return [0x6b];
    case "i32.mul": return [0x6c];
    case "i32.div_u": return [0x6e];
    case "i32.rem_u": return [0x70];
    case "i32.shl": return [0x74];
    // f64 (verified: unary 0x99..0x9E, sqrt 0x9F, binary 0xA0..0xA6)
    case "f64.const": {
      const buf = new ArrayBuffer(8);
      new DataView(buf).setFloat64(0, insn.arg, true);
      return [0x44, ...new Uint8Array(buf)];
    }
    case "f64.eq": return [0x61];
    case "f64.add": return [0xa0];
    case "f64.sub": return [0xa1];
    case "f64.mul": return [0xa2];
    case "f64.div": return [0xa3];
    case "f64.abs": return [0x99];
    case "f64.neg": return [0x9a];
    case "f64.max": return [0xa5];
    case "f64.sqrt": return [0x9f];
    // memory / conversion
    case "f32.load": return [0x2a, ...MEMARG];
    case "f32.store": return [0x38, ...MEMARG];
    case "f64.promote_f32": return [0xbb];
    case "f32.demote_f64": return [0xb6];
    default:
      throw new Error(`build-wasm: unknown instruction "${insn.op}"`);
  }
}

// ---------------------------------------------------------------------------
// Module assembly
// ---------------------------------------------------------------------------

/** Locals groups: [(count 11, i32), (count 12, f64)] (order matters). */
const LOCAL_DECLS = [
  [11, 0x7f],
  [12, 0x7c],
];

function codeSection() {
  const body0 = [];
  for (const insn of computeNormalsBody()) {
    body0.push(...encodeInstruction(insn));
  }
  const body0Full = [
    ...uleb(LOCAL_DECLS.length),
    ...LOCAL_DECLS.flat(),
    ...body0,
  ];
  // kernel_version: (result i32) { return 1 }
  const body1Full = [0x00, 0x41, 0x01, 0x0b];
  const payload = [0x02, ...uleb(body0Full.length), ...body0Full, ...uleb(body1Full.length), ...body1Full];
  return section(0x0a, payload);
}

function typeSection() {
  // type 0: (func (param i32 i32 f64 f64 f64) (result i32))
  const t0 = [0x60, 0x05, 0x7f, 0x7f, 0x7c, 0x7c, 0x7c, 0x01, 0x7f];
  // type 1: (func (result i32))
  const t1 = [0x60, 0x00, 0x01, 0x7f];
  return section(0x01, [0x02, ...t0, ...t1]);
}

function functionSection() {
  return section(0x03, [0x02, 0x00, 0x01]);
}

function memorySection() {
  // one memory: flags 0x01 (has max), min 1 page, max 65536 pages (4 GiB)
  return section(0x05, [0x01, 0x01, ...uleb(1), ...uleb(65536)]);
}

function exportSection() {
  const name = (s) => [s.length, ...new TextEncoder().encode(s)];
  const payload = [
    0x03,
    ...name("memory"), 0x02, 0x00,
    ...name("compute_normals"), 0x00, 0x00,
    ...name("kernel_version"), 0x00, 0x01,
  ];
  return section(0x07, payload);
}

/** The full deterministic module bytes. */
export function buildNormalKernelModule() {
  const parts = [
    bytes([0x00, 0x61, 0x73, 0x6d]), // \0asm
    bytes([0x01, 0x00, 0x00, 0x00]), // version 1
    typeSection(),
    functionSection(),
    memorySection(),
    exportSection(),
    codeSection(),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The generated module as a stable base64 string (checked in, no build step
 * needed at runtime). */
export function normalKernelBase64() {
  return Buffer.from(buildNormalKernelModule()).toString("base64");
}

// ---------------------------------------------------------------------------
// CLI: --emit regenerates the checked-in base64 TS module
// ---------------------------------------------------------------------------

async function main() {
  const bytesOut = buildNormalKernelModule();
  const digest = createHash("sha256").update(bytesOut).digest("hex");
  const b64 = Buffer.from(bytesOut).toString("base64");
  console.log(`build-wasm: module ${bytesOut.length} bytes, sha256 ${digest}`);
  if (process.argv.includes("--emit")) {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const target = resolve(scriptDir, "..", "src", "wasm", "normal-kernel.base64.ts");
    const body =
      `// #33 checked-in deterministic WASM normal-kernel module (base64).\n` +
      `// Generated by scripts/build-wasm.mjs (node scripts/build-wasm.mjs --emit).\n` +
      `// The determinism test (src/wasm/determinism.test.ts) rebuilds the module and\n` +
      `// verifies these bytes byte-for-byte; never edit this file by hand.\n` +
      `export const NORMAL_KERNEL_BASE64 =\n  ${JSON.stringify(b64)};\n` +
      `export const NORMAL_KERNEL_BYTE_LENGTH = ${bytesOut.length};\n`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body, "utf8");
    console.log(`build-wasm: wrote ${target} (${bytesOut.length} bytes)`);
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
