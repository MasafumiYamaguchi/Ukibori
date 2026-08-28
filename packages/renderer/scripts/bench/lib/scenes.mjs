// #46 deterministic reusable benchmark scene fixtures (§22). Every suite
// (CPU/GPU/DOM) imports scenes from this single module — a benchmark script
// never inlines its own scene definition. All placement is deterministic
// (no Math.random anywhere).
//
// Scene families:
//   simple-rounded-rect     one raised slab on a full panel
//   surface-grid            N non-overlapping rounded rects in a grid
//   surface-overlap-stack   N stacked overlapping rounded rects
//   glyph-grid              N glyph masks in a grid
//   mask-heavy              N distinct masks at maskResolution
//   short-shadow / long-shadow / soft-shadow   shadow travel variants
//   reconstruction-heavy    soft + reconstruction-ready casters
//   partial-edit            base + edit scene pair for partial recompute

export function simpleRoundedRectScene({ width, height, slabSize = 90, dpr = 1 }) {
  return {
    width,
    height,
    surfaces: [
      {
        id: "panel",
        position: { x: 0, y: 0 },
        size: { x: width, y: height },
        elevation: 0,
        thickness: 0,
        shape: { kind: "roundedRect", radius: 0 },
        profile: { kind: "flat" },
        material: "matte",
        castsShadow: false,
        receivesShadow: true,
      },
      {
        id: "slab",
        position: { x: Math.floor(width / 2 - slabSize / 2), y: Math.floor(height / 2 - slabSize / 4) },
        size: { x: slabSize, y: Math.floor(slabSize / 2) },
        elevation: 0,
        thickness: 24,
        shape: { kind: "roundedRect", radius: 16 },
        profile: { kind: "bevel" },
        material: "silicone",
        castsShadow: true,
        receivesShadow: true,
      },
    ],
    light: {
      direction: { x: -0.6, y: -0.4, z: 0.8 },
      intensity: 1,
      angularRadius: Math.fround(0),
    },
  };
}

const GRID_IDS = "abcdefghijklmnopqrstuvwxyz0123456789";

function gridLayout(count, cols, cellW, cellH, marginX, marginY) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    out.push({
      id: `s-${GRID_IDS[i % GRID_IDS.length]}${i}`,
      position: { x: marginX + col * cellW, y: marginY + row * cellH },
      size: { x: Math.floor(cellW * 0.7), y: Math.floor(cellH * 0.7) },
      elevation: 2 + (i % 5),
      thickness: 2 + (i % 3),
      bevelWidth: 4,
      shape: { kind: "roundedRect", radius: 8 },
      profile: { kind: "bevel" },
      material: i % 2 === 0 ? "silicone" : "metal",
      castsShadow: true,
      receivesShadow: true,
    });
  }
  return out;
}

export function surfaceGridScene({ width, height, count, dpr = 1, overlap = false }) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count * (width / height))));
  const rows = Math.ceil(count / cols);
  const cellW = Math.floor(width / cols);
  const cellH = Math.floor(height / rows);
  const marginX = 8;
  const marginY = 8;
  const surfaces = gridLayout(
    count,
    cols,
    Math.floor(cellW * 0.8),
    Math.floor(cellH * 0.8),
    marginX,
    marginY,
  );
  if (overlap) {
    // stack every surface at the center so all shadows/candidates overlap
    for (const s of surfaces) {
      s.position = {
        x: Math.floor(width / 2 - s.size.x / 2) + (surfaces.indexOf(s) % 3),
        y: Math.floor(height / 2 - s.size.y / 2) + (surfaces.indexOf(s) % 3),
      };
    }
  }
  return {
    width,
    height,
    surfaces: [
      {
        id: "panel",
        position: { x: 0, y: 0 },
        size: { x: width, y: height },
        elevation: 0,
        thickness: 0,
        shape: { kind: "roundedRect", radius: 0 },
        profile: { kind: "flat" },
        material: "matte",
        castsShadow: false,
        receivesShadow: true,
      },
      ...surfaces,
    ],
    light: {
      direction: { x: -0.6, y: -0.4, z: 0.8 },
      intensity: 1,
      angularRadius: Math.fround(0),
    },
  };
}

function glyphMask(seed, size = 8) {
  const alpha = new Uint8Array(size * size);
  // deterministic solid glyph-like pattern (diagonal bar)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const on = (x + y + seed) % 3 !== 0;
      alpha[y * size + x] = on ? 255 : 0;
    }
  }
  return { width: size, height: size, alpha };
}

export function glyphGridScene({ width, height, count, dpr = 1 }) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count * (width / height))));
  const rows = Math.ceil(count / cols);
  const cellW = Math.floor(width / cols);
  const cellH = Math.floor(height / rows);
  const surfaces = [];
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    surfaces.push({
      id: `glyph-${i}`,
      position: { x: 8 + col * cellW, y: 8 + row * cellH },
      size: { x: 14, y: 14 },
      elevation: 3 + (i % 4),
      thickness: 2,
      shape: { kind: "mask", mask: glyphMask(i, 8) },
      profile: { kind: "flat" },
      material: i % 2 === 0 ? "silicone" : "metal",
      castsShadow: true,
      receivesShadow: true,
    });
  }
  return {
    width,
    height,
    surfaces: [
      {
        id: "panel",
        position: { x: 0, y: 0 },
        size: { x: width, y: height },
        elevation: 0,
        thickness: 0,
        shape: { kind: "roundedRect", radius: 0 },
        profile: { kind: "flat" },
        material: "matte",
        castsShadow: false,
        receivesShadow: true,
      },
      ...surfaces,
    ],
    light: {
      direction: { x: -0.6, y: -0.4, z: 0.8 },
      intensity: 1,
      angularRadius: Math.fround(0),
    },
  };
}

export function maskHeavyScene({ width, height, maskCount, maskResolution, dpr = 1 }) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(maskCount * (width / height))));
  const rows = Math.ceil(maskCount / cols);
  const cellW = Math.floor(width / cols);
  const cellH = Math.floor(height / rows);
  const surfaces = [];
  for (let i = 0; i < maskCount; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    surfaces.push({
      id: `mask-${i}`,
      position: { x: 8 + col * cellW, y: 8 + row * cellH },
      size: { x: 24, y: 24 },
      elevation: 3,
      thickness: 2,
      shape: { kind: "mask", mask: glyphMask(i, maskResolution) },
      profile: { kind: "flat" },
      material: "silicone",
      castsShadow: true,
      receivesShadow: true,
    });
  }
  return {
    width,
    height,
    surfaces: [
      {
        id: "panel",
        position: { x: 0, y: 0 },
        size: { x: width, y: height },
        elevation: 0,
        thickness: 0,
        shape: { kind: "roundedRect", radius: 0 },
        profile: { kind: "flat" },
        material: "matte",
        castsShadow: false,
        receivesShadow: true,
      },
      ...surfaces,
    ],
    light: {
      direction: { x: -0.6, y: -0.4, z: 0.8 },
      intensity: 1,
      angularRadius: Math.fround(0),
    },
  };
}

export function shadowScene({ width, height, travel, angularRadius, dpr = 1 }) {
  // travel: "short" | "medium" | "long" — scales the shadow maxDistance the
  // scheduler derives from the scene diagonal/light direction.
  const travelScale = travel === "short" ? 0.1 : travel === "medium" ? 0.3 : 0.8;
  return {
    width,
    height,
    surfaces: [
      {
        id: "panel",
        position: { x: 0, y: 0 },
        size: { x: width, y: height },
        elevation: 0,
        thickness: 0,
        shape: { kind: "roundedRect", radius: 0 },
        profile: { kind: "flat" },
        material: "matte",
        castsShadow: false,
        receivesShadow: true,
      },
      {
        id: "caster",
        position: { x: Math.floor(width * 0.3), y: Math.floor(height * 0.25) },
        size: { x: 70, y: 40 },
        elevation: 0,
        thickness: 24,
        shape: { kind: "roundedRect", radius: 12 },
        profile: { kind: "bevel" },
        material: "silicone",
        castsShadow: true,
        receivesShadow: true,
      },
    ],
    light: {
      direction: { x: -0.7, y: -0.5, z: 0.6 },
      intensity: 1,
      angularRadius: Math.fround(angularRadius),
    },
    // exported hint consumed by the benchmark to set a bounded maxDistance
    travelScale,
  };
}

export function reconstructionHeavyScene({ width, height, dpr = 1 }) {
  return {
    width,
    height,
    surfaces: [
      {
        id: "panel",
        position: { x: 0, y: 0 },
        size: { x: width, y: height },
        elevation: 0,
        thickness: 0,
        shape: { kind: "roundedRect", radius: 0 },
        profile: { kind: "flat" },
        material: "matte",
        castsShadow: false,
        receivesShadow: true,
      },
      {
        id: "caster",
        position: { x: Math.floor(width * 0.25), y: Math.floor(height * 0.2) },
        size: { x: 60, y: 40 },
        elevation: 0,
        thickness: 16,
        shape: { kind: "roundedRect", radius: 10 },
        profile: { kind: "bevel" },
        material: "silicone",
        castsShadow: true,
        receivesShadow: true,
      },
      {
        id: "badge",
        position: { x: Math.floor(width * 0.6), y: Math.floor(height * 0.5) },
        size: { x: 36, y: 36 },
        elevation: 4,
        thickness: 2,
        shape: { kind: "roundedRect", radius: 8 },
        profile: { kind: "flat" },
        material: "metal",
        castsShadow: true,
        receivesShadow: true,
      },
    ],
    light: {
      direction: { x: -0.5, y: -0.3, z: 0.8 },
      intensity: 1,
      angularRadius: Math.fround(0.15),
    },
  };
}

export function partialEditScene({ width, height, edit = null, dpr = 1 }) {
  const base = {
    width,
    height,
    light: { direction: { x: 0, y: 0.1, z: 0.995 }, intensity: 1 },
    materials: {
      metal: { baseColor: { r: 0.72, g: 0.45, b: 0.2 }, roughness: 0.35, metallic: 1, ior: 2 },
    },
    surfaces: [
      {
        id: "panel",
        position: { x: 0, y: 0 },
        size: { x: width, y: height },
        elevation: 0,
        thickness: 0,
        shape: { kind: "roundedRect", radius: 0 },
        profile: { kind: "flat" },
        material: "matte",
        castsShadow: false,
        receivesShadow: true,
      },
      {
        id: "btn-a",
        position: { x: Math.floor(width * 0.2), y: Math.floor(height * 0.25) },
        size: { x: 80, y: 44 },
        elevation: 2,
        thickness: 3,
        bevelWidth: 4,
        shape: { kind: "roundedRect", radius: 10 },
        profile: { kind: "bevel" },
        material: "silicone",
        castsShadow: true,
        receivesShadow: true,
      },
      {
        id: "btn-b",
        position: { x: Math.floor(width * 0.55), y: Math.floor(height * 0.5) },
        size: { x: 60, y: 40 },
        elevation: 1,
        thickness: 2,
        shape: { kind: "roundedRect", radius: 8 },
        profile: { kind: "flat" },
        material: "metal",
        castsShadow: true,
        receivesShadow: true,
      },
      {
        id: "badge",
        position: { x: Math.floor(width * 0.1), y: Math.floor(height * 0.65) },
        size: { x: 24, y: 24 },
        elevation: 4,
        thickness: 2,
        shape: { kind: "roundedRect", radius: 6 },
        profile: { kind: "flat" },
        material: "silicone",
        castsShadow: true,
        receivesShadow: true,
      },
    ],
  };
  if (edit === null) return base;
  // dirty ratio 1%..100% by shifting btn-a across the scene width; the rest
  // of the scene is untouched, so the diff is exactly the moved surface.
  return {
    ...base,
    surfaces: base.surfaces.map((s) =>
      s.id === "btn-a"
        ? { ...s, position: { x: Math.floor(width * edit), y: Math.floor(height * 0.25) } }
        : s,
    ),
  };
}

export const SCENE_FAMILIES = Object.freeze({
  simpleRoundedRect: "simple-rounded-rect",
  surfaceGrid: "surface-grid",
  surfaceOverlapStack: "surface-overlap-stack",
  glyphGrid: "glyph-grid",
  maskHeavy: "mask-heavy",
  shortShadow: "short-shadow",
  longShadow: "long-shadow",
  softShadow: "soft-shadow",
  reconstructionHeavy: "reconstruction-heavy",
  partialEdit: "partial-edit",
});