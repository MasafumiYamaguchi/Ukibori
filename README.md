# Ukibori（浮彫）

React + TypeScript製UIライブラリ。**DOMを普通に操作できるまま、その見た目の物理層だけを担当します。**

```
DOM UI → 2.5D height field → physical material lighting + cross-element cast shadows
```

`<Ukibori>`(provider)が共有する1つの物理レンダラーと光源の下で、`<Surface>`(実DOM要素)はSDFから作られたheight fieldとしてレンダリングされ、材質BRDFで照明され、**要素をまたぐキャストシャドウ**を持ちます。DOMのlayout / semantics / accessibility / text selection / forms / focus / pointer & keyboard eventsはすべてDOMが保持します。

```tsx
import { Ukibori, Surface, UkiboriText } from "ukibori";

<Ukibori light={{ x: -0.6, y: -0.8, z: 1 }} intensity={1}>
  <Surface as="button" id="play" elevation={6} thickness={2} bevelWidth={3.5}
           radius={12} material="silicone">
    Press me
  </Surface>
  <UkiboriText id="label" text="PLAY" elevation={9} thickness={0.8} material="metal" />
</Ukibori>
```

`as="button"`の要素は**本物のbuttonのまま**です(events / focus / ARIA / form / refすべてDOM所有)。物理層はproviderのstage-root overlay(`pointer-events: none`、ARIA inert)へcompositeされ、要素のbackground/shadowは管理属性で抑制されます。

## Architecture Decision

### 現在の描画経路

`backend="auto"` はWebGPUを優先します。GPUの初期化・描画・device lossで失敗した場合は、CPU reference rendererへ一度だけ切り替えます。`backend="webgpu"` はGPU専用で、初期化できない場合はCSS近似へ移り、DOMを操作できる状態を保ちます。

| backend | 描画経路 |
| --- | --- |
| `auto` | WebGPUのcomputeからcanvasへ直接提示。失敗時はCPU |
| `webgpu` | WebGPU。利用できない場合はCSS近似 |
| `cpu` | TypeScriptの参照計算とCanvas 2Dへの合成 |
| `css` | box-shadowによる近似 |

renderer → DOM統合 → React APIの順に依存します。DOMがlayout・入力・focus・selection・ARIAを所有し、rendererは共有の2.5D height fieldから照明と要素間の影を求めます。静止時は描画を止めます。

## アーキテクチャ

| パッケージ | 役割 |
| --- | --- |
| `ukibori-renderer` | React/DOM非依存のレンダラーコア(#13–#19)。SDF → height field → normal → Cook-Torrance BRDF → キャストシャドウ → mask(glyph)。詳細は `packages/renderer/README.md` |
| `ukibori-dom` | DOM統合層(#20)。retained DOM registry + 観測ベースのdirty update、stage-root overlayへのcomposite、DPR不変shadow、管理属性による抑制。詳細は `packages/ukibori-dom/README.md` |
| `ukibori` | **React API(#21)**。`Ukibori`(provider)が1つの`UkiboriDom`インスタンスを所有し、`Surface`/`UkiboriText`は実DOM要素をretained sceneへ登録します |

React層は薄いlifecycle/API層であり、rendererのセマンティクスをReactへ移しません。

## API

### `<Ukibori>`

1つの共有レンダラー/環境をsubtreeに提供します。post-hydration(useEffect)でcapability detection → integration初期化 → surface登録が行われます。SSR中は`window`/`document`/canvas/WebGPU/`UkiboriDom`に一切触れず、**通常のセマンティックDOM**を出力します(サーバーとクライアントの初期出力は一致し、hydrationは要素を置き換えません)。

| prop | 説明 |
| --- | --- |
| `materials` | 物理マテリアルの参照テーブル。`emissive: { r, g, b }`で線形RGBの自己発光を指定。未指定は発光なし |
| `light` / `intensity` | 共有方向光(#13: receiver→光源方向。`{ x: -0.6, y: -0.8, z: 1 }`は左上前方) |
| `backend` | `"auto"` / `"cpu"` / `"webgpu"` / `"css"`。auto=実WebGPU(直接canvas提示)を最優先、失敗時はCPU reference rendererへ一度だけfallback。`"cpu"`=物理層(CPU reference renderer)。`"webgpu"`=WebGPU専用(失敗時は明示ラベルのCSS近似へ)。`"css"`=**明示的に近似とラベル付けされたbox-shadowフォールバック**(物理レンダリングではない) |
| `quality` / `dpr` | レンダーターゲットのスケール方針(`low` 0.75× / `medium` 1× / `high` 1.5× devicePixelRatio)。scene単位は常にCSS px(#13) |
| `stage` | #20 stage-root overlay契約。既定はprovider自身のwrapper要素(surfaceはその中に置く)。unmountでクリーンに破棄 |
| `shadow` / `margin` / `compositing` | 影パス(#17、CSS px、DPR不変) / シーン余白 / overlay合成マッピング |
| `highContrast` | `"auto"`(既定): `prefers-contrast: more` / `forced-colors: active` で物理層を無効化し、アプリ自身のハイコントラストCSSがそのまま効くようにする(明確なseam) |
| `onError` / `onReady` / `schedule` | エラー報告 / レイヤー取得(テストseam) / render scheduler(テストseam) |

静的シーンは**アイドル**です。React/RAFの連続ループはありません(#20のmanaged-mutation filter + デモの冪等debug出力でsettleを検証)。

### `<Surface>`

実セマンティック要素をenhanceします。`id`はmounted lifetimeで安定(既定は`useId()`)。prop更新はretained `updateSurface`パス(**unregister/registerしない**ためscene挿入/塗り順が安定)。

- 物理props: `shape`(`{ kind: "roundedRect", radius }` | `{ kind: "mask", mask }` | `{ kind: "svgPath", d, viewBox, fillRule? }`、radius省略時はCSS `border-radius`を計測) / `elevation`(絶対scene z, #13) / `thickness` / `bevelWidth` / `profile` / `material`(renderer ref: silicone / matte / metal) / `castsShadow` / `receivesShadow`

`svgPath` はDOM integration専用のauthoring formatです。`d`（path data）のみをCanvas `Path2D`で、viewBoxを`getBoundingClientRect()`で測定したDOM element footprintへ`xMidYMid meet`（等方・中央寄せ）fitしてDPR解像度のcoverage maskへラスタライズします。整数device footprintをsurfaceの物理サイズにも使うため、fractional CSS pxでもmask mappingは等方です。`nonzero`/`evenodd`の穴をサポートし、AA coverageはFloat32 alphaのまま既存mask→SDFへ渡します（品質方針Option A: effective device footprintでCanvas2D AAを保持し、既存binary SDFを使用）。SVG document/markup、stroke、外部resource、filter、script、gradientなどは非対応で、Path2D/2D canvasがない環境では明示的なrasterization errorとなります。
- CSS近似props(`backend="css"`のみ有効): `variant`(raised/inset) / `radius` / `materialOverrides`。**これらは近似であり、物理レンダリングと混同しないこと**
- それ以外のprops(`className` / `style` / `aria-*` / `data-*` / events / `ref`)はすべてDOMへそのまま透過

### `<UkiboriText>`

DOM所有のアクセシブルなテキスト(`<span>`)を描画し、その**グリフを#19 mask geometryとして物理sceneへ登録**します(#19 demoのPLAY reliefをReact APIで再現)。ラスタライズ(canvas 2d)はrenderer coreの外、DOMテキストはDOM所有のままです。

**#52 glyph compositing policy (UkiboriText固有)**: physical maskの用意が完了し、物理バックエンドが有効な間(= registration成立時)は、**canvas上の物理glyph reliefが視覚表現になります**。`<UkiboriText>` は自分のテキストをmaskへラスタライズしたglyphであるため、明示的な `delegateTextInk` intent付きで登録され、**そのDOM textのインクのみ**を `data-ukibori-physical-ink` 管理属性経由のstylesheetルールで抑制します(color / -webkit-text-fill-color / -webkit-text-stroke-color → transparent、text-shadow → none)。DOM node / textContent / 選択 / コピー / focus / ARIA / layoutは一切変更せず、選択ハイライトはUAの `::selection` 背景が引き続き可視です。**一般の `<Surface>` が `shape={{kind:"mask"}}`(icon silhouette等)を持っていても、そのDOM textはDOM所有のまま可視です** — ink delegationはshapeから推測されず、`<UkiboriText>` の明示的intentでのみ発動します。CSS backend / provider無し / SSR / rasterize失敗では登録が存在しないため、DOMテキストは通常通り可視のままです。rasterizationはライブlayoutのRange line boxからbaselineを測定して配置するため、mask-ready遷移の前後でglyph位置はジャンプしません(#52 alignment)。
委譲は review round 2 の fidelity gate に従います: `rasterizeText` が現在の値に対して忠実なラスタを作れた場合（単一のライブ行ボックス、使用可能な font metrics、タイポグラフィ一致）にのみ ink 委譲が成立し、テキスト/フォント変更でラスタライズが失敗した場合は直前のラスタを破棄して DOM テキストを通常通り可視に戻します（stale な physical glyph が異なるテキストのインクを抑制することはありません）。複数行に折り返すテキストは単一行 mask で忠実に表現できないため、DOM インクは可視のままです（mask は geometry としてのみ登録）。
さらに review round 3: fidelity gate は要素の computed typography を分類します。letter-spacing / word-spacing / font-kerning / font-stretch / font-variant-caps / text-rendering / direction は、canvas 実装が computed 値を受け付け読み戻せた場合にのみ canvas へミラーします（未対応なら委譲しません）。text-transform・縦書き・text-decoration / text-emphasis / -webkit-text-stroke のインク・カスタム OpenType features など、canvas で再現できないタイポグラフィは home-grown 実装を行わず DOM 可視フォールバックとします。また raster identity は typography 関連の style/className props と computed typography fingerprint にも紐づくため、fontSize/fontWeight/className 等の変更は再ラスタライズ（またはフォールバック）され、古い physical glyph が残りません。

**#56 CSS text color fidelity**: 委譲された glyph の色は live な `getComputedStyle(element).color` が source of truth です。DOM layer で opaque sRGB を一度だけ linear RGB へ変換し、選択された preset/custom material の `baseColor` だけを置き換えます。`roughness` / `metallic` / `ior` と既存 BRDF は維持されるため、CSS `color` は pigment/albedo、`material` は物理表面応答を担当します。style/class/inherited color/CSS variable/theme の DOM mutation は retained render 時に自動で再読込されます（`insertRule()` 等の CSSOM-only 変更は `layer.invalidate(id)` が必要です）。renderer は RGB-only/opaque のため、alpha 付きまたは未対応の computed color は physical glyph 自体を scene から除外し、DOM のみを visual source とするフォールバックになります。

## アクセシビリティ / フォールバック

- `:focus-visible`を除去しません(outlineは一切触りません)
- renderer失敗時も**セマンティックDOMは読めて操作可能**なままです(登録失敗はatomic — 抑制属性を残しません)
- reduced-motion: 任意の`useSurfaceProgress`はOSの設定を監視し、中間アニメーションを省略します。`prefersReducedMotion()`による判定も利用できます
- high-contrast: 上記`highContrast`ポリシー
- `backend="css"`フォールバックはbox-shadow近似であることを明示ラベル

## ブラウザ制約

- 物理層は単一height fieldモデルです。raisedをmax、insetを順序付きminで合成します。複数の高さを同時に保持するオーバーハングやfull 3Dは対象外です
- overlayはstage-root契約(#20): surfaceはstage要素内に置く必要があります。transform祖先・iframeは非対象
- `backend="auto"`のWebGPU経路は#29/#31 `GpuScenePipeline`の直接canvas提示です(readbackなし・2D copyなし)。GPUの初期化/描画/device-loss失敗時は**一度だけ**CPU reference rendererへ切替わり(`debugState().backend` / `gpuFallbackReason` / `gpuFrame`で検証可能)。ホスト側の計測はすべてhost wall-clockであり、GPU完了時間を偽装しません

## デモページ

メインの`/`はハッシュルートで構成されたダッシュボードです。空または未知のハッシュはPlaygroundとして表示され、各ルートは排他的にマウントされます(切り替えるとローカルstateはリセットされます)。

| ハッシュ | 内容 |
| --- | --- |
| `#playground` | #21 React APIプレイグラウンド(全物理コントロール + 実DOM button/input + PLAY glyph。Live cardはsliderのelevation/thicknessに追従) |
| `#features` | Feature Lab(順序付き合成、height profile、SVG shape + fillRule、nested Bake、オンデマンドdebugStateスナップショット、UkiboriText色) |
| `#diagnostics/<id>` | standalone診断ページを1つだけsame-origin iframeで表示(`renderer` / `scheduler` / `wasm` / `dom` / `profiles` / `emissive`) |
| `#product` | `/neumorphism.html`をsame-origin iframeで表示 |

ダッシュボード下部のCoverage indexが、実装グループを対応するタブ / standaloneページ / リポジトリ内レポートへ対応付けます。

standaloneページは従来どおり直接アクセスできます:

- `/` — ダッシュボード(上記ハッシュルート)
- `/renderer-debug.html` — レンダラー中間bufferデバッグ(#14–#19)
- `/scheduler-debug.html` — #31/#32 dirtyスケジューラ + tileプランナデバッグ
- `/wasm-debug.html` — #33 WASM CPUフォールバック診断(選択状態 / ステージ実績 / 転送量 / メモリ / パリティ / TS・WASM・WebGPUベンチマーク)
- `/dom-debug.html` — #20 DOM統合デモ(実DOM button + text)
- `/profile-debug.html` — #61 height profile比較(step / linear / smooth / convex / concave / power)
- `/emissive-debug.html` — emissive materials / nearby illumination / bloom デバッグ
- `/neumorphism.html` — ニューモーフィズム・ウェルネスダッシュボード

## #33 WASM-assisted CPU fallback (WASM CPUフォールバック)

- TypeScript CPU実装をセマンティック・オラクルとして維持し、正規生成(`computeNormals`)だけを
  batch型WASMカーネルに移植。カーネルは決定的ビルドスクリプト
  (`packages/renderer/scripts/build-wasm.mjs` → `src/wasm/normal-kernel.base64.ts`)で生成され、
  外部ツールチェーン不要。出力はオラクルとビット一致(厳密パリティ検証済み)。
- `createRenderer({ backend: "auto" | "wasm" })` / `WasmCpuPipeline` はステージ実績
  (`wasmStages`: normalのみ `"wasm"`、他は `"typescript"`)を必ず報告します。
  TypeScriptのみで実行した結果をWASMとラベル付けすることはありません。
- 選択は「WebAssembly対応 + 有界プローブが厳密パリティと文書化された利益(ratio < 0.9)を示す」
  場合のみWASMを選び、決定をキャッシュします(`resetWasmSelectionCache()`でクリア)。
  `auto`はWebGPU検出を最優先で開始し、WASMのロード/ベンチマークで遅延させません。
- 検証: `npm run test:wasm-browser -w ukibori-renderer`(実Chromeでパリティ+ライフサイクル)、
  vitestの厳密パリティ/ライフサイクル/選択規則テスト、`npm run test:webgpu -w ukibori-renderer`。

## 開発コマンド

```sh
npm install        # workspace全依存のインストール
npm run typecheck  # ライブラリ + デモの型チェック
npm run test       # ライブラリの単体テスト
npm run build      # ライブラリ + デモのビルド
npm run dev        # デモを起動
```

## ステータス

#21(React API)実装済み。#33(WASM-assisted CPU fallback)実装済み。WebGPU統合(auto/cpu/webgpu backend、直接canvas提示、honest CPU fallback)実装済み。
進行は [DEEPSEEK_IMPLEMENTATION_BRIEF.md](./DEEPSEEK_IMPLEMENTATION_BRIEF.md) のチェックポイント方式とGitHub Issue(#12〜)に従っています。
## Boundary profile comparison

Surfaces accept `profile={{ kind: "smooth", mode: "inset" }}` as well as
`step`, `linear`, `convex`, `concave`, and adjustable `power` curves.
Legacy `flat`/`bevel` remain raised step/smooth aliases. Insets carve earlier
surfaces in scene order and update their shadow geometry.
See [the profile API, formulas and composition rules](ISSUE_61_IMPLEMENTATION_REPORT.md).
The deterministic comparison is available at `/profile-debug.html` in the demo.


### Emissive materials

```tsx
<Ukibori
  materials={{
    led: {
      baseColor: { r: 0.02, g: 0.02, b: 0.02 },
      roughness: 0.5,
      metallic: 0,
      emissive: { r: 0.05, g: 0.5, b: 2 },
    },
  }}
>
  <Surface material="led" elevation={2} thickness={4}
    style={{ width: 120, height: 64 }}>LED</Surface>
</Ukibori>
```

`emissive`は**線形RGBの自己発光**です。環境光・方向光・影によって減衰せず、通常のライティング結果に加算してから露出とsRGB変換を適用します。未指定は黒（発光なし）。HDR値（1を超える値）を保持し、負数・非有限値・f32範囲外はチャンネルごとに0へ戻します。CSSのsRGB値を渡す場合は先に線形RGBへ変換してください。

`materials`の変更は既存レイヤーへ反映され、propを取り除くと組み込みマテリアルに戻ります。DOM APIでは`UkiboriDom.create({ materials })`と`layer.setMaterials(materials)`、rendererでは`createScene({ materials })`から同じマテリアルを使用できます。CSS近似モードはemissiveの物理描画には対応しません。

周囲への近似照明とブルームは、以下の`compositing.emissive`で有効にできます。デモは`npm run dev`の`/emissive-debug.html`で、発光・外部照明・露出を変更できます。

### Emissive illumination and bloom

Enable nearby illumination and HDR bloom independently through `compositing`:

```tsx
<Ukibori
  materials={{ led: {
    baseColor: { r: 0.02, g: 0.02, b: 0.02 }, roughness: 0.5, metallic: 0,
    emissive: { r: 0.1, g: 2, b: 4 },
  } }}
  compositing={{ emissive: {
    illumination: { intensity: 1.5, radius: 72 },
    bloom: { intensity: 0.6, radius: 32, threshold: 1 },
    quality: 4,
  } }}
>
  <Surface material="led" elevation={2}>Light</Surface>
</Ukibori>
```

Lengths are CSS pixels in React/DOM. Both effects are off when omitted; set either
intensity to zero to disable it. Bloom filters exposed HDR **emission**, including
values above 1, with a separable Gaussian. It does not bloom ordinary reflected
highlights. Nearby illumination is a visible-source screen-space approximation,
with receiver normals and four height checks for occlusion. It cannot account for
hidden/offscreen emitters or indirect bounces. `quality` (2–6, default 4) controls
illumination sampling; thin emitters can fall between samples.

Try `demo/emissive-debug.html` to adjust emission, nearby illumination and bloom
separately. See [implementation details](EMISSIVE_EFFECTS_IMPLEMENTATION_REPORT.md).


### Physical base-plane receiver (#75)

For a uniform opaque stage, opt into `basePlaneColor="#aeb9c4"` on `<Ukibori>`
(or the `UkiboriDom` constructor / `setBasePlaneColor`). This sRGB color becomes
a matte floor albedo. Direct shadows and emissive illumination share the same
receiver semantics as surfaces, including when bloom is disabled. Set the stage's
CSS background separately for SSR/fallback. The physical floor covers the stage's
visible padding box; contain the intended scene within that stage.

Omitting the option keeps transparent legacy compositing. Supported colors are
opaque `#rgb`, `#rrggbb`, `rgb()` and `rgba()`; gradients/images and transparent
colors are not physical-floor inputs. Renderer-only callers use linear
`compositeOptions.basePlane.baseColor`.

See the [implementation and validation report](docs/issue-75/README.md) and the
`/base-plane-debug.html` demo for short/long shadows, independent illumination,
bloom, and owned-receiver continuity.

## 操作に高さを追従させる

`useSurfaceProgress(target, { durationMs, reducedMotion })` は0〜1の値を補間します。既定のdurationは120msです。押下・選択状態はnative DOMまたはheadless UIが所有し、その目標値だけを渡します。得られた進捗を`elevation`・`thickness`などの数値へ写像します。終了・unmountでRAFを止め、`reducedMotion: "auto"`ではOS設定を監視します。

`/interaction.html`（ダッシュボードのDiagnostics → Interaction）に、Radix Toggleの`asChild`と合成するbutton例があります。Radixはデモだけの依存です。通常のbuttonのclick・Space・Enter・ARIA・refを保ち、pointercancel・capture喪失・blur・disabledで押下を解消します。合成とSSRの導入手順は[操作ガイド](docs/dynamic-surfaces/interaction.md)を参照してください。

`Bake`はDOM計測とrasterの保持境界です。Bake内も共有sceneへ参加し、動的Surfaceと影・照明を共有します。固定画像への切り離しやbuild-time bakeではありません。明示的な`rebake()`、font・viewport変更などで必要な計測をやり直します。

## 樹脂の粒状感を追加する

物理Materialに`grain: { scale: 3, strength: 0.3, seed: 42 }`を指定できます。`scale`はCSS px相当の粒の幅、`strength`はroughnessの変動幅、`seed`はu32です。既定は無効です。Surfaceの左上を基準に模様を固定し、移動しても追従します。縮小時は解像できない変動を弱めます。

初版はroughnessだけを変更します。height・normal・silhouette・caster・cast shadowは変えません。床面は対象外です。CPUとWebGPUで同じ座標・seedを使い、CSS fallbackは粒を省略します。[材質の契約](docs/dynamic-surfaces/material.md)と[計測・検証結果](docs/dynamic-surfaces/README.md)に条件を記録しています。
