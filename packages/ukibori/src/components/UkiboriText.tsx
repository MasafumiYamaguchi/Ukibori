import { forwardRef, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { MaskSource } from "ukibori-renderer";
import { Surface, mergeRefs } from "./Surface";
import type { UkiboriTextProps } from "../types";

/**
 * <UkiboriText> — DOM-owned accessible text whose GLYPH participates in the
 * physical scene through the #19 mask geometry path.
 *
 * The component renders a real `<span>` with the text: the text is always
 * DOM-owned, accessible and selectable. After mount (client only) the text
 * is rasterized into an alpha MaskSource (canvas 2d — rasterization stays
 * OUTSIDE the renderer core) and the surface registers with that mask
 * shape, so the glyph becomes physical geometry (height relief + cast
 * shadows, renderer #19).
 *
 * #52 glyph compositing contract: the DOM text ink is delegated to the
 * physical glyph ONLY while the current raster is a FAITHFUL visual
 * representation of the current DOM text:
 *
 * - the raster state is bound to its input identity (`text` + `font` prop +
 *   the typography-relevant style/className props): the moment any of them
 *   change, the previous raster stops being the visual representation
 *   (render-time identity gate — a stale glyph can never suppress the DOM
 *   ink of different text or different typography);
 * - the raster identity additionally carries the COMPUTED typography
 *   fingerprint (the resolved `font`, line-height, letter/word-spacing,
 *   text-transform, ...) read from the live element at rasterization time;
 *   a re-rasterization is skipped only when both the prop identity and the
 *   fingerprint are unchanged;
 * - the rasterization must report `canDelegateInk` (live single-line layout
 *   metrics available, alphabetic anchoring applied, and the DOM typography
 *   faithfully represented by the canvas raster): multi-line/wrapped text,
 *   missing font metrics, an explicit raster font that does not match the
 *   computed DOM font, or DOM typography the canvas cannot mirror
 *   (text-transform, word/letter-spacing without canvas support,
 *   text-decoration/emphasis/stroke ink, vertical writing, custom OpenType
 *   features, ...) keep the DOM ink visible (the mask may stay as physical
 *   geometry, but it is never the visual source of truth);
 * - a rasterization FAILURE for the current value drops the raster entirely
 *   (plain DOM text fallback — no stale previous glyph, the physical-ink
 *   delegation is released, and a later success re-registers).
 *
 * Sizing policy (valid in bare usage, no demo CSS required): the element's
 * measured box is rounded to integer pixel dimensions, the glyph is
 * rasterized at exactly those dimensions, and the span's box is then fixed
 * to them via an explicit layout policy (`display: inline-block` by default
 * so `width`/`height` actually apply in real browser layout). The mask
 * aspect therefore equals the span's box aspect EXACTLY — the #19 isotropic
 * mapping contract holds even for fractional initial text dimensions (the
 * rounding is the policy). The INTEGER mask dimensions are authoritative for
 * the final footprint: a user-supplied `width`/`height` may influence the
 * INITIAL measurement, but the final DOM box always equals the mask
 * dimensions, so the aspects can never diverge.
 *
 * Before an identity-matched raster exists — or if rasterization failed —
 * the component stays PLAIN DOM TEXT: `shape` is `null`, nothing is
 * registered, and no rounded-rectangle substitute is created.
 * Re-rasterization happens on text/font changes, on typography-relevant
 * style/className changes, and after `document.fonts.ready`.
 */

/** Rasterization outcome bound to the exact input identity it was made from. */
interface RasterState {
  text: string;
  font: string | undefined;
  /**
   * #52 review round 3: the typography-relevant prop identity (`className` +
   * the typography style fields) the raster was generated from. A render-time
   * gate compares this against the current props without touching the DOM.
   */
  typographyKey: string;
  /**
   * #52 review round 3: the computed DOM typography fingerprint (resolved
   * font, line-height, letter/word-spacing, text-transform, ...) read from
   * the live element when the raster was generated. Effect-level re-raster
   * decisions compare this against the CURRENT computed typography, so a
   * props-level no-op (e.g. a className change that resolves to the same
   * typography) does not regenerate the mask, while any real typography
   * change invalidates the previous raster.
   */
  fingerprint: string;
  mask: MaskSource;
  /**
   * #52 fidelity gate: the raster is a faithful single-line visual
   * representation of the DOM text (live layout anchored, typography
   * matched/mirrored) and may take over the DOM ink as the physical glyph.
   */
  canDelegateInk: boolean;
}

export const UkiboriText = forwardRef<HTMLElement, UkiboriTextProps>(
  function UkiboriText({ text, font, className, style, ...surfaceProps }, forwardedRef) {
    const innerRef = useRef<HTMLElement | null>(null);
    const [raster, setRaster] = useState<RasterState | null>(null);
    // Effect-local view of the current raster (for the identity/dedupe gate
    // without adding `raster` to the effect dependencies).
    const rasterRef = useRef<RasterState | null>(null);
    rasterRef.current = raster;
    // #52 review round 3: the raster is bound to the typography-relevant
    // prop identity too — direct React changes to the typography style
    // fields or the className re-trigger the rasterization effect, so a
    // stale raster can never stay "current" across a style change.
    const typographyKey = typographyKeyFromProps(style, className);

    useEffect(() => {
      const element = innerRef.current;
      if (element === null || !element.isConnected) {
        return;
      }
      let cancelled = false;
      const rasterize = () => {
        if (cancelled || !element.isConnected) {
          return;
        }
        try {
          const result = rasterizeText(text, element, font);
          const next: RasterState = {
            text,
            font,
            typographyKey,
            fingerprint: result.fingerprint,
            mask: result.mask,
            canDelegateInk: result.canDelegateInk,
          };
          rasterRef.current = next;
          setRaster(next);
        } catch (error) {
          // Rasterization failure for the CURRENT value: drop the raster
          // entirely (including any previous successful raster — it must
          // never keep representing different text or typography). The DOM
          // text remains visible, readable and selectable as the immediate
          // fallback.
          rasterRef.current = null;
          setRaster(null);
          console.error("UkiboriText rasterization failed:", error);
        }
      };
      // #52 review round 3 identity/dedupe gate: re-rasterize when the prop
      // identity changed; SKIP only when the identity matches AND the live
      // computed typography fingerprint is unchanged (an effect re-run
      // without a real DOM typography change must not regenerate the mask).
      const previous = rasterRef.current;
      const identityUnchanged =
        previous !== null &&
        previous.text === text &&
        previous.font === font &&
        previous.typographyKey === typographyKey &&
        currentTypographyFingerprint(element) === previous.fingerprint;
      if (!identityUnchanged) {
        rasterize();
      }
      if (typeof document !== "undefined" && document.fonts !== undefined) {
        // Webfont loading changes the GLYPH SHAPES while the computed
        // typography string stays identical — the fingerprint cannot see it,
        // so this re-rasterization is intentionally unconditional.
        document.fonts.ready.then(rasterize).catch(() => undefined);
      }
      return () => {
        cancelled = true;
      };
    }, [text, font, typographyKey]);

    // Render-time identity gate: only an identity-matched raster represents
    // the current text/font/typography props. Everything else (props changed
    // since the last raster, failed rasterization, fidelity-degraded raster)
    // is the plain DOM fallback — the physical glyph cannot outlive its own
    // input.
    const rasterMatches =
      raster !== null &&
      raster.text === text &&
      raster.font === font &&
      raster.typographyKey === typographyKey;
    // The physical geometry exists whenever an identity-matched raster
    // exists (even a fidelity-degraded one stays valid GEOMETRY); the
    // visual representation authority (DOM ink delegation) additionally
    // requires the fidelity gate.
    const shape: UkiboriTextProps["shape"] =
      rasterMatches ? { kind: "mask", mask: raster.mask } : null;
    const delegateTextInk = rasterMatches && raster.canDelegateInk;

    // Layout policy: the span must honor width/height (inline-block default;
    // a user `display` that does not honor width/height breaks the contract),
    // and the INTEGER mask dimensions are authoritative for the physical
    // footprint — the final DOM box always equals the mask dimensions. The
    // box is fixed only while an identity-matched raster exists.
    const fixedStyle: CSSProperties | undefined =
      rasterMatches
        ? {
            ...style,
            display: style?.display ?? "inline-block",
            width: raster.mask.width,
            height: raster.mask.height,
          }
        : style;

    return (
      <Surface
        {...surfaceProps}
        as="span"
        ref={mergeRefs(forwardedRef, innerRef)}
        className={className}
        style={fixedStyle}
        shape={shape}
        // #52 glyph compositing contract: this component rasterizes ITS OWN
        // DOM text into the mask, and only a faithful single-line raster
        // with matching typography may take the ink over. Generic mask
        // surfaces never set this and keep their DOM text.
        delegateTextInk={delegateTextInk}
      >
        {text}
      </Surface>
    );
  },
);

/** Sizing policy: round the measured box to integer pixels. */
interface RasterizeResult {
  mask: MaskSource;
  /**
   * #52 fidelity gate result: true only when the raster anchors the live
   * DOM layout faithfully — exactly one rendered line box, the required
   * font metrics available, and the DOM typography faithfully represented
   * by the canvas raster (computed-font match for an explicit raster font,
   * plus every mirrorable/unsupported typography property checked below).
   */
  canDelegateInk: boolean;
  /**
   * #52 review round 3: the computed DOM typography fingerprint the raster
   * was generated from (stored in the raster identity).
   */
  fingerprint: string;
}

function rasterizeText(
  text: string,
  element: HTMLElement,
  font: string | undefined,
): RasterizeResult {
  // #52 review round 3: read the element's computed typography ONCE — it
  // feeds the raster font, the fidelity gate and the raster identity
  // fingerprint.
  const typography = readComputedTypography(element);
  const rect = element.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("canvas 2d unavailable");
  }
  ctx.clearRect(0, 0, width, height);
  ctx.font = font ?? typography.font;

  // #52 alignment policy: the rasterized ink must land exactly on the DOM
  // text ink, because the physical glyph becomes the visual representation
  // once the DOM ink is delegated (#52 compositing policy) — a mismatch
  // would show as a glyph position jump across the mask-ready transition.
  //
  // The DOM ink position is measured from the LIVE layout: a Range over the
  // text gives the text's line box (its top/height include the CSS
  // line-height half-leading), and the baseline sits at
  //
  //     lineBoxTop + (lineBoxHeight - (ascent + descent)) / 2 + ascent
  //
  // with the canvas TextMetrics font bounding ascent/descent (the same font
  // metrics CSS line layout resolves). The text is drawn with an ALPHABETIC
  // baseline left-anchored at the line box origin — the same anchor the DOM
  // inline layout uses — so no magic pixel offsets, no DPR-dependent
  // correction and no font-specific constants are involved.
  //
  // Delegation fidelity (#52): the ink is delegated ONLY when this live
  // anchoring actually happened — exactly ONE rendered line box (wrapped or
  // multi-line text cannot be faithfully rasterized by the single fillText)
  // and usable font metrics — AND the DOM typography is faithfully
  // represented by the canvas raster (applyTypographyAndGate below):
  // unsupported typography falls back to the DOM-visible placement and the
  // mask remains physical GEOMETRY only. An explicit `font` prop is allowed
  // to delegate only when its resolved (normalized) typography equals the
  // element's computed font — a typographic mismatch would make the
  // physical glyph an inaccurate representation of the DOM text.
  let anchored = false;
  let canDelegateInk = false;
  try {
    const range = document.createRange();
    range.selectNodeContents(element);
    const lineRects = range.getClientRects();
    const metrics = ctx.measureText(text);
    const ascent = metrics?.fontBoundingBoxAscent;
    const descent = metrics?.fontBoundingBoxDescent;
    const lineBox = lineRects.length === 1 ? lineRects[0] : undefined;
    if (
      lineBox !== undefined &&
      typeof ascent === "number" &&
      Number.isFinite(ascent) &&
      typeof descent === "number" &&
      Number.isFinite(descent) &&
      ascent + descent > 0
    ) {
      // Typography gate for an explicit raster font (the default path draws
      // with the element's own computed font, which matches by
      // construction), followed by the DOM-typography fidelity gate.
      const fontPropMatches =
        font === undefined ||
        (typography.font.length > 0 &&
          normalizeFont(ctx.font) === normalizeFont(typography.font));
      if (fontPropMatches && applyTypographyAndGate(ctx, typography)) {
        const halfLeading = (lineBox.height - (ascent + descent)) / 2;
        const baselineY = lineBox.top - rect.top + halfLeading + ascent;
        const anchorX = lineBox.left - rect.left;
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        ctx.fillStyle = "#fff";
        ctx.fillText(text, anchorX, baselineY);
        anchored = true;
        canDelegateInk = true;
      }
    }
  } catch {
    // fall through to the legacy placement (delegation stays off)
  }
  if (!anchored) {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.fillText(text, width / 2, height / 2);
  }
  const data = ctx.getImageData(0, 0, width, height).data;
  const alpha = new Float32Array(width * height);
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = data[i * 4 + 3] / 255;
  }
  return { mask: { width, height, alpha }, canDelegateInk, fingerprint: typographyFingerprint(typography) };
}

/** Whitespace-insensitive font-string comparison for the typography gate. */
function normalizeFont(font: string): string {
  return font.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * #52 review round 3 — DOM typography fidelity.
 *
 * The canvas 2d fillText raster must be a faithful visual representation of
 * the DOM text ink BEFORE it may take the ink over. The DOM typography is
 * read from the LIVE computed style and classified:
 *
 * - **fallback (never mirrored)**: typography the canvas pipeline cannot
 *   reproduce — `text-transform` (no home-grown upper/lower/capitalize),
 *   vertical writing, text-decoration ink (underline/overline/line-through),
 *   text-emphasis marks, -webkit-text-stroke ink, sub/super variant
 *   position, custom OpenType features/variation axes. Non-default values
 *   keep `canDelegateInk` false (DOM-visible fallback, the mask stays
 *   geometry only).
 * - **mirrored into the canvas when supported**: letter-spacing,
 *   word-spacing, font-kerning, font-stretch, font-variant-caps,
 *   text-rendering and direction. A mirror only counts when the canvas
 *   implementation accepts the computed value AND reads it back; an
 *   unsupported implementation (e.g. a canvas without `letterSpacing`) falls
 *   back to the DOM-visible placement instead of assuming faithfulness.
 * - **default**: everything else needs no mirror.
 *
 * The same read produces the raster identity fingerprint (see
 * `typographyFingerprint`), so a computed typography change re-rasterizes.
 */

interface ComputedTypography {
  font: string;
  lineHeight: string;
  letterSpacing: string;
  wordSpacing: string;
  textTransform: string;
  direction: string;
  writingMode: string;
  fontKerning: string;
  fontStretch: string;
  fontVariantCaps: string;
  fontVariantPosition: string;
  fontFeatureSettings: string;
  fontVariationSettings: string;
  textRendering: string;
  textDecorationLine: string;
  textEmphasisStyle: string;
  webkitTextStrokeWidth: string;
}

const TYPOGRAPHY_FIELDS = [
  "font",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "textTransform",
  "direction",
  "writingMode",
  "fontKerning",
  "fontStretch",
  "fontVariantCaps",
  "fontVariantPosition",
  "fontFeatureSettings",
  "fontVariationSettings",
  "textRendering",
  "textDecorationLine",
  "textEmphasisStyle",
  "webkitTextStrokeWidth",
] as const;

function readComputedTypography(element: HTMLElement): ComputedTypography {
  const computed = getComputedStyle(element);
  const style = computed as unknown as Record<string, unknown>;
  const read = (field: string): string => {
    const value = style[field];
    return typeof value === "string" ? value : "";
  };
  return {
    font: read("font"),
    lineHeight: read("lineHeight"),
    letterSpacing: read("letterSpacing"),
    wordSpacing: read("wordSpacing"),
    textTransform: read("textTransform"),
    direction: read("direction"),
    writingMode: read("writingMode"),
    fontKerning: read("fontKerning"),
    fontStretch: read("fontStretch"),
    fontVariantCaps: read("fontVariantCaps"),
    fontVariantPosition: read("fontVariantPosition"),
    fontFeatureSettings: read("fontFeatureSettings"),
    fontVariationSettings: read("fontVariationSettings"),
    textRendering: read("textRendering"),
    textDecorationLine: read("textDecorationLine"),
    textEmphasisStyle: read("textEmphasisStyle"),
    webkitTextStrokeWidth: read("webkitTextStrokeWidth"),
  };
}

/** Stable fingerprint over every computed typography field that affects the
 * raster's visual fidelity or identity ("" = property not resolvable, e.g.
 * jsdom — treated as the default by the gate and stable in the identity). */
function typographyFingerprint(typography: ComputedTypography): string {
  return TYPOGRAPHY_FIELDS.map((field) => typography[field]).join("\u0000");
}

function currentTypographyFingerprint(element: HTMLElement): string {
  return typographyFingerprint(readComputedTypography(element));
}

/**
 * A resolvable-but-default value or an EMPTY string (the property is not
 * resolvable by this environment, e.g. jsdom's computed style) counts as the
 * default. Real browsers always resolve these properties, so "" never masks
 * a real transformation there.
 */
function isDefaultTypographyValue(value: string, ...defaults: string[]): boolean {
  return value === "" || defaults.includes(value);
}

/** Mirror a computed typography value into the canvas drawing state; the
 * mirror only counts when the implementation accepts the value AND reads it
 * back (an unsupported canvas implementation falls back to DOM-visible). */
function mirrorCanvasTypography(
  ctx: CanvasRenderingContext2D,
  property: string,
  value: string,
): boolean {
  if (!(property in ctx)) {
    return false;
  }
  try {
    (ctx as unknown as Record<string, unknown>)[property] = value;
  } catch {
    return false;
  }
  const applied = (ctx as unknown as Record<string, unknown>)[property];
  if (typeof applied !== "string") {
    return false;
  }
  if (applied === value) {
    return true;
  }
  // Accept an equivalent px normalization (float noise / unit rounding).
  const expected = Number.parseFloat(value);
  const actual = Number.parseFloat(applied);
  return Number.isFinite(expected) && Number.isFinite(actual) && Math.abs(expected - actual) < 0.01;
}

/** The #52 typography fidelity gate (BLOCKER 1): verify — or faithfully
 * mirror — the DOM typography on the canvas raster. Returns false (DOM
 * ink stays visible) whenever the raster would not represent the DOM text
 * faithfully. Must be called AFTER `ctx.font` is assigned (setting the font
 * resets the canvas drawing state). */
function applyTypographyAndGate(
  ctx: CanvasRenderingContext2D,
  typography: ComputedTypography,
): boolean {
  // Hard fallbacks: DOM-only ink or metrics the canvas raster cannot mirror.
  if (!isDefaultTypographyValue(typography.textTransform, "none")) {
    // text-transform changes the DOM glyphs (play -> PLAY) while fillText
    // draws the raw string; a home-grown transformation would not be a
    // typography engine — fallback instead of assuming faithfulness.
    return false;
  }
  if (!isDefaultTypographyValue(typography.writingMode, "horizontal-tb")) {
    return false;
  }
  // Extra DOM ink the fillText raster never paints.
  if (!isDefaultTypographyValue(typography.textDecorationLine, "none")) {
    return false;
  }
  if (!isDefaultTypographyValue(typography.textEmphasisStyle, "none")) {
    return false;
  }
  if (!isDefaultTypographyValue(typography.webkitTextStrokeWidth, "0px")) {
    return false;
  }
  if (!isDefaultTypographyValue(typography.fontVariantPosition, "normal")) {
    return false;
  }
  // Custom OpenType shaping the canvas pipeline does not take from CSS.
  if (!isDefaultTypographyValue(typography.fontFeatureSettings, "normal")) {
    return false;
  }
  if (!isDefaultTypographyValue(typography.fontVariationSettings, "normal")) {
    return false;
  }
  // Mirrorable drawing state: apply only when supported AND confirmed back.
  if (!isDefaultTypographyValue(typography.letterSpacing, "normal", "0px")) {
    if (!mirrorCanvasTypography(ctx, "letterSpacing", typography.letterSpacing)) {
      return false;
    }
  }
  if (!isDefaultTypographyValue(typography.wordSpacing, "normal", "0px")) {
    if (!mirrorCanvasTypography(ctx, "wordSpacing", typography.wordSpacing)) {
      return false;
    }
  }
  if (!isDefaultTypographyValue(typography.fontKerning, "auto")) {
    if (!mirrorCanvasTypography(ctx, "fontKerning", typography.fontKerning)) {
      return false;
    }
  }
  if (!isDefaultTypographyValue(typography.fontStretch, "normal", "100%")) {
    if (!mirrorCanvasTypography(ctx, "fontStretch", typography.fontStretch)) {
      return false;
    }
  }
  if (!isDefaultTypographyValue(typography.fontVariantCaps, "normal")) {
    if (!mirrorCanvasTypography(ctx, "fontVariantCaps", typography.fontVariantCaps)) {
      return false;
    }
  }
  if (!isDefaultTypographyValue(typography.textRendering, "auto")) {
    if (!mirrorCanvasTypography(ctx, "textRendering", typography.textRendering)) {
      return false;
    }
  }
  if (!isDefaultTypographyValue(typography.direction, "ltr")) {
    if (!mirrorCanvasTypography(ctx, "direction", typography.direction)) {
      return false;
    }
  }
  return true;
}

/**
 * #52 review round 3 — the raster identity's PROPS half: the typography
 * style fields plus the className. A render-time gate compares this against
 * the current props (no DOM access), so a direct React typography change
 * invalidates the previous raster immediately.
 */
const TYPOGRAPHY_STYLE_KEYS = [
  "font",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontStretch",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "textTransform",
  "fontKerning",
  "fontVariant",
  "fontVariantCaps",
  "fontVariantPosition",
  "fontFeatureSettings",
  "fontVariationSettings",
  "textRendering",
  "direction",
  "writingMode",
  "textDecorationLine",
  "textEmphasisStyle",
  "WebkitTextStrokeWidth",
] as const;

function typographyKeyFromProps(
  style: CSSProperties | undefined,
  className: string | undefined,
): string {
  const parts: string[] = [className ?? ""];
  if (style !== undefined) {
    const record = style as unknown as Record<string, unknown>;
    for (const key of TYPOGRAPHY_STYLE_KEYS) {
      const value = record[key];
      if (value !== undefined) {
        parts.push(`${key}:${String(value)}`);
      }
    }
  }
  return parts.join("|");
}
