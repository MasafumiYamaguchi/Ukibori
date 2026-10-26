# DOMの操作状態を連続値につなぐ

`useSurfaceProgress`は目標値0〜1を補間する任意のReactフックである。DOMイベントやARIAは入力元が管理する。押下・選択状態から進捗を決め、進捗から高さ・厚みなどの既存パラメータを求める。

1. native buttonかheadless UIで押下・選択状態を持つ。
2. 状態に応じて目標値を決める。例では押下1、選択0.375、通常0とする。
3. `useSurfaceProgress`で現在値を得て、既存の数値propへ写像する。
4. 終了・キャンセル時に目標値を戻す。unmountではフックがRAFを取り消す。

既定の遷移時間は120ms、ease-out cubicで補間する。途中で目標が変わると現在値から再開する。durationは0〜1000msで、0は即時反映する。`reducedMotion`の既定は`"auto"`で、OSの設定変更を監視する。完了時に正確な目標値を設定し、次のRAFを予約しない。

## Radixのpropsとrefを同じbuttonへ渡す

`demo/src/interaction/PressSurface.tsx`はnative buttonのrecipeで、ライブラリのコンポーネント群を増やさない。Radix Toggleの`Root asChild`の子として使い、ref・props・clickをそのままSurfaceへ渡す。Radixが`aria-pressed`と選択状態を管理する。recipeはpointer・Space・Enterの押下進捗だけを扱う。

consumerのイベントハンドラを先に呼び、押下開始では`defaultPrevented`を確認する。pointer captureで要素外のreleaseも受け取り、pointercancel・lostpointercapture・blur・window blur・disabledで押下を解消する。要素外でreleaseされたときは、captureが原因のclickを取り消す。clickを独自に生成しないため、native buttonのSpace/Enter・form semanticsが維持される。focus-visibleのoutlineも上書きしない。

Radixはデモworkspaceだけの依存で、renderer・DOM統合・React coreの依存には含めない。合成時の要件は[Radix公式のcompositionガイド](https://www.radix-ui.com/primitives/docs/guides/composition)に従う。

## SSRから同じDOMをhydrateする

アプリ側のclient境界（例: Next.jsの`"use client"`を付けた小さなwrapper）でUkiboriと操作stateを配置し、server/clientで同じ初期状態を使う。初期進捗は目標値そのもので、SSRではwindow・canvas・RAFを参照しない。物理描画はhydration後に有効化され、buttonを置き換えない。

`press-recipe.test.tsx`はserver HTMLをhydrateし、同じbuttonへclick handlerが付くことを確認する。node環境の`ssr.test.tsx`でもフックを描画する。実ブラウザの`press-integration.tsx`ではnativeキー・タッチ入力と、WebGPU/CPU/CSSの各経路を検証する。idle判定はWebGPUで`gpuRenderSerial`、CPUで`sceneBuildSerial`を比較し、途中unmount後の描画停止も両経路で確認する。

## backendと品質の範囲

| 経路 | 操作と表示 |
| --- | --- |
| WebGPU | 同じDOM入力から高さ・影・照明を更新。マスクが不変ならSDFを保持 |
| CPU | 同じ物理計算。重い場面では解像度・影sample数を調整する |
| CSS | 同じbuttonと操作進捗を保ち、box-shadow近似で高さを示す。grainは省略 |
| SSR / enhancement前 | 通常のbuttonを表示し、hydration後に描画を追加 |

DPR/qualityはrender targetへ適用する。DOM layout・buttonの大きさ・focus領域はそのまま。SVGはeffective footprintのmask、文字は既存のtypography fidelity gateを使う。transform祖先・任意のCSS transform・全clip仕様の再現は今回の保証に含めない。

性能は[固定シーンの結果](README.md)を参照する。GPU各pass、DOM計測、host処理、timestamp readbackを含む待ち時間を分けて読む。低解像度化や影sample数の変更で改善した値を、同一条件の改善として扱わない。

## デモで押下とgrainを比較する

`npm run dev`でデモを起動し、トップナビの **Interaction & grain**（`/#interaction`）を開く。同じ画面は`/interaction.html`からも直接開ける。

1. 「押して選択」をクリック、Space / Enter、タッチで操作する。押下・戻り・選択中の高さを確認できる。
2. 「押下の目標値」を動かすか「押下と戻りを1回再生」を押し、進捗と高さ・厚みの変化を見比べる。
3. 下段のGrain OFF / ONを比較し、粒の強さ・粒幅・seedを変える。両方の形状・光源・基本材質は共通である。
4. 「最後のフレームを観測」で、高さ変更時のMask SDF再生成が0回、grainだけの変更時のHeight composeが0 passになることを確認する。静止後に観測値を更新すると描画回数は増えない。
5. Auto / CPU / CSSを切り替え、アニメーション省略・disabled・Emission / bloomも試せる。CSS近似ではgrain・発光・GPU計測を省略する。

観測値は操作後とボタンで取得し、常時ポーリングしない。GPU時間は対応するdeviceでtimestamp-queryが取得できた場合だけ表示する。起動直後はmask生成が必要なので、最初のSDF回数は0とは限らない。
