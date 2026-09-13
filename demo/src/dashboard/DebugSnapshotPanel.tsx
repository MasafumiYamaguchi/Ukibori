import type { ReactNode } from "react";
import type { DebugState, GpuFrame } from "./useDebugSnapshot";

/**
 * Presentational Feature Lab panel for the on-demand `debugState()` snapshot.
 * It renders every documented field the task asks for and distinguishes host
 * wall-clock measurements from resolved timestamp-query GPU timings.
 */

function Item({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="fl-debug-item">
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function GpuTiming({ frame }: { frame: GpuFrame }) {
  const timing = frame.gpuTiming;
  if (timing === null) {
    return (
      <p className="hint">
        Pending: the timestamp-query readback for this frame has not resolved yet. The snapshot
        will refresh once it does.
      </p>
    );
  }
  return (
    <dl className="fl-debug-grid">
      <Item term="GPU timing status">{timing.status}</Item>
      <Item term="GPU total">
        {timing.totalGpuMs === null
          ? "—"
          : `${timing.totalGpuMs.toFixed(3)} ms (sum of real GPU pass durations)`}
      </Item>
      <Item term="GPU per pass">
        {Object.keys(timing.passGpuMs).length === 0
          ? "—"
          : Object.entries(timing.passGpuMs)
              .map(([stage, ms]) => `${stage}: ${ms === undefined ? "—" : ms.toFixed(3)} ms`)
              .join(" · ")}
      </Item>
      {timing.reason !== undefined ? <Item term="GPU timing note">{timing.reason}</Item> : null}
    </dl>
  );
}

export function DebugSnapshotPanel({
  snapshot,
  refreshNow,
}: {
  snapshot: DebugState | null;
  refreshNow: () => void;
}) {
  return (
    <section className="fl-section" aria-labelledby="fl-debug-heading">
      <div className="fl-section-head">
        <div>
          <h3 id="fl-debug-heading">debugState snapshot</h3>
          <p>
            Read on demand only — this dashboard never polls. A snapshot refreshes after each
            explicit action once the normal scheduled render settles, again when a pending GPU
            timing readback resolves, or immediately from the manual button.
          </p>
        </div>
        <button type="button" className="btn fl-refresh" onClick={refreshNow}>
          Refresh diagnostics
        </button>
      </div>

      {snapshot === null ? (
        <p className="hint">
          No physical layer yet (SSR, CSS approximation fallback, or initialization still in
          flight).
        </p>
      ) : (
        <>
          <dl className="fl-debug-grid" aria-label="Layer counters">
            <Item term="backend">{snapshot.backend}</Item>
            <Item term="gpuFallbackReason">{snapshot.gpuFallbackReason ?? "—"}</Item>
            <Item term="renderSerial">{snapshot.renderSerial}</Item>
            <Item term="measureSerial">{snapshot.measureSerial}</Item>
            <Item term="sceneBuildSerial">{snapshot.sceneBuildSerial}</Item>
            <Item term="gpuRenderSerial">{snapshot.gpuRenderSerial}</Item>
            <Item term="nodeCount">{snapshot.nodeCount}</Item>
            <Item term="dirtyCount">{snapshot.dirtyCount}</Item>
            <Item term="bakedSurfaceCount">{snapshot.bakedSurfaceCount}</Item>
            <Item term="dynamicSurfaceCount">{snapshot.dynamicSurfaceCount}</Item>
            <Item term="bakeBoundaryCount">{snapshot.bakeBoundaryCount}</Item>
            <Item term="lastRebakeSurfaceCount">{snapshot.lastRebakeSurfaceCount}</Item>
            <Item term="svgRasterizationCount">{snapshot.svgRasterizationCount}</Item>
            <Item term="svgCacheSize">{snapshot.svgCacheSize}</Item>
          </dl>

          <h4 className="fl-debug-subhead">GPU frame</h4>
          {snapshot.gpuFrame === null ? (
            <p className="hint">
              No GPU frame: the active render path is <code>{snapshot.backend}</code>
              {snapshot.gpuFallbackReason === null
                ? " and no WebGPU frame has been presented."
                : ` (fallback reason: ${snapshot.gpuFallbackReason}).`}
            </p>
          ) : (
            <>
              <dl className="fl-debug-grid" aria-label="GPU frame details">
                <Item term="hostRenderMs (whole render call, not GPU completion)">
                  {snapshot.gpuFrame.hostRenderMs.toFixed(3)}
                </Item>
                <Item term="render size">
                  {`${snapshot.gpuFrame.frame.renderWidth} × ${snapshot.gpuFrame.frame.renderHeight} texels @ dpr ${snapshot.gpuFrame.frame.dpr}`}
                </Item>
                <Item term="scheduler retained">
                  {snapshot.gpuFrame.frame.invalidation.retained ? "yes — nothing executed" : "no"}
                </Item>
                <Item term="invalidation reasons">
                  {snapshot.gpuFrame.frame.invalidation.reasons.length === 0
                    ? "—"
                    : snapshot.gpuFrame.frame.invalidation.reasons.join(", ")}
                </Item>
                <Item term="executed stages">
                  {snapshot.gpuFrame.frame.invalidation.executed.join(" → ")}
                </Item>
                <Item term="partial plan">
                  {`${snapshot.gpuFrame.frame.planning.mode} — ${snapshot.gpuFrame.frame.planning.reason}`}
                </Item>
                <Item term="dirty tiles">
                  {`${snapshot.gpuFrame.frame.planning.dirtyTileCount} / ${snapshot.gpuFrame.frame.planning.totalTileCount}`}
                </Item>
                <Item term="dirty / dispatch / total texels">
                  {`${snapshot.gpuFrame.frame.planning.dirtyTexels} / ${snapshot.gpuFrame.frame.planning.dispatchTexels} / ${snapshot.gpuFrame.frame.planning.totalTexels}`}
                </Item>
                <Item term="planner host ms">
                  {snapshot.gpuFrame.frame.planning.planningHostMs.toFixed(3)}
                </Item>
                <Item term="frame upload">
                  {`${snapshot.gpuFrame.frame.upload.writeCalls} writes, ${snapshot.gpuFrame.frame.upload.bytesUploaded} bytes, ${snapshot.gpuFrame.frame.upload.newAllocations} new buffers`}
                </Item>
                <Item term="frame pipeline (host)">
                  {`${snapshot.gpuFrame.frame.frame.submissions} submissions, ${snapshot.gpuFrame.frame.frame.dispatchCount} dispatches, ${snapshot.gpuFrame.frame.frame.hostMs.toFixed(3)} ms`}
                </Item>
                <Item term="reconstruction active">
                  {snapshot.gpuFrame.frame.reconstructionActive
                    ? "yes (soft path)"
                    : "no (raw/hard path)"}
                </Item>
                <Item term="cumulative frames">
                  {`${snapshot.gpuFrame.frame.totals.frames} rendered, ${snapshot.gpuFrame.frame.totals.skippedFrames} retained-skipped`}
                </Item>
                <Item term="cumulative totals (host)">
                  {`${snapshot.gpuFrame.frame.totals.submissions} submissions, ${snapshot.gpuFrame.frame.totals.dispatches} dispatches, ${snapshot.gpuFrame.frame.totals.hostMs.toFixed(3)} ms`}
                </Item>
              </dl>
              <h4 className="fl-debug-subhead">Resolved GPU timing</h4>
              <GpuTiming frame={snapshot.gpuFrame} />
            </>
          )}
        </>
      )}
    </section>
  );
}
