# Ukibori UI — DeepSeek V4 Flash 実装指示書

## 0. あなたの役割

あなたは、React + TypeScript製UIライブラリ **Ukibori（浮彫）** の実装担当者です。

作業ディレクトリ内のファイルを実際に作成・編集し、各チェックポイントでテストやビルドを実行してください。説明だけで終わらせてはいけません。

ただし、一度に最後まで実装してはいけません。後述のチェックポイントを **CP1から順番に1つずつ** 実施し、各CPが終わるたびに停止してください。ユーザーがCodexのレビュー結果と次の指示を渡すまで、次のCPへ進まないでください。

既存のユーザー変更を勝手に削除・上書きしないでください。`git reset --hard`、`git clean`、強制pushなどの破壊的操作は禁止です。コミットやpushも依頼されるまで行わないでください。

---

## 1. プロダクトの目的

Ukiboriは、平面的なDOM要素に、統一された光源から生じる「浮き出し・彫り込み・材質感」を与えるUIライブラリです。

中心となる考え方は次のとおりです。

- ページやUI領域に共有光源を1つ定義する
- 各Surfaceは、その光源とelevationに応じてハイライトと影を生成する
- `raised`（浮き出し）と`inset`（彫り込み）を同じモデルで扱う
- silicone / matte / glass / metalなどの材質プリセットを持つ
- DOMとCSSを主体とし、SSRで壊れず、Reactの通常の属性・イベント・アクセシビリティを保つ
- 厳密な物理レンダリングではなく、物理的に一貫した見た目を目指す軽量な近似である

想定する基本APIは次の形です。設計上の理由があれば細部は調整できますが、レビューなしに大幅変更しないでください。

```tsx
import { Ukibori, Surface } from "ukibori";

<Ukibori
  light={{ x: -0.6, y: -0.8, z: 1 }}
  intensity={1}
  color="#e4e8ef"
>
  <Surface
    material="silicone"
    variant="raised"
    elevation={6}
    radius={20}
  >
    Hello
  </Surface>
</Ukibori>
```

---

## 2. MVPの必須要件

### ライブラリ

- React 18/19をpeer dependencyとして扱うTypeScriptライブラリ
- ESMを基本とし、npmから利用できる正しい`exports`と型定義
- `Ukibori`プロバイダーと`Surface`コンポーネント
- 共有する3次元方向光ベクトル `{ x, y, z }`
- ゼロ長ベクトルや不正値を安全に処理する正規化処理
- `raised` / `inset`の両方
- `silicone` / `matte` / `glass` / `metal`のプリセット
- elevation、radius、intensity、base colorなどの調整
- CSSカスタムプロパティを使った出力
- `className`と`style`の合成
- `div`以外の要素を使えるpolymorphicな`as` API（型安全性を可能な範囲で保つ）
- `aria-*`、`data-*`、イベント、refなど通常のDOM propsを透過
- SSR時に`window`や`document`を要求しない
- reduced motionを尊重し、デフォルトで不要なアニメーションを入れない
- runtime dependencyは最小限

### デモ

- Vite + Reactの小さなインタラクティブデモ
- 光源方向、強度、elevation、radius、material、variantを操作できる
- 同じ共有光源が複数Surfaceへ一貫して反映されることを見せる
- ボタン、カード、入力、raised/insetの比較を含める
- 狭い画面でも破綻しない

### 品質

- コア計算の単体テスト
- Reactコンポーネントのレンダリングテスト
- SSRレンダリングテスト
- typecheck、test、buildがすべて成功
- READMEにインストール、基本例、API、材質、制約、開発コマンドを記載
- MIT License
- 「物理ベース」と誇張せず、box-shadow、background、filter等による近似であることを明記

---

## 3. 設計上の原則

1. **光源の一貫性**  
   `Ukibori`で光を一度定義し、子のSurfaceが同じ正規化済み光ベクトルを利用すること。

2. **計算とReactの分離**  
   ベクトル正規化、影のオフセット、材質解決、CSS値生成は可能な限り純粋関数にし、直接テストできるようにすること。

3. **ユーザー指定を尊重するスタイル合成**  
   ライブラリ内部の必須CSSカスタムプロパティとユーザーの`style`を意図的な優先順位で合成し、その規則をテスト・文書化すること。ユーザーの`className`を失わないこと。

4. **色の扱いを誤魔化さない**  
   任意CSS色をJavaScriptで完全解析しようとしないこと。必要ならCSSの`color-mix()`を利用し、対応範囲とフォールバックを明記すること。

5. **アクセシビリティを壊さない**  
   Surfaceは装飾のために意味のある要素を`div`へ強制しないこと。button等のfocus表示を消さないこと。glassでも文字の可読性を極端に落とさないこと。

6. **SSRと決定性**  
   初回サーバーレンダリングとクライアント初回レンダリングで同じ出力になること。

7. **過剰設計を避ける**  
   MVPではCanvas/WebGL、DOM測定、ポインタ追従、自動色抽出、複雑なプラグイン機構を導入しないこと。

---

## 4. チェックポイント方式

### CP1 — アーキテクチャと公開APIの骨格

実施内容:

- リポジトリを確認する
- npm workspaceを使うか単一packageにするか判断する
- package scripts、TypeScript、ビルド、テスト、Viteデモの最小構成を作る
- ライブラリの公開型と未完成でもよい最小の`Ukibori` / `Surface`を作る
- READMEに短いArchitecture Decision節を作り、構成理由を記す
- 依存関係をインストールし、typecheckとbuildの最低限を通す

CP1では、本格的な影・材質計算や完成したデモUIを作り込まないでください。

完了条件:

- ディレクトリ構成とpackage exportsが確認できる
- `Ukibori`と`Surface`をimportできる
- typecheckとbuildが成功する

### CP2 — 光・影の純粋計算

実施内容:

- 光ベクトルの正規化
- 不正値、NaN、Infinity、ゼロ長ベクトルのフォールバック
- elevation / intensityから影とハイライトのオフセット・blur・spread等を導出
- raisedとinsetで方向・表現を反転
- 値の妥当なclamp
- 純粋関数の単体テスト

完了条件:

- 計算がReactから独立している
- 境界値を含むテストが通る
- 丸め規則が安定し、SSRでも決定的

### CP3 — ProviderとSurfaceの完成

実施内容:

- Contextによる共有光源
- `Ukibori` propsの実装
- polymorphic `Surface`、ref転送、DOM props透過
- CSSカスタムプロパティとclassName/style合成
- raised/insetの視覚出力
- Provider外での安全なデフォルト
- コンポーネントテストとSSRテスト

完了条件:

- 基本API例が動く
- `as="button"`等が機能する
- DOM props、ref、aria属性が失われない
- SSRテストを含めテストが通る

### CP4 — Materialプリセット

実施内容:

- silicone / matte / glass / metalの材質トークン
- 各材質が単なる名前違いではなく、影の硬さ、ハイライト、彩度、透明感などに抑制された差を持つ
- glassの`backdrop-filter`非対応時にも内容を読めるフォールバック
- 利用者が部分的に材質トークンを上書きできる拡張方法
- プリセット解決のテスト

完了条件:

- 4材質がデモ前のfixtureで確認可能
- 未知のmaterial値を型またはruntimeで安全に扱う
- 制約とブラウザ依存を文書化

### CP5 — インタラクティブデモ

実施内容:

- レスポンシブなデモ画面
- light x/y/z、intensity、elevation、radius、material、variantのcontrols
- 複数Surface、button、card、input、raised/inset比較
- キーボード操作、label、focus-visibleを確保
- デモをbuildする

完了条件:

- controlsの変更が共有光源へ反映される
- モバイル幅で横スクロールや重なりが起きにくい
- demo buildが成功

### CP6 — 公開品質の仕上げ

実施内容:

- READMEを完成
- API表、例、材質説明、SSR、ブラウザ制約、近似モデルの説明
- MIT License、package metadata、files、sideEffects、exportsを監査
- npm packの内容を確認
- lint/typecheck/test/buildをすべて実行
- 不要ファイル、debug code、未使用依存を除去

完了条件:

- クリーン環境で再現できるコマンドがREADMEにある
- npm packageに必要な成果物だけが含まれる
- 全検証コマンドが成功

---

## 5. 各チェックポイント終了時の報告形式

各CPの実装が終わったら、必ずそこで停止し、次の形式だけで報告してください。

```md
## CPn 完了報告

### 実装した内容
- ...

### 主要な設計判断
- 判断: ...
  理由: ...

### 変更ファイル
- `path`: 目的

### 実行した検証
- `command`
  - 結果: PASS / FAIL
  - 要点: ...

### Codexに重点レビューしてほしい点
- ...

### 未解決事項・次CPへの持ち越し
- なし / ...

### Git差分
- `git status --short` の出力
- `git diff --stat` の出力
```

失敗した検証があれば隠さず、その標準エラーの重要部分と原因仮説を記載してください。長大なログ全文は不要です。

報告後は、必ず次の一文で終了してください。

> CPnのレビュー待ちです。次のチェックポイントには進みません。

---

## 6. Codexレビュー後の対応ルール

ユーザーからレビュー内容を受け取ったら、次の順序で対応してください。

1. 指摘を短く要約する
2. 指摘が正しいか現在のコードで確認する
3. そのCPの範囲内で修正する
4. 関連テストを追加または更新する
5. 全検証を再実行する
6. 同じ報告形式で「CPn 再レビュー依頼」を出す

Codexが明示的に **CPn承認、CP(n+1)へ進んでよい** と伝えた場合のみ次へ進んでください。

---

## 7. 最初に実行する指示

この文書を読んだら、まず **CP1だけ** を実装してください。

曖昧さがあっても、MVPの範囲内で安全かつ可逆な判断なら合理的に決め、設計判断として報告してください。プロダクトの方向を変える重大な判断、破壊的操作、外部公開、認証情報が必要な操作は停止して質問してください。

CP1完了後は所定の形式で報告し、レビューを待ってください。
