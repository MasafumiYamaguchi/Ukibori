import { describe, expect, it } from "vitest";
import { bytesEqual } from "./tiles";
import { regionBytesEqual, regionEqual } from "./height-inputs";

// Independent scalar oracle: pins exact integer bits, tails, and view boundaries.
const scalar = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

describe("word comparison parity", () => {
  it("matches scalar equality at all alignments, lengths and changed byte positions", () => {
    for (const length of [0, 1, 3, 4, 15, 63, 64, 127, 128, 255, 256, 257, 258, 259, 260, 511]) {
      for (let aOffset = 0; aOffset < 4; aOffset++) {
        for (let bOffset = 0; bOffset < 4; bOffset++) {
          const a = new Uint8Array(length + 8).fill(91).subarray(aOffset, aOffset + length);
          const b = new Uint8Array(length + 8).fill(182).subarray(bOffset, bOffset + length);
          for (let i = 0; i < length; i++) a[i] = b[i] = (i * 71) & 255;
          expect(bytesEqual(a, b)).toBe(scalar(a, b));
          for (let i = 0; i < length; i++) {
            b[i] ^= 128;
            expect(bytesEqual(a, b)).toBe(scalar(a, b));
            b[i] ^= 128;
          }
          expect(bytesEqual(a, new Uint8Array(length + 1))).toBe(false);
        }
      }
    }
  });

  it("compares shifted regions without reading outside their bounds", () => {
    const a = new Uint8Array(1030).fill(91);
    const b = new Uint8Array(1040).fill(182);
    a.fill(255, 1, 1026);
    b.set(a.subarray(1, 1026), 7);
    expect(regionBytesEqual(a, 1, b, 7, 1025)).toBe(true);
    b[1031] ^= 1;
    expect(regionBytesEqual(a, 1, b, 7, 1025)).toBe(false);
    expect(regionBytesEqual(a, 1, b, 7, 1024)).toBe(true);
    for (const offset of [-1, 0.5, NaN, Infinity, 1031]) {
      expect(regionEqual(a, a, { offset, byteLength: 1 })).toBe(false);
      expect(regionBytesEqual(a, offset, b, 0, 1)).toBe(false);
    }
    for (const byteLength of [-1, 0.5, NaN, Infinity, 1031]) {
      expect(regionEqual(a, a, { offset: 0, byteLength })).toBe(false);
    }
  });

  it("distinguishes NaN payloads and signed zero as integer bytes", () => {
    const a = new Uint8Array(256), b = new Uint8Array(256);
    const av = new DataView(a.buffer), bv = new DataView(b.buffer);
    av.setUint32(128, 0x7fc00001, true);
    bv.setUint32(128, 0x7fc00002, true);
    expect(bytesEqual(a, b)).toBe(false);
    av.setUint32(128, 0, true);
    bv.setUint32(128, 0x80000000, true);
    expect(bytesEqual(a, b)).toBe(false);
  });
});
