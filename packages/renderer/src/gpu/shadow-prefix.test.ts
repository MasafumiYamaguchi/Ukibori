import { describe, expect, it } from "vitest";
import { SHADOW_PASS_WGSL } from "./shadow-pass-wgsl";

type PrefixInput = {
  px: number;
  py: number;
  rz0: number;
  dx: number;
  dy: number;
  dz: number;
  stepSize: number;
  stepCount: number;
  width: number;
  height: number;
  dpr: number;
  maxCasterHeight: number;
  bias: number;
};

const f32 = Math.fround;

/** Mirror one WGSL f32 operation, including the intermediate product. */
function mulF32(a: number, b: number): number {
  return f32(f32(a) * f32(b));
}

/** Mirror `f32(k) * params.stepSize` in the shader. */
function marchT(input: PrefixInput, stepIndex: number): number {
  return mulF32(f32(stepIndex), input.stepSize);
}

/** Mirror `rz0 + dz * t` with the exact operation order used by WGSL. */
function rayZAtStep(input: PrefixInput, stepIndex: number): number {
  return f32(f32(input.rz0) + mulF32(input.dz, marchT(input, stepIndex)));
}

function rayInBoundsAtStep(input: PrefixInput, stepIndex: number): boolean {
  const t = marchT(input, stepIndex);
  const sx = f32(f32(input.px) + mulF32(input.dx, t));
  const sy = f32(f32(input.py) + mulF32(input.dy, t));
  const dpr = f32(input.dpr);
  const left = f32(0.5 / dpr);
  const right = f32((f32(input.width) - f32(0.5)) / dpr);
  const top = f32(0.5 / dpr);
  const bottom = f32((f32(input.height) - f32(0.5)) / dpr);
  return !(sx < left || sx > right || sy < top || sy > bottom);
}

/** Reference for the historical linear loop's reachable integer prefix. */
function historicalPrefix(input: PrefixInput): number {
  const bound = f32(f32(input.maxCasterHeight) + f32(input.bias));
  let last = 0;
  for (let step = 1; step <= input.stepCount; step++) {
    if (!rayInBoundsAtStep(input, step)) break;
    if (rayZAtStep(input, step) > bound) break;
    last = step;
  }
  return last;
}

function binaryPrefix(limit: number, predicate: (step: number) => boolean): number {
  if (limit === 0) return 0;
  if (predicate(limit)) return limit;
  let lo = 0;
  let hi = limit;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (predicate(mid)) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

/** Reference for the optimized WGSL exact-prefix search. */
function optimizedPrefix(input: PrefixInput): number {
  const limit = input.stepCount;
  if (limit === 0) return 0;
  const bound = f32(f32(input.maxCasterHeight) + f32(input.bias));
  if (input.dz <= 0) {
    // The historical loop checks XY before height. A non-rising ray only
    // needs its first in-bounds height decision; after it passes, height is
    // never an additional prefix constraint.
    if (rayInBoundsAtStep(input, 1) && rayZAtStep(input, 1) > bound) return 0;
    return binaryPrefix(limit, (step) => rayInBoundsAtStep(input, step));
  }
  return binaryPrefix(
    limit,
    (step) => rayInBoundsAtStep(input, step) && rayZAtStep(input, step) <= bound,
  );
}

function nextF32(value: number, direction: 1 | -1): number {
  if (!Number.isFinite(value)) return value;
  const bytes = new ArrayBuffer(4);
  const view = new DataView(bytes);
  view.setFloat32(0, f32(value), true);
  let bits = view.getUint32(0, true);
  if (bits === 0x80000000 && direction > 0) bits = 0;
  else if (direction > 0) bits += 1;
  else if (bits === 0) bits = 0x80000001;
  else bits -= 1;
  view.setUint32(0, bits >>> 0, true);
  return view.getFloat32(0, true);
}

function baseInput(overrides: Partial<PrefixInput> = {}): PrefixInput {
  return {
    px: 2.5,
    py: 2.5,
    rz0: 0,
    dx: 0,
    dy: 0,
    dz: 0.25,
    stepSize: 0.5,
    stepCount: 16,
    width: 8,
    height: 8,
    dpr: 1,
    maxCasterHeight: 8,
    bias: 0,
    ...overrides,
  };
}

function nextRandom(state: { value: number }): number {
  state.value = (Math.imul(state.value, 1664525) + 1013904223) >>> 0;
  return state.value / 0x100000000;
}

function randomInput(state: { value: number }, index: number): PrefixInput {
  const width = 2 + Math.floor(nextRandom(state) * 63);
  const height = 2 + Math.floor(nextRandom(state) * 63);
  const dprOptions = [1, 1.5, 2];
  const dpr = dprOptions[Math.floor(nextRandom(state) * dprOptions.length)];
  const signed = (scale: number) => f32((nextRandom(state) * 2 - 1) * scale);
  const stepOptions = [0.1, 0.3, 0.5, 0.7, 1.3, 2.75];
  let dz = signed(2.5);
  if (index % 17 === 0) dz = 0;
  else if (index % 19 === 0) dz = f32(1e-7);
  else if (index % 23 === 0) dz = f32(-1e-7);
  const stepSize = index % 5 === 0
    ? f32(stepOptions[index % stepOptions.length])
    : f32(0.05 + nextRandom(state) * 2.75);
  return {
    px: f32(0.5 / dpr + nextRandom(state) * Math.max(0, (width - 1) / dpr)),
    py: f32(0.5 / dpr + nextRandom(state) * Math.max(0, (height - 1) / dpr)),
    rz0: signed(5),
    dx: signed(1.4),
    dy: signed(1.4),
    dz,
    stepSize,
    stepCount: 1 + Math.floor(nextRandom(state) * 320),
    width,
    height,
    dpr,
    maxCasterHeight: f32(nextRandom(state) * 8),
    bias: f32(nextRandom(state)),
  };
}

describe("#48 exact ShadowPass prefix search", () => {
  it("contains the shared historical ray-Z expression and no analytic margin", () => {
    expect(SHADOW_PASS_WGSL).toContain(
      "fn rayZAtStep(rz0: f32, dz: f32, stepIndex: u32) -> f32 {",
    );
    expect(SHADOW_PASS_WGSL).toContain("fn rayPrefixStepLimit(");
    expect(SHADOW_PASS_WGSL).toContain("rayZAtStep(rz0, dz, mid) <= bound");
    expect(SHADOW_PASS_WGSL).not.toContain("fn rayHeightStepLimit");
    expect(SHADOW_PASS_WGSL).not.toContain("+ 8u");
    expect(SHADOW_PASS_WGSL).not.toContain("perStepRise");
    expect(SHADOW_PASS_WGSL).not.toContain("ceil(max(ratio");
  });

  it.each([
    ["dz > 0 before an integer boundary", baseInput({ dz: 0.25, maxCasterHeight: 0.749 })],
    ["dz > 0 after an integer boundary", baseInput({ dz: 0.25, maxCasterHeight: 0.751 })],
    ["dz == 0", baseInput({ dz: 0, maxCasterHeight: 0 })],
    ["dz < 0", baseInput({ dz: -0.25, rz0: 0.5, maxCasterHeight: 0 })],
    ["dz < 0 after a passing first step", baseInput({ dz: -0.25, rz0: 0.5, maxCasterHeight: 0.4 })],
    ["receiver initially above the bound", baseInput({ dz: 0, rz0: 1, maxCasterHeight: 0 })],
    ["very small positive dz", baseInput({ dz: 1e-7, stepCount: 100_000, maxCasterHeight: 0.02 })],
    ["non-dyadic step 0.1", baseInput({ stepSize: 0.1, dz: 0.7, dx: 0.4, stepCount: 120 })],
    ["non-dyadic step 0.3", baseInput({ stepSize: 0.3, dz: 0.7, dx: -0.4, stepCount: 120 })],
    ["XY and height leave on the same step", baseInput({ dx: 1, stepSize: 1, dz: 1, stepCount: 12, width: 5, maxCasterHeight: 2.9 })],
  ])("matches the historical prefix for %s", (_label, input) => {
    expect(optimizedPrefix(input)).toBe(historicalPrefix(input));
  });

  it("keeps strict equality at rayZ == maxCasterHeight + bias", () => {
    const equality = baseInput({ dz: 0.25, stepSize: 0.5, stepCount: 8, maxCasterHeight: 0.5 });
    expect(rayZAtStep(equality, 4)).toBe(equality.maxCasterHeight);
    expect(optimizedPrefix(equality)).toBe(historicalPrefix(equality));
    expect(optimizedPrefix(equality)).toBe(4);
    const justBelow = baseInput({
      dz: 0.25,
      stepSize: 0.5,
      stepCount: 8,
      maxCasterHeight: nextF32(rayZAtStep(equality, 4), -1),
    });
    expect(optimizedPrefix(justBelow)).toBe(3);
    const justAbove = baseInput({
      dz: 0.25,
      stepSize: 0.5,
      stepCount: 8,
      maxCasterHeight: nextF32(rayZAtStep(equality, 4), 1),
    });
    expect(optimizedPrefix(justAbove)).toBe(historicalPrefix(justAbove));
    expect(optimizedPrefix(justAbove)).toBe(4);
  });

  it("handles a large fully valid stepCount without a linear reference loop", () => {
    const input = baseInput({ stepCount: 1 << 20, dz: 0, maxCasterHeight: 1 });
    expect(optimizedPrefix(input)).toBe(input.stepCount);
  });

  it("matches the historical f32 prefix over a deterministic 12,000-case sweep", () => {
    const state = { value: 0x48f00d }; // fixed seed: reproducible review evidence
    for (let index = 0; index < 12_000; index++) {
      const input = randomInput(state, index);
      const expected = historicalPrefix(input);
      const actual = optimizedPrefix(input);
      expect(actual, `case ${index}: ${JSON.stringify(input)}`).toBe(expected);
    }
  });
});
