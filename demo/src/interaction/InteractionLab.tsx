import * as Toggle from "@radix-ui/react-toggle";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Material } from "ukibori";
import { Bake, Surface, Ukibori, UkiboriText, useSurfaceProgress } from "ukibori";
import { SliderControl } from "../dashboard/SliderControl";
import type { ReadyLayer } from "../dashboard/useDebugSnapshot";
import { useDebugSnapshot } from "../dashboard/useDebugSnapshot";
import { PressSurface } from "./PressSurface";
import "./style.css";

const MASK = { kind: "svgPath" as const, d: "M1 1H15V15H1ZM5 5V11H11V5Z", viewBox: [0, 0, 16, 16] as const, fillRule: "evenodd" as const };
const LIGHT = { x: -0.6, y: -0.5, z: 0.7 };
const SHADOW = { samples: 8 as const, maxDistance: 48 };
const STAGE_STYLE = { position: "relative" as const, width: "100%", height: 372 };
const formatProgress = (value: number) => value.toFixed(3);

export function InteractionLab() {
  const [backend, setBackend] = useState<"auto" | "cpu" | "css">("auto");
  const [layer, setLayer] = useState<ReadyLayer>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [target, setTarget] = useState(0);
  const [grain, setGrain] = useState(true);
  const [strength, setStrength] = useState(0.4);
  const [scale, setScale] = useState(4);
  const [seed, setSeed] = useState(42);
  const [effects, setEffects] = useState(false);
  const progress = useSurfaceProgress(target, { reducedMotion: reduced ? true : "auto" });
  const { snapshot, refreshAfterRender, refreshNow } = useDebugSnapshot(layer);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const materials = useMemo<Record<string, Material>>(() => {
    const smooth: Material = { baseColor: { r: 0.32, g: 0.39, b: 0.46 }, roughness: 0.5, metallic: 0,
      emissive: effects ? { r: 0.12, g: 0.035, b: 0.008 } : undefined };
    return { matte: smooth, silicone: { ...smooth, grain: grain ? { scale, strength, seed } : undefined } };
  }, [effects, grain, scale, strength, seed]);
  const compositing = useMemo(() => ({ emissive: effects ? { bloom: { intensity: 0.5, radius: 8 } } : undefined }), [effects]);
  const onError = useCallback((value: unknown) => setError(String(value)), []);
  const onReady = useCallback((value: ReadyLayer) => { setLayer(value); setError(null); }, []);
  const observePress = useCallback(() => {
    if (settleTimer.current !== null) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(refreshAfterRender, 180);
  }, [refreshAfterRender]);
  useEffect(() => {
    refreshAfterRender();
  }, [progress, materials, compositing, disabled, reduced, selected, refreshAfterRender]);
  useEffect(() => () => {
    if (settleTimer.current !== null) clearTimeout(settleTimer.current);
  }, [observePress]);
  useEffect(() => () => {
    if (pulseTimer.current !== null) clearTimeout(pulseTimer.current);
  }, []);
  const changeTarget = (value: number) => {
    if (pulseTimer.current !== null) clearTimeout(pulseTimer.current);
    setTarget(value);
  };
  const playOnce = () => {
    if (pulseTimer.current !== null) clearTimeout(pulseTimer.current);
    setTarget(1);
    pulseTimer.current = setTimeout(() => setTarget(0), 550);
  };
  const frame = snapshot?.gpuFrame;
  const actualBackend = backend === "css" ? "CSS近似" : snapshot?.backend === "webgpu" ? "WebGPU" : snapshot ? "CPU" : "準備中";
  const timing = frame?.gpuTiming;
  const heightMs = timing?.status === "ok" ? timing.passGpuMs.height : undefined;
  return (
    <section className="interaction-lab" aria-labelledby="interaction-heading">
      <header className="il-heading">
        <div><p className="il-eyebrow">R0–R3 · DYNAMIC SURFACES</p><h2 id="interaction-heading">押す、戻る、質感を変える。</h2>
          <p>静的な文字・SVGを残したまま高さを動かし、同じ形のSurfaceで樹脂grainを見比べます。</p></div>
        <span className="il-backend" data-testid="actual-backend">{actualBackend}</span>
      </header>
      <div className="il-layout">
        <aside className="il-controls" aria-label="デモの設定">
          <label className="il-select">描画経路<select value={backend} onChange={event => setBackend(event.target.value as typeof backend)}>
            <option value="auto">Auto（WebGPU優先）</option><option value="cpu">CPU参照描画</option><option value="css">CSS近似</option>
          </select></label>
          <fieldset><legend>01 / 高さを動かす</legend>
            <SliderControl label="押下の目標値" value={target} min={0} max={1} step={0.025} format={formatProgress} onChange={changeTarget} />
            <button className="il-button" type="button" onClick={playOnce}>押下と戻りを1回再生</button>
            <label className="il-check"><input type="checkbox" checked={disabled} onChange={event => setDisabled(event.target.checked)} />操作ボタンを無効にする</label>
            <label className="il-check"><input type="checkbox" checked={reduced} onChange={event => setReduced(event.target.checked)} />アニメーションを省略</label>
            <p className="il-note">省略OFFではOSの視差効果設定に従います。右のボタンはSpace / Enter・タッチでも押せます。</p>
          </fieldset>
          <fieldset><legend>02 / 樹脂grainを見比べる</legend>
            <label className="il-check"><input type="checkbox" checked={grain} disabled={backend === "css"} onChange={event => setGrain(event.target.checked)} />Grainを有効にする</label>
            <SliderControl label="粒の強さ" value={strength} min={0} max={1} step={0.05} format={value => value.toFixed(2)} onChange={setStrength} disabled={!grain || backend === "css"} />
            <SliderControl label="粒幅（CSS px）" value={scale} min={1} max={12} step={0.5} onChange={setScale} disabled={!grain || backend === "css"} />
            <button className="il-button" type="button" disabled={!grain || backend === "css"} onClick={() => setSeed(value => (value + 1) >>> 0)}>模様を変える</button>
            <span className="il-seed">seed <output>{seed}</output></span>
            <p className="il-note">変わるのはroughnessだけ。輪郭・高さ・影の形は共通です。解像できない細かな粒は弱まります。</p>
          </fieldset>
          <label className="il-check"><input type="checkbox" checked={effects} onChange={event => setEffects(event.target.checked)} disabled={backend === "css"} />Emission / bloomを重ねる</label>
        </aside>
        <div className="il-preview">
          <div className="il-scene-card">
            <div className="il-scene-title"><h3>触って比較する</h3><span>同じ光・同じ形</span></div>
            <Ukibori className="il-stage" backend={backend} gpuProfiling onReady={onReady} onError={onError} dpr={1} margin={12}
              light={LIGHT} angularRadius={0.12} shadow={SHADOW} highContrast={false} basePlaneColor="#cbd0d2"
              materials={materials} compositing={compositing} style={STAGE_STYLE}>
              <Bake><UkiboriText text="UI" elevation={4} thickness={1} style={{ position: "absolute", left: 28, top: 18, font: "bold 30px Arial" }} />
                <Surface shape={MASK} elevation={5} style={{ position: "absolute", left: 96, top: 24, width: 28, height: 28 }} /></Bake>
              <span className="il-scene-caption il-mask-caption">静的な文字・SVG mask</span>
              <Toggle.Root asChild pressed={selected} onPressedChange={setSelected} disabled={disabled} aria-label="選択状態を切り替える">
                <PressSurface className="il-press" selected={selected} reducedMotion={reduced ? true : "auto"}
                  onPointerDown={observePress} onPointerUp={observePress} onPointerCancel={observePress} onKeyDown={observePress} onKeyUp={observePress} onBlur={observePress}>押して選択</PressSurface>
              </Toggle.Root>
              <Surface className="il-manual" material="silicone" elevation={8 - 6 * progress} thickness={3 - 2 * progress} bevelWidth={4} data-progress={progress}>
                スライダー連動
              </Surface>
              <span className="il-scene-caption il-press-caption">{disabled ? "無効" : selected ? "選択中" : "未選択"} · native button</span>
              <span className="il-scene-caption il-manual-caption">進捗 <output data-testid="progress">{progress.toFixed(3)}</output></span>
              <Surface className="il-swatch il-smooth" material="matte" elevation={5} thickness={2} bevelWidth={8} />
              <Surface className="il-swatch il-grain" material="silicone" elevation={5} thickness={2} bevelWidth={8} />
              <span className="il-scene-caption il-smooth-caption">Grain OFF</span>
              <span className="il-scene-caption il-grain-caption">Grain {backend === "css" ? "省略" : grain ? "ON" : "OFF"}</span>
            </Ukibori>
            <p className="il-caption">{backend === "css" ? "CSS近似では2枚ともgrainを省略しています。" : "下の2枚は同じ材質の設定で、右だけにgrainを適用しています。"}</p>
          </div>
          {backend === "css" ? <p className="il-notice">CSSのbox-shadow近似です。Grain・発光・bloomとGPU計測は省略します。</p>
            : snapshot?.gpuFallbackReason ? <p className="il-notice">CPUで描画しています: {snapshot.gpuFallbackReason}</p> : null}
          {error ? <p className="il-notice" role="status">描画の通知: {error}</p> : null}
          <section className="il-observation" aria-labelledby="il-observe-heading">
            <div className="il-scene-title"><h3 id="il-observe-heading">最後のフレームを観測</h3><button className="il-button" type="button" onClick={refreshNow}>観測値を更新</button></div>
            <dl className="il-metrics">
              <div><dt>描画回数</dt><dd data-testid="render-serial">{snapshot ? snapshot.backend === "webgpu" ? snapshot.gpuRenderSerial : snapshot.sceneBuildSerial : "—"}</dd></div>
              <div><dt>Mask SDF再生成</dt><dd data-testid="sdf-passes">{frame ? `${frame.frame.height.maskSdfPasses} 回` : "—"}</dd></div>
              <div><dt>Height compose</dt><dd data-testid="height-passes">{frame ? `${frame.frame.height.composePasses} pass` : "—"}</dd></div>
              <div><dt>GPU height時間</dt><dd>{heightMs === undefined ? "—" : `${heightMs.toFixed(3)} ms`}</dd></div>
            </dl>
            <ul><li>WebGPUでは高さだけを動かすと、静的maskのSDFを再利用します。</li><li>Grainだけの変更では高さと影を保持し、照明を更新します。</li><li>操作を止めて観測値を更新すると、描画回数が増えないことを確認できます。</li></ul>
            <p className="il-note">観測値は操作後と更新ボタンで取得します。自動再生・常時ポーリングはありません。GPU時間はtimestamp-query対応時だけ表示し、CPU/CSSでは「—」になります。</p>
          </section>
        </div>
      </div>
    </section>
  );
}
