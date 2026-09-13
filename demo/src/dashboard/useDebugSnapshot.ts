import { useCallback, useEffect, useRef, useState } from "react";
import type { UkiboriProps } from "ukibori";

/**
 * Event-driven `debugState()` snapshots for the Feature Lab.
 *
 * The layer's public `debugState()` is the source of truth. Snapshots are
 * taken only when:
 *
 *   1. the physical layer becomes available,
 *   2. an explicit on-page action asks for one (`refreshNow`), or
 *   3. a previously pending GPU timestamp readback resolves.
 *
 * There is no interval/timer loop: after an action the caller uses
 * `refreshAfterRender()` to wait for the normal scheduled render (a couple of
 * animation frames plus a macrotask, since the layer's default scheduler is
 * `requestAnimationFrame`) and then reads once.
 */

export type ReadyLayer = Parameters<NonNullable<UkiboriProps["onReady"]>>[0];
export type DebugState = ReturnType<NonNullable<ReadyLayer>["debugState"]>;
export type GpuFrame = NonNullable<DebugState["gpuFrame"]>;

export interface DebugSnapshotController {
  /** Latest snapshot (null before the provider created a layer). */
  snapshot: DebugState | null;
  /** Read once, right now, and refresh again when a pending GPU timing resolves. */
  refreshNow: () => void;
  /** Wait for the normal scheduled render, then read once. */
  refreshAfterRender: () => void;
}

export function useDebugSnapshot(layer: ReadyLayer): DebugSnapshotController {
  const [snapshot, setSnapshot] = useState<DebugState | null>(null);
  const mountedRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  /** Last GPU frame this hook attached a timing continuation to. */
  const pendingFrameRef = useRef<GpuFrame | null>(null);

  const clearScheduled = useCallback(() => {
    if (rafRef.current !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = null;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearScheduled();
    };
  }, [clearScheduled]);

  const readNow = useCallback(() => {
    if (layer === null) {
      setSnapshot(null);
      return;
    }
    const next = layer.debugState();
    if (!mountedRef.current) {
      return;
    }
    setSnapshot(next);

    // `gpuTiming` resolves asynchronously after the frame; when it is still
    // pending, attach exactly one continuation per frame object so the
    // resolved result becomes visible without any polling loop.
    const frame = next.gpuFrame;
    if (frame !== null && frame.gpuTiming === null && pendingFrameRef.current !== frame) {
      pendingFrameRef.current = frame;
      void frame.frame.gpuTiming
        .then(() => {
          if (!mountedRef.current) {
            return;
          }
          setSnapshot(layer.debugState());
        })
        .catch(() => {
          // The renderer's timing promise always fulfills; a rejection here is
          // not a snapshot failure, so the last honest snapshot remains.
        });
    }
  }, [layer]);

  const refreshNow = useCallback(() => {
    clearScheduled();
    readNow();
  }, [clearScheduled, readNow]);

  const refreshAfterRender = useCallback(() => {
    clearScheduled();
    if (typeof requestAnimationFrame !== "function") {
      readNow();
      return;
    }
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        // A macrotask after the scheduled frame lets the layer's own
        // requestAnimationFrame render callback run before the snapshot.
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          readNow();
        }, 0);
      });
    });
  }, [clearScheduled, readNow]);

  useEffect(() => {
    pendingFrameRef.current = null;
    if (layer === null) {
      setSnapshot(null);
      return;
    }
    refreshAfterRender();
  }, [layer, refreshAfterRender]);

  return { snapshot, refreshNow, refreshAfterRender };
}
