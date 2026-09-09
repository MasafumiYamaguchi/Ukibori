/** Deterministic, path-data-only gear used by the real-browser SVG tests. */
export function makeGearPath(teeth = 16, outerRadius = 46, rootRadius = 38, holeRadius = 12) {
  if (!Number.isInteger(teeth) || teeth < 12 || teeth > 24) {
    throw new RangeError("gear fixture teeth must be in [12, 24]");
  }
  const points = [];
  for (let i = 0; i < teeth * 2; i++) {
    const angle = (i * Math.PI) / teeth;
    const radius = i % 2 === 0 ? outerRadius : rootRadius;
    points.push([50 + Math.cos(angle) * radius, 50 + Math.sin(angle) * radius]);
  }
  const outer = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(6)} ${y.toFixed(6)}`).join("") + "Z";
  const holePoints = 32;
  const hole = Array.from({ length: holePoints }, (_, i) => {
    const angle = (i * Math.PI * 2) / holePoints;
    return `${i === 0 ? "M" : "L"}${(50 + Math.cos(angle) * holeRadius).toFixed(6)} ${(50 + Math.sin(angle) * holeRadius).toFixed(6)}`;
  }).join("") + "Z";
  return `${outer}${hole}`;
}

export const GEAR_SHAPE = {
  kind: "svgPath",
  d: makeGearPath(),
  viewBox: [0, 0, 100, 100],
  fillRule: "evenodd",
};

export function maskAlphaAt(mask, x, y) {
  return mask.alpha[y * mask.width + x];
}

