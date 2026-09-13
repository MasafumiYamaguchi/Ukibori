import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Real-browser Playground fixture parity.
 *
 * The glyph geometry IS the canvas-rasterized text mask, so the harness must
 * style the production `<UkiboriText>` with the ACTUAL Playground typography
 * and layout — not a hand-written look-alike. These two classes are copied
 * from demo/src/index.css; this test fails if the harness drifts from the
 * demo (font family / weight / size / letter-spacing / line-height / panel
 * flex+padding are all physical inputs).
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const demoCss = readFileSync(resolve(repoRoot, "demo/src/index.css"), "utf8");
const harnessHtml = readFileSync(resolve(here, "glyph-lighting.html"), "utf8");
const harnessMjs = readFileSync(resolve(here, "glyph-lighting.mjs"), "utf8");

function ruleDeclarations(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (match === null) return null;
  const declarations = new Map();
  for (const raw of match[1].split(";")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const index = line.indexOf(":");
    if (index === -1) continue;
    const property = line.slice(0, index).trim().toLowerCase();
    const value = line
      .slice(index + 1)
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    declarations.set(property, value);
  }
  return declarations;
}

describe("Playground glyph fixture CSS parity", () => {
  it.each([".demo-play-panel", ".ukibori-text"])(
    "harness %s declarations match demo/src/index.css",
    (selector) => {
      const demo = ruleDeclarations(demoCss, selector);
      const harness = ruleDeclarations(harnessHtml, selector);
      expect(demo).not.toBeNull();
      expect(harness).not.toBeNull();
      expect(harness).toEqual(demo);
    },
  );

  it("pins the Playground panel typography values", () => {
    const text = ruleDeclarations(demoCss, ".ukibori-text");
    expect(text.get("font-size")).toBe("3.2rem");
    expect(text.get("font-weight")).toBe("800");
    expect(text.get("letter-spacing")).toBe("0.12em");
    expect(text.get("line-height")).toBe("1");
    expect(text.get("font-family")).toContain("monospace");
  });

  it("uses the Playground classes plus an explicit capture-stage placement class", () => {
    expect(harnessMjs).toContain('"demo-play-panel harness-play-panel"');
    expect(harnessHtml).toContain(".harness-play-panel");
  });
});
