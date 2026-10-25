import * as Toggle from "@radix-ui/react-toggle";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Bake, Surface, Ukibori, UkiboriText } from "ukibori";
import { PressSurface } from "./PressSurface";
import "./style.css";
function Demo() {
  const [selected, setSelected] = useState(false);
  const [backend, setBackend] = useState<"auto" | "cpu" | "css">("auto");
  const [effects, setEffects] = useState(false);
  const [grain, setGrain] = useState(false);
  return <main><h1>動きに追従するSurface</h1><p>ボタンの押下・選択を高さと厚みへつなぎます。Space / Enter・タッチでも操作できます。</p>
    <label>Backend <select value={backend} onChange={e => setBackend(e.target.value as typeof backend)}><option>auto</option><option>cpu</option><option>css</option></select></label>
    <label><input type="checkbox" checked={effects} onChange={e => setEffects(e.target.checked)} />Emission / bloom</label>
    <label><input type="checkbox" checked={grain} onChange={e => setGrain(e.target.checked)} />Grain</label>
    <Ukibori backend={backend} dpr={1} margin={12} basePlaneColor="#c8c8ca"
      angularRadius={0.12} shadow={{ samples: 8, maxDistance: 48 }}
      materials={{ silicone: { baseColor: { r: 0.4, g: 0.44, b: 0.5 }, roughness: 0.5, metallic: 0,
        grain: grain ? { scale: 3, strength: 0.6, seed: 42 } : undefined,
        emissive: effects ? { r: 0.25, g: 0.08, b: 0.01 } : undefined } }}
      compositing={{ emissive: effects ? { bloom: { intensity: 0.5, radius: 8 } } : undefined }}
      style={{ position: "relative", width: 320, height: 180 }}>
      <Bake><UkiboriText text="UI" elevation={4} thickness={1} style={{ position: "absolute", left: 24, top: 16, font: "bold 16px Arial" }} />
        <Surface shape={{ kind: "svgPath", d: "M1 1H15V15H1ZM5 5V11H11V5Z", viewBox: [0, 0, 16, 16], fillRule: "evenodd" }} elevation={5}
          style={{ position: "absolute", left: 80, top: 16, width: 16, height: 16 }} /></Bake>
      <Toggle.Root asChild pressed={selected} onPressedChange={setSelected} aria-label="選択状態を切り替え"><PressSurface selected={selected} className="press-button">選択</PressSurface></Toggle.Root>
      <PressSurface disabled className="press-button disabled-button">無効</PressSurface>
    </Ukibori>{backend === "css" && <p>CSS近似ではbox-shadowを使い、grain・発光・bloomを省略します。</p>}<p>静止中は描画を止めます。OSの「視差効果を減らす」設定では中間アニメーションを省略します。</p></main>;
}
createRoot(document.getElementById("root")!).render(<Demo />);
