import { parseHeader } from "./encode";
import type { EncodedScene } from "./encode";
import { sanitizeNormalOptions } from "./normal-pass";
import { sanitizeShadowOptions } from "./shadow-pass";
import { sanitizeAmbient } from "./lighting-pass";
import type { LightingPassOptions } from "./lighting-pass";
import { sanitizeCompositeOptions } from "./composite";
import type { CompositeOptions } from "./composite";
import type { NormalOptions } from "../lighting";
import type { ShadowOptions } from "../shadow";
import {
  ENVIRONMENT_REGION,
  EXPOSURE_REGION,
  HEADER_GEOMETRY_REGIONS,
  LIGHT_ANGULAR_RADIUS_REGION,
  LIGHT_DIRECTION_REGION,
  LIGHT_INTENSITY_REGION,
  materialFlagsRanges,
  regionEqual,
  regionsEqual,
} from "./height-inputs";
import { sceneSectionLayout } from "./layout";
import { bytesEqual } from "./tiles";

/**
 * #31 invalidation dependency graph — the explicit small dependency model
 * that replaces the #29 all-or-nothing `GpuScenePipeline.render()`.
 *
 * ## Stages
 *
 * The six pipeline stages, in canonical execution order:
 *
 * ```text
 * upload -> height -> normal -> shadow -> lighting -> presentation
 * ```
 *
 * `height` is the PROVENANCE ROOT of the chain: the #25 `HeightPass`
 * snapshot token is propagated through the normal/shadow/lighting/
 * presentation stages, and every downstream pass rejects foreign or mixed
 * fields (#28/#29 contract). A frame that re-runs `height` MUST re-run every
 * downstream stage; a frame that keeps `height` retained keeps one shared
 * provenance token that makes freshly-executed downstream stages and
 * retained snapshots mutually consistent — provided the exact
 * height-dependent bytes still match (see `heightInputsMatchScene`).
 *
 * ## Invalidation reasons and their downstream closure
 *
 * | reason                | stages it invalidates                       |
 * |-----------------------|---------------------------------------------|
 * | `first-frame`         | all six (nothing retained yet)              |
 * | `viewport`            | all six (render extent / DPR changed)       |
 * | `scene`               | all six (height-input geometry changed)     |
 * | `light-direction`     | upload, shadow, lighting, presentation      |
 * | `light-angular-radius`| upload, shadow, lighting, presentation (#41)|
 * | `light-intensity`     | upload, lighting, presentation              |
 * | `environment`         | upload, lighting, presentation              |
 * | `material-values`     | upload, lighting, presentation              |
 * | `normal-options`      | normal, lighting, presentation              |
 * | `shadow-options`      | shadow, lighting, presentation              |
 * | `lighting-options`    | lighting, presentation                      |
 * | `composite-options`   | presentation only                           |
 * | `debug-target`        | presentation only                           |
 *
 * Scene changes are classified by EXACT byte comparison of the semantic ABI
 * regions (`gpu/height-inputs.ts`), never by a hash alone:
 *
 * - `scene` — any change to the height-dependent bytes (header
 *   geometry/counts/DPR/flags, surface records, mask records, mask alpha
 *   payloads, material flags): full chain, with the #32 partial geometry
 *   planning where valid.
 * - `light-direction` — only the header lightDirection vec4 changed: the
 *   scene bytes are re-uploaded, the shadow/lighting/presentation stages
 *   re-run against the retained height/normal fields.
 * - `light-angular-radius` (#41) — only lightAngularRadius changed: same
 *   closure as `light-direction` (the cone directions feed only the shadow
 *   stage); height/normal stay retained.
 * - `light-intensity` — only lightIntensity changed: lighting +
 *   presentation.
 * - `environment` — only environment vec4 / exposure changed: lighting +
 *   presentation.
 * - `material-values` — only the material-table VALUE bytes changed:
 *   lighting + presentation (the height stage reads material FLAGS only).
 *
 * Every change class includes `upload`: the changed bytes must reach the
 * GPU. The retained height-stage fields are only ever combined with the new
 * upload when `HeightPassProvenance.heightInputs` matches the fresh bytes
 * EXACTLY (passes re-validate on every dispatch).
 *
 * ## Stable canonical fingerprints
 *
 * Object identity alone is insufficient (callers commonly recreate
 * equivalent scene objects), so every input is reduced to a stable
 * canonical fingerprint:
 *
 * - `viewport`: the encoded render extent + DPR (from the ABI header)
 * - `scene`: a deterministic twin-lane FNV-1a hash of the ENTIRE encoded
 *   byte buffer, prefixed with its byte length (encodeScene is
 *   deterministic, so identical scenes produce identical bytes). The hash is
 *   only a SCHEDULING ACCELERATOR: it never authorizes a reuse or a skip —
 *   exact byte comparisons do (a fingerprint collision with different bytes
 *   degrades to the conservative full chain).
 * - options: JSON of the SANITIZED + f32-packed effective values, i.e. the
 *   exact values the passes actually dispatch (equivalent raw objects that
 *   sanitize to the same effective values are NOT invalidations)
 *
 * A byte-identical repeated frame yields an empty reason list: no upload,
 * no compute dispatch, no presentation (the canvas already shows that
 * frame); the caller may request a retained re-presentation explicitly
 * (pipeline `repaint: true`), which adds ONLY the presentation stage.
 */

export type PipelineStage =
  | "upload"
  | "height"
  | "normal"
  | "shadow"
  | "lighting"
  | "presentation";

export type InvalidationReason =
  | "first-frame"
  | "viewport"
  | "scene"
  | "light-direction"
  | "light-intensity"
  | "light-angular-radius"
  | "environment"
  | "material-values"
  | "normal-options"
  | "shadow-options"
  | "lighting-options"
  | "composite-options"
  | "debug-target";

export const ALL_STAGES: readonly PipelineStage[] = [
  "upload",
  "height",
  "normal",
  "shadow",
  "lighting",
  "presentation",
];

/**
 * The dependency graph: every reason maps to exactly the stages it
 * invalidates (the brief's propagation rules). `viewport`/`scene` cascade
 * to the full chain because the encoded extent/bytes feed every stage and
 * the #25 provenance token changes. The semantic scene-change reasons
 * (`light-direction`/`light-intensity`/`light-angular-radius`/
 * `environment`/`material-values`) include `upload` (the changed bytes must
 * reach the GPU) but keep the height/normal stages retained.
 */
export const REASON_STAGES: Readonly<Record<InvalidationReason, readonly PipelineStage[]>> = {
  "first-frame": ALL_STAGES,
  viewport: ALL_STAGES,
  scene: ALL_STAGES,
  "light-direction": ["upload", "shadow", "lighting", "presentation"],
  // #41: the light angular radius feeds only the shadow cone directions
  // (and downstream visibility consumers); the height/normal fields never
  // read it, so they stay retained.
  "light-angular-radius": ["upload", "shadow", "lighting", "presentation"],
  "light-intensity": ["upload", "lighting", "presentation"],
  environment: ["upload", "lighting", "presentation"],
  "material-values": ["upload", "lighting", "presentation"],
  "normal-options": ["normal", "lighting", "presentation"],
  "shadow-options": ["shadow", "lighting", "presentation"],
  "lighting-options": ["lighting", "presentation"],
  "composite-options": ["presentation"],
  "debug-target": ["presentation"],
};

/** Canonical stage order used by `stagesForReasons` / skipped reports. */
const STAGE_RANK = new Map<PipelineStage, number>(
  ALL_STAGES.map((stage, index) => [stage, index]),
);

/**
 * The union of every reason's downstream closure, in canonical order.
 * Only the reasons present in the frame contribute.
 */
export function stagesForReasons(reasons: readonly InvalidationReason[]): PipelineStage[] {
  const set = new Set<PipelineStage>();
  for (const reason of reasons) {
    for (const stage of REASON_STAGES[reason]) {
      set.add(stage);
    }
  }
  return ALL_STAGES.filter((stage) => set.has(stage)).sort(
    (a, b) => (STAGE_RANK.get(a) ?? 0) - (STAGE_RANK.get(b) ?? 0),
  );
}

/** Per-frame scheduler report (reasons + executed/skipped stage sets). */
export interface InvalidationReport {
  /**
   * The invalidation reasons that fired this frame, in canonical order.
   * Empty on a fully retained (byte-identical) frame.
   */
  readonly reasons: readonly InvalidationReason[];
  /** Stages executed this frame, in canonical pipeline order. */
  readonly executed: readonly PipelineStage[];
  /** Stages skipped this frame (the complement of `executed`). */
  readonly skipped: readonly PipelineStage[];
  /**
   * True when the frame executed NOTHING (no upload, no compute, no
   * presentation) — the byte-identical retained case.
   */
  readonly retained: boolean;
}

/**
 * Stable canonical fingerprints of one frame's effective inputs. Two frames
 * are scheduling-equivalent exactly when every field is equal.
 */
export interface FrameKey {
  /** encoded render extent + DPR (from the ABI header) */
  readonly viewport: string;
  /** length-prefixed deterministic hash of the entire encoded scene bytes */
  readonly scene: string;
  /** effective (sanitized + f32-packed) normal options */
  readonly normal: string;
  /** effective (sanitized + f32-packed) shadow options */
  readonly shadow: string;
  /** effective (sanitized + f32-packed) ambient */
  readonly lighting: string;
  /** effective composite options */
  readonly composite: string;
  /** "debug" when the test-only COPY_SRC canvas usage is requested, else "prod" */
  readonly debugTarget: string;
}

/**
 * Compute the stable FrameKey of one encoded frame. `encodeScene` output is
 * deterministic, `parseHeader` is the bounded ABI parse, and every option
 * is reduced to its sanitized effective value so equivalent raw inputs
 * never cause spurious invalidations.
 *
 * Shadow options are sanitized with the REAL frame context because defaults
 * and fallback values depend on scene extent and light direction. Redundant
 * `shadow-options` reasons are suppressed later when a scene/viewport/light
 * reason already invalidates shadow; using a fixed context here would make
 * explicit values collide with context-derived defaults and could skip work.
 */
export function computeFrameKey(
  encoded: EncodedScene,
  input: {
    readonly dpr: number;
    readonly normalOptions?: NormalOptions;
    readonly shadowOptions?: ShadowOptions;
    readonly lightingOptions?: LightingPassOptions;
    readonly compositeOptions?: CompositeOptions;
    readonly debugReadback?: boolean;
  },
): FrameKey {
  const header = parseHeader(encoded.bytes);
  const shadowContext = {
    sceneDiagonal: Math.hypot(
      header.renderWidth / header.dpr,
      header.renderHeight / header.dpr,
    ),
    lightXYLength: Math.hypot(header.lightDirection.x, header.lightDirection.y),
  };
  return {
    viewport: `${header.renderWidth}x${header.renderHeight}@${header.dpr}`,
    scene: fingerprintBytes(encoded.bytes),
    normal: JSON.stringify(sanitizeNormalOptions(input.normalOptions)),
    shadow: JSON.stringify(sanitizeShadowOptions(input.shadowOptions, shadowContext)),
    lighting: String(sanitizeAmbient(input.lightingOptions?.ambient)),
    composite: JSON.stringify(sanitizeCompositeOptions(input.compositeOptions)),
    debugTarget: input.debugReadback === true ? "debug" : "prod",
  };
}

/**
 * Classify the exact byte-level change between two encoded scenes into the
 * semantic scene-change reasons. Purely EXACT byte comparisons of the ABI
 * regions (`gpu/height-inputs.ts`) — a hash is never consulted here:
 *
 * - byte-length / header-geometry / surface / mask / mask-pixel / material-
 *   flags differences -> `["scene"]` (conservative full chain; any layout or
 *   height-input change makes the rest of the classification meaningless)
 * - otherwise the union of the changed light/environment/material regions:
 *   `light-direction`, `light-intensity`, `environment` (environment vec4 or
 *   exposure), `material-values` — each with its own downstream closure
 * - no differences -> `[]` (byte-identical scenes)
 */
export function classifySceneChange(
  prevBytes: Uint8Array,
  nextBytes: Uint8Array,
): InvalidationReason[] {
  if (prevBytes.byteLength !== nextBytes.byteLength) {
    return ["scene"];
  }
  const prevHeader = parseHeader(prevBytes);
  const nextHeader = parseHeader(nextBytes);
  const prevLayout = sceneSectionLayout(prevHeader);
  const nextLayout = sceneSectionLayout(nextHeader);
  // Any height-input byte differs -> the height chain must re-run and no
  // downstream reuse is legal: classify as the conservative full chain. The
  // material FLAGS fields are height-dependent too (the material-id output
  // reads them), so they are checked here rather than with the material
  // VALUES below.
  if (
    !regionsEqual(prevBytes, nextBytes, HEADER_GEOMETRY_REGIONS) ||
    !regionEqual(prevBytes, nextBytes, {
      offset: prevLayout.surfacesOffset,
      byteLength: prevLayout.surfacesByteLength,
    }) ||
    !regionEqual(prevBytes, nextBytes, {
      offset: prevLayout.masksOffset,
      byteLength: prevLayout.masksByteLength,
    }) ||
    !regionEqual(prevBytes, nextBytes, {
      offset: prevLayout.maskPixelsOffset,
      byteLength: prevLayout.maskPixelsByteLength,
    }) ||
    !regionsEqual(prevBytes, nextBytes, materialFlagsRanges(prevHeader, prevLayout))
  ) {
    return ["scene"];
  }
  // Geometry/header/sections are byte-identical, so both layouts agree and
  // the remaining comparisons are positional and in bounds.
  const changes: InvalidationReason[] = [];
  if (!regionEqual(prevBytes, nextBytes, LIGHT_DIRECTION_REGION)) {
    changes.push("light-direction");
  }
  if (!regionEqual(prevBytes, nextBytes, LIGHT_ANGULAR_RADIUS_REGION)) {
    changes.push("light-angular-radius");
  }
  if (!regionEqual(prevBytes, nextBytes, LIGHT_INTENSITY_REGION)) {
    changes.push("light-intensity");
  }
  if (
    !regionEqual(prevBytes, nextBytes, EXPOSURE_REGION) ||
    !regionEqual(prevBytes, nextBytes, ENVIRONMENT_REGION)
  ) {
    changes.push("environment");
  }
  if (
    !regionEqual(prevBytes, nextBytes, {
      offset: prevLayout.materialsOffset,
      byteLength: prevLayout.materialsByteLength,
    })
  ) {
    changes.push("material-values");
  }
  return changes;
}

/**
 * Diff one frame key against the previous key and return the invalidation
 * reasons, in canonical order. A `null` previous key (first frame, or after
 * a failed/disposed frame) always invalidates everything.
 *
 * The scene fingerprint (`key.scene`) is only an ACCELERATOR: when it
 * differs, the semantic classification runs on the EXACT encoded bytes; when
 * it is equal but the bytes differ (fingerprint collision), the conservative
 * full chain (`scene`) is returned — a hash alone never authorizes a skip or
 * a reuse. When the bytes are not supplied (callers that only diff keys),
 * a differing fingerprint falls back to the conservative `scene` reason.
 */
export function computeInvalidationReasons(
  key: FrameKey,
  previous: FrameKey | null,
  nextBytes?: Uint8Array | null,
  prevBytes?: Uint8Array | null,
): InvalidationReason[] {
  if (previous === null) {
    return ["first-frame"];
  }
  const reasons: InvalidationReason[] = [];
  if (key.scene !== previous.scene) {
    if (nextBytes !== undefined && nextBytes !== null && prevBytes !== undefined && prevBytes !== null) {
      for (const reason of classifySceneChange(prevBytes, nextBytes)) {
        reasons.push(reason);
      }
    } else {
      reasons.push("scene");
    }
  } else if (
    nextBytes !== undefined &&
    nextBytes !== null &&
    prevBytes !== undefined &&
    prevBytes !== null &&
    !bytesEqual(prevBytes, nextBytes)
  ) {
    // fingerprint collision: identical hash, different bytes — the hash must
    // never authorize skipping; degrade to the conservative full chain
    reasons.push("scene");
  }
  if (key.viewport !== previous.viewport) {
    reasons.push("viewport");
  }
  if (key.normal !== previous.normal) {
    reasons.push("normal-options");
  }
  const shadowAlreadyInvalidated = reasons.some(
    (reason) =>
      reason === "scene" ||
      reason === "viewport" ||
      reason === "light-direction" ||
      reason === "light-angular-radius" ||
      reason === "first-frame",
  );
  if (key.shadow !== previous.shadow && !shadowAlreadyInvalidated) {
    reasons.push("shadow-options");
  }
  if (key.lighting !== previous.lighting) {
    reasons.push("lighting-options");
  }
  if (key.composite !== previous.composite) {
    reasons.push("composite-options");
  }
  if (key.debugTarget !== previous.debugTarget) {
    reasons.push("debug-target");
  }
  return reasons;
}

/**
 * Full per-frame scheduler report: reasons, executed/skipped sets and the
 * retained flag. `repaint` (an explicit request to re-present the retained
 * frame) adds ONLY the presentation stage when nothing else is dirty.
 *
 * The encoded scenes are supplied for the exact-byte semantic scene
 * classification (`computeInvalidationReasons`); when omitted the scene
 * fingerprint alone is used conservatively.
 */
export function reportInvalidations(
  key: FrameKey,
  previous: FrameKey | null,
  nextBytes?: Uint8Array | null,
  prevBytes?: Uint8Array | null,
  repaint = false,
): InvalidationReport {
  const reasons = computeInvalidationReasons(key, previous, nextBytes, prevBytes);
  const executed = stagesForReasons(reasons);
  if (repaint && !executed.includes("presentation")) {
    executed.push("presentation");
  }
  const executedSet = new Set(executed);
  const skipped = ALL_STAGES.filter((stage) => !executedSet.has(stage));
  return { reasons, executed, skipped, retained: executed.length === 0 };
}

/**
 * Deterministic canonical byte fingerprint: a twin-lane FNV-1a hash of the
 * buffer prefixed with its byte length. Platform/engine independent (no
 * object identity, no `Math.random`, no endianness dependence), so the same
 * effective data always produces the same fingerprint. Used ONLY as a
 * scheduling gate; the length prefix bounds the collision surface.
 */
export function fingerprintBytes(bytes: Uint8Array): string {
  let laneA = 0x811c9dc5;
  let laneB = 0x01000193;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] ?? 0;
    laneA ^= byte;
    laneB ^= byte;
    laneA = Math.imul(laneA, 0x01000193);
    laneB = Math.imul(laneB, 0x811c9dc5);
  }
  return `${bytes.byteLength}:${(laneA >>> 0).toString(16)}${(laneB >>> 0).toString(16)}`;
}
