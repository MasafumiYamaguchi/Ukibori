/**
 * Compare already bounds-checked ranges exactly. Callers retain their own
 * public validation policies. No hashes, allocations of payloads, or caches.
 */
export function equalByteRanges(
  a: Uint8Array,
  aOffset: number,
  b: Uint8Array,
  bOffset: number,
  length: number,
): boolean {
  if (length > 0 && a[aOffset] !== b[bOffset]) return false;
  let i = 0;
  // Tiny ABI fields are cheaper to compare without creating DataViews.
  // Larger ranges use integer words (including NaN/signed-zero bit patterns),
  // with unaligned subviews supported on either side.
  if (length >= 256) {
    const av = new DataView(a.buffer, a.byteOffset + aOffset, length);
    const bv = new DataView(b.buffer, b.byteOffset + bOffset, length);
    const end = length - (length % 4);
    for (; i < end; i += 4) {
      if (av.getUint32(i, true) !== bv.getUint32(i, true)) return false;
    }
  }
  for (; i < length; i++) {
    if (a[aOffset + i] !== b[bOffset + i]) return false;
  }
  return true;
}
