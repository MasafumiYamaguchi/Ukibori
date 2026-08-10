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

### 指示書との関係: 暫定構成としての位置づけ

指示書のMVPは**軽量なDOM/CSS主体のモデル**(CSSカスタムプロパティによるbox-shadow近似。Canvas等の重い経路を導入しない)を想定しています。一方、このリポジトリにはCP1以前から構築された既存実装があり、その基本経路(`backend="auto"`/`"cpu"`)は**Canvas 2Dを使うCPUレンダラー**(SDF → height field → 材質BRDF → キャストシャドウ)です。これは指示書の想定から**逸脱**しており、CP1の作業で新たに選択したものではなく、また逸脱を既成事実として正当化するものではありません。

当面はこの既存Canvas構成を**暫定構成**として維持します。

- 維持の理由: 既存の検証済み実装(テスト済み)を破壊せず、ユーザーに方向性を確認するまで動作可能な状態を保つため
- 後続CPでの扱い: CP2以降で「指示書準拠の軽量DOM/CSS中心モデルへ移行する」か「既存Canvas構成を恒久的な基本経路として採用する」かをユーザーに諮り、その決定に従う
- **恒久変更にはユーザー承認が必要**です。この節は判断までの暫定状態の記録であり、逸脱の正当化ではありません

### 現在の構成(暫定)

| 決定 | 内容 |
| --- | --- |
| npm workspacesを採用 | `packages/*`(`ukibori-renderer` / `ukibori-dom` / `ukibori`)+ `demo`のworkspace構成。公開物とデモを分離し、ライブラリ側にデモ用依存を混ぜない |
| 3パッケージに分離 | renderer(React/DOM非依存の純計算)→ dom(DOM統合)→ ukibori(React API)の順に依存。計算・DOM・Reactの責務を分け、各層を独立にテストする。runtime dependencyを最小化する(React層はpeer dependency) |
| 基本経路(暫定): Canvas製CPUレンダラー | `backend="auto"` / `"cpu"`はcanvas 2dへ描画するCPU reference rendererが担う(物理レンダリングの軽量近似であり、正確な物理シミュレーションではない)。React層は薄く、rendererのセマンティクスをReactへ移さない。SSRでは`window`/`document`/canvasに一切触れない。**指示書の「Canvas非導入」と整合しておらず、暫定扱い** |
| box-shadow近似はCSS backendのみ | `backend="css"`は指示書の軽量DOM/CSSモデルに整合する経路で、CSSカスタムプロパティ(`--ukibori-*`)とbox-shadowによる近似フォールバックを出力し、「物理レンダリングではない」と明示的にラベル付けする。物理経路と混同しない |
| 統一光源 | `<Ukibori>`で共有光ベクトルを定義し、子の`<Surface>`は常にそれを使う(物理経路・CSS経路の両方で一貫) |

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
| `light` / `intensity` | 共有方向光(#13: receiver→光源方向。`{ x: -0.6, y: -0.8, z: 1 }`は左上前方) |
| `backend` | `"auto"` / `"cpu"` / `"css"`。auto/cpu=物理層(CPU reference renderer)。`"css"`=**明示的に近似とラベル付けされたbox-shadowフォールバック**(物理レンダリングではない)。WebGPUはcompute pipelineが未実装(`compute: false`)のため選択肢に存在しません — 存在しない能力をfakeしません |
| `quality` / `dpr` | レンダーターゲットのスケール方針(`low` 0.75× / `medium` 1× / `high` 1.5× devicePixelRatio)。scene単位は常にCSS px(#13) |
| `stage` | #20 stage-root overlay契約。既定はprovider自身のwrapper要素(surfaceはその中に置く)。unmountでクリーンに破棄 |
| `shadow` / `margin` / `compositing` | 影パス(#17、CSS px、DPR不変) / シーン余白 / overlay合成マッピング |
| `highContrast` | `"auto"`(既定): `prefers-contrast: more` / `forced-colors: active` で物理層を無効化し、アプリ自身のハイコントラストCSSがそのまま効くようにする(明確なseam) |
| `onError` / `onReady` / `schedule` | エラー報告 / レイヤー取得(テストseam) / render scheduler(テストseam) |

静的シーンは**アイドル**です。React/RAFの連続ループはありません(#20のmanaged-mutation filter + デモの冪等debug出力でsettleを検証)。

### `<Surface>`

実セマンティック要素をenhanceします。`id`はmounted lifetimeで安定(既定は`useId()`)。prop更新はretained `updateSurface`パス(**unregister/registerしない**ためscene挿入/塗り順が安定)。

- 物理props: `shape`(`{ kind: "roundedRect", radius }` | `{ kind: "mask", mask }`、radius省略時はCSS `border-radius`を計測) / `elevation`(絶対scene z, #13) / `thickness` / `bevelWidth` / `profile` / `material`(renderer ref: silicone / matte / metal) / `castsShadow` / `receivesShadow`
- CSS近似props(`backend="css"`のみ有効): `variant`(raised/inset) / `radius` / `materialOverrides`。**これらは近似であり、物理レンダリングと混同しないこと**
- それ以外のprops(`className` / `style` / `aria-*` / `data-*` / events / `ref`)はすべてDOMへそのまま透過

### `<UkiboriText>`

DOM所有のアクセシブルなテキスト(`<span>`)を描画し、その**グリフを#19 mask geometryとして物理sceneへ登録**します(#19 demoのPLAY reliefをReact APIで再現)。ラスタライズ(canvas 2d)はrenderer coreの外、DOMテキストはDOM所有のままです。

## アクセシビリティ / フォールバック

- `:focus-visible`を除去しません(outlineは一切触りません)
- renderer失敗時も**セマンティックDOMは読めて操作可能**なままです(登録失敗はatomic — 抑制属性を残しません)
- reduced-motion: ライブラリは連続アニメーションを持ちません(`prefersReducedMotion()`をseamとして公開)
- high-contrast: 上記`highContrast`ポリシー
- `backend="css"`フォールバックはbox-shadow近似であることを明示ラベル

## ブラウザ制約

- 物理層は単一height fieldモデル(#18): オーバーハング・同一画素への複数surfaceの積み重ね・彫り込み(inset)は表現できません(insetはCSS近似でのみ利用可能)
- overlayはstage-root契約(#20): surfaceはstage要素内に置く必要があります。transform祖先・iframeは非対象
- 初期実装はCPU reference renderer。WebGPU compute pipelineは未実装(`compute: false`)で、選択肢として公開されません

## デモページ

- `/` — #21 React APIデモ(物理層 + PLAY glyph + backend切替)
- `/renderer-debug.html` — レンダラー中間bufferデバッグ(#14–#19)
- `/dom-debug.html` — #20 DOM統合デモ(実DOM button + text)

## 開発コマンド

```sh
npm install        # workspace全依存のインストール
npm run typecheck  # ライブラリ + デモの型チェック
npm run test       # ライブラリの単体テスト
npm run build      # ライブラリ + デモのビルド
npm run dev        # デモを起動
```

## ステータス

#21(React API)実装済み。進行は [DEEPSEEK_IMPLEMENTATION_BRIEF.md](./DEEPSEEK_IMPLEMENTATION_BRIEF.md) のチェックポイント方式とGitHub Issue(#12〜)に従っています。
