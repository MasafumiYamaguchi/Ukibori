import { parseHeader } from "./encode";
import type { EncodedScene } from "./encode";
import { sanitizeNormalOptions } from "./normal-pass";
import { sanitizeShadowOptions } from "./shadow-pass";
import type { ShadowSanitizeContext } from "./shadow-pass";
import { sanitizeAmbient } from "./lighting-pass";
import type { LightingPassOptions } from "./lighting-pass";
import { sanitizeCompositeOptions } from "./composite";
import type { CompositeOptions } from "./composite";
import type { NormalOptions } from "../lighting";
import type { ShadowOptions } from "../shadow";

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
 * snapshot token (and its exact `sceneBytes`) is propagated through the
 * normal/shadow/lighting/presentation stages, and every downstream pass
 * rejects foreign or mixed fields (#28/#29 contract). Consequently a frame
 * that re-runs `height` MUST re-run every downstream stage, and a frame
 * that keeps `height` retained keeps one shared provenance token that makes
 * freshly-executed downstream stages and retained snapshots mutually
 * consistent.
 *
 * ## Invalidation reasons and their downstream closure
 *
 * | reason            | stages it invalidates                          |
 * |-------------------|------------------------------------------------|
 * | `first-frame`     | all six (nothing retained yet)                 |
 * | `viewport`        | all six (render extent / DPR changed)          |
 * | `scene`           | all six (any encoded byte changed)             |
 * | `normal-options`  | normal, lighting, presentation                 |
 * | `shadow-options`  | shadow, lighting, presentation                 |
 * | `lighting-options`| lighting, presentation                         |
 * | `composite-options`| presentation only                              |
 * | `debug-target`    | presentation only                              |
 *
 * `scene` subsumes `viewport`-independent geometry changes AND
 * environment/exposure/light changes: they are all packed into the same ABI
 * scene buffer by `encodeScene`, and the #25 provenance carries the EXACT
 * `bytes` object, so any byte change requires a fresh height dispatch and
 * therefore the full chain (this preserves the #30 byte-for-byte
 * provenance contract; only pass-OPTION changes may skip upstream stages).
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
 *   deterministic, so identical scenes produce identical bytes)
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
 * the #25 provenance token changes.
 */
export const REASON_STAGES: Readonly<Record<InvalidationReason, readonly PipelineStage[]>> = {
  "first-frame": ALL_STAGES,
  viewport: ALL_STAGES,
  scene: ALL_STAGES,
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
  const sceneDiagonal = Math.hypot(
    header.renderWidth / header.dpr,
    header.renderHeight / header.dpr,
  );
  const lightXYLength = Math.hypot(header.lightDirection.x, header.lightDirection.y);
  const shadowContext: ShadowSanitizeContext = { sceneDiagonal, lightXYLength };
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
 * Diff one frame key against the previous key and return the invalidation
 * reasons, in canonical order. A `null` previous key (first frame, or after
 * a failed/disposed frame) always invalidates everything.
 */
export function computeInvalidationReasons(
  key: FrameKey,
  previous: FrameKey | null,
): InvalidationReason[] {
  if (previous === null) {
    return ["first-frame"];
  }
  const reasons: InvalidationReason[] = [];
  if (key.scene !== previous.scene) {
    reasons.push("scene");
  }
  if (key.viewport !== previous.viewport) {
    reasons.push("viewport");
  }
  if (key.normal !== previous.normal) {
    reasons.push("normal-options");
  }
  if (key.shadow !== previous.shadow) {
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
 */
export function reportInvalidations(
  key: FrameKey,
  previous: FrameKey | null,
  repaint: boolean,
): InvalidationReport {
  const reasons = computeInvalidationReasons(key, previous);
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
