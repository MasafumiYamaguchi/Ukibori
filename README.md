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
- **色の扱い**: 任意CSS色のJavaScript解析はしない。必要なら`color-mix()`を利用し、フォールバックを文書化する(CP4)。
- **公開APIの型**: `LightVector`, `MaterialName`, `Variant`などの型を`src/types.ts`に集約。polymorphic `as`の型安全性はCP3で詰める。
- **core計算のReact分離**: `src/core/light.ts`(光ベクトル正規化)と`src/core/shadow.ts`(影・ハイライト導出)はReact/CSS生成から独立した純粋関数。入力オブジェクトを変異させず、`NaN`/`Infinity`/ゼロベクトル/負値/極端値はすべて決定的なfallbackとclampに落ちる。丸めは`roundTo`(Math.roundベース、pxは2桁・ベクトルは6桁)に統一。

## スタイル合成の規則

`Surface`は内部で次のstyleを計算し、**ユーザーの`style`を最後に展開**します(衝突するプロパティはユーザーが優先)。`className`は連結され失われません。`as="button"`等のpolymorphic要素でもDOM props・イベント・ref・`aria-*`/`data-*`はそのまま透過します。

`Surface`が出力するCSSカスタムプロパティ:

| 変数 | 意味 |
| --- | --- |
| `--ukibori-variant` | `raised` / `inset` |
| `--ukibori-material` | 材質名(CP4で視覚化) |
| `--ukibori-elevation` | 適用後のelevation(px) |
| `--ukibori-radius` | 適用後のradius(px) |
| `--ukibori-shadow-color` | `box-shadow`の`var()`フォールバック。ユーザーstyleでの上書きが意図されたoverride点 |
| `--ukibori-highlight-color` | ハイライト側の`var()`フォールバック。同上 |

生成される`box-shadow`は影・ハイライトの2段重ねで、色の部分だけが`var()`フォールバック文字列になります(offset/blur/spread/alphaは計算値がpxで直接入ります)。影を丸ごと差し替えたい場合はユーザーstyleの`boxShadow`で上書きできます。

## 開発コマンド

```sh
npm install        # workspace全依存のインストール
npm run typecheck  # ライブラリ + デモの型チェック
npm run test       # ライブラリの単体テスト
npm run build      # ライブラリ + デモのビルド
npm run dev        # デモを起動
```

## ステータス

CP1完了。実装は [DEEPSEEK_IMPLEMENTATION_BRIEF.md](./DEEPSEEK_IMPLEMENTATION_BRIEF.md) のチェックポイント方式に従って進めています。
