# Ukibori（浮彫）

React + TypeScript製UIライブラリ。平面上のDOM要素に、統一された光源から生じる「浮き出し・彫り込み・材質感」をCSSカスタムプロパティで与えます。

```tsx
import { Ukibori, Surface } from "ukibori";

<Ukibori light={{ x: -0.6, y: -0.8, z: 1 }} intensity={1} color="#e4e8ef">
  <Surface material="silicone" variant="raised" elevation={6} radius={20}>
    Hello
  </Surface>
</Ukibori>
```

厳密な物理レンダリングではなく、物理的に一貫した見た目を目指す軽量な近似(`box-shadow` / `background` / `filter`等)です。

## Architecture Decision

CP1時点での構成判断を記録します。

- **npm workspacesモノレポ**: `packages/ukibori`(ライブラリ)と`demo`(Viteデモ)を分離。
  - 理由: ライブラリの`package.json`(exports / files / peerDependencies)をnpm公開用に保ったまま、デモはworkspace参照(`"ukibori": "*"`)で依存できる。npm packにデモが混入しない。
- **ライブラリのビルド: tsup**: ESM(`index.js`)とCJS(`index.cjs`)、および`.d.ts`を一度に生成。peer dependency(`react`, `react-dom`, `react/jsx-runtime`)はexternal化。
- **テスト: Vitest + jsdom + Testing Library**: 純粋関数(CP2)、コンポーネント/SSR(CP3)を同じランナーで実行。jsdomをデフォルト環境にし、SSRテストはファイル単位でnode環境に切替予定。
- **デモのimport: Vite aliasでライブラリsrcを直接参照**: `npm run build -w ukibori`を待たずにdemo devでHMRを効かせるため。本番相当のnpm利用経路(exports→dist)は`npm pack`検証(CP6)で確認する。
- **スタイル合成**: 内部CSSカスタムプロパティとユーザー`style`の優先順位(ユーザー優先)、`box-shadow`の`var()`フォールバックによる意図的な色上書きをCP3で実装し、上記「スタイル合成の規則」に文書化。
- **色の扱い**: 任意CSS色のJavaScript解析はしない。glass等の透明度が必要な箇所は`color-mix()`を使わず、材質トークンの**固定色**(`rgba(255,255,255,0.32)`)で実装し、ブラウザ非依存の読みやすさを保証する(CP4)。
- **公開APIの型**: `LightVector`, `MaterialName`, `Variant`などの型を`src/types.ts`に集約。polymorphic `as`の型安全性はCP3で詰める。
- **core計算のReact分離**: `src/core/light.ts`(光ベクトル正規化)と`src/core/shadow.ts`(影・ハイライト導出)はReact/CSS生成から独立した純粋関数。入力オブジェクトを変異させず、`NaN`/`Infinity`/ゼロベクトル/負値/極端値はすべて決定的なfallbackとclampに落ちる。丸めは`roundTo`(Math.roundベース、pxは2桁・ベクトルは6桁)に統一。

## スタイル合成の規則

`Surface`は内部で次のstyleを計算し、**ユーザーの`style`を最後に展開**します(衝突するプロパティはユーザーが優先)。`className`は連結され失われません。`as="button"`等のpolymorphic要素でもDOM props・イベント・ref・`aria-*`/`data-*`はそのまま透過します。

**計算値はすべてCSSカスタムプロパティ化され、`borderRadius`/`backgroundColor`/`boxShadow`は`var()`でそれらを参照します。** ユーザーがstyleでCSS変数を上書きすると、参照する描画が実際に変わります。

`Surface`が出力するCSSカスタムプロパティ:

| 変数 | 意味 |
| --- | --- |
| `--ukibori-color` | `Ukibori`のcolor(背景色)。`backgroundColor: var(--ukibori-color)`で参照 |
| `--ukibori-variant` | `raised` / `inset`(未知値は`raised`に正規化) |
| `--ukibori-material` | 材質名(CP4で視覚化) |
| `--ukibori-elevation` / `--ukibori-radius` | 適用後のelevation / radius(px)。`borderRadius: var(--ukibori-radius)`で参照 |
| `--ukibori-shadow-x/y/blur/spread/alpha` | 影の計算値 |
| `--ukibori-highlight-x/y/blur/alpha` | ハイライトの計算値 |
| `--ukibori-shadow-color` / `--ukibori-highlight-color` | 影色の`var()`フォールバック(既定はalpha入りrgba)。上書き推奨のoverride点 |

`box-shadow`は影・ハイライトの2段重ねで、offset/blur/spread/alphaと色のすべてが`var()`参照(色は`var(--ukibori-shadow-color, rgba(0, 0, 0, var(--ukibori-shadow-alpha)))`形式)。ユーザーstyleの`boxShadow` / `backgroundColor`で全面上書きも可能です。

## 材質(material)

`material`は`Surface`のオプションで、`silicone` / `matte` / `glass` / `metal`を選べます。未知の値は`silicone`に正規化されます。各材質は以下のトークンで抑制された実質的な差を持ちます(プレセットは`resolveMaterialTokens`の純粋関数で解決):

| トークン | 意味 | silicone | matte | glass | metal |
| --- | --- | --- | --- | --- | --- |
| `shadowAlpha` | 影の濃さ倍率 | 1 | 0.8 | 0.7 | 1.15 |
| `highlightAlpha` | ハイライトの強さ倍率 | 1 | 0.35 | 1.35 | 1.7 |
| `blurScale` | 影の柔らかさ倍率 | 1 | 1.35 | 1.15 | 0.8 |
| `spreadScale` | 影の広がり倍率 | 1 | 0.5 | 0.5 | 1.25 |
| `surfaceColor` | 表面の背景色(null=`var(--ukibori-color)`を使用) | null | null | `rgba(255,255,255,0.32)` | null |
| `backgroundImage` | 光沢・ヴェール(background-image) | null | null | 白ヴェール | 145degグロス |
| `borderWidth` / `borderColor` | 縁 | なし | なし | 1px白 | 1px白 |
| `backdropFilter` | 背面のぼかし | null | null | `blur(10px) saturate(1.15)` | null |

利用者は`Surface`の`materialOverrides` propでトークンを**型安全に部分上書き**できます。ランタイムの不正値(NaN/Infinity/負値/巨大値/誤型)は`sanitizeMaterialOverrides`が除去またはclampし、非有限のCSS値が生成されることはありません。例:

```tsx
<Surface material="glass" materialOverrides={{ surfaceColor: "rgba(255, 255, 255, 0.5)", backdropFilter: null }}>
  Frosted but more opaque
</Surface>
```

## ブラウザ制約

- **glassの背景は固定の半透明白(`rgba(255, 255, 255, 0.32)`)**: どのブラウザでも必ずこの背景が描画され、透明になることはありません。`color-mix()`には依存しません。`backdrop-filter`未対応ブラウザではぼかし効果だけが失われ、読みやすさは変わりません。背景色を変えたい場合は`materialOverrides={{ surfaceColor: ... }}`またはユーザーstyleの`backgroundColor`で上書きします(ユーザー最優先)
- **`backdrop-filter`非対応**: glassの背面ぼかしが失われるだけ。背景・枠・影は変わりません
- `box-shadow`の`var()`参照はペイント時に解決されます(jsdom等のテスト環境では解決されません)
- このライブラリは物理シミュレーションではなく、`box-shadow` / `background` / `border` / `backdrop-filter`による**近似**です。WebGLやCanvasは使いません
- 装飾は要素そのもののCSSのみで構成され、focus表示の除去・要素のラップ・セマンティクス変更は行いません

## 物理レンダラー基盤 (`ukibori-renderer` / `ukibori-dom`)

上記のCSS近似とは別に、#12以降は物理的に一貫した2.5Dレンダラー基盤を別パッケージで開発しています。

- **`packages/renderer` (`ukibori-renderer`)**: React/DOM非依存のレンダラーコア。SDF / height field / normal / BRDF / cast shadow / mask(glyph)の各パイプライン(#13–#19)。詳細は `packages/renderer/README.md`
- **`packages/ukibori-dom` (`ukibori-dom`)**: #20のDOM統合層。retained DOM registry + 観測ベースのdirty updateでDOM geometryをrenderer sceneに同期し、`pointer-events: none`のoverlay canvasへcompositeします。DOMのlayout/semantics/accessibility/focus/eventsは一切置き換えません。詳細は `packages/ukibori-dom/README.md`
- 最終的なReact公開APIは#21で `ukibori` に追加予定です(未実装)

デモページ:

- `/` — CSS近似の旧デモ
- `/renderer-debug.html` — レンダラー中間bufferのデバッグ(#14–#19)
- `/dom-debug.html` — #20のDOM統合デモ(実DOM button + text、overlay composite、resize/scroll追従、mount/unmount)

## 開発コマンド

```sh
npm install        # workspace全依存のインストール
npm run typecheck  # ライブラリ + デモの型チェック
npm run test       # ライブラリの単体テスト
npm run build      # ライブラリ + デモのビルド
npm run dev        # デモを起動
```

## ステータス

#20(DOM統合層)実装済み。進行は [DEEPSEEK_IMPLEMENTATION_BRIEF.md](./DEEPSEEK_IMPLEMENTATION_BRIEF.md) のチェックポイント方式とGitHub Issue(#12〜)に従っています。
