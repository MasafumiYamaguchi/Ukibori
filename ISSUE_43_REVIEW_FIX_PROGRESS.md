# Issue #43 最終レビュー指摘修正 — 進捗レポート（中断時スナップショット）

- Branch: `feat/issue-43-shadow-reconstruction`
- 開始 HEAD: `311d8f2`（WGSL RECONSTRUCTION_WORKGROUP_SIZE 修正済みコミット）
- 本ドキュメント作成時点: **作業中の変更は未コミット**（下記「変更済みファイル」参照）
- 目的: correctness / portability / contract 問題のみ修正。機能追加・方式再設計は禁止。

---

## レビュー項目別ステータス

### 1. BLOCKER: partial planner の shadow halo を全 soft sample 方向の union へ — ✅ 実装済み・単体テスト済み

- `packages/renderer/src/gpu/tiles.ts`
  - 新規 export `sampledShadowHaloUnion(lightDirection, angularRadius, samples, maxDistance)`:
    - `computeSoftSampleDirectionVariants`（ShadowPass と同じ canonical host helper、f32 成分も同一）で全 variant × 全 sample 方向を生成
    - 各方向に対し `left = maxDistance*max(dx,0)` / `right = maxDistance*max(-dx,0)` / top/bottom 同様の component-wise max union
    - **center 方向の halo を baseline として含む** → union >= historical center halo が常に保証される
    - maxDistance は ShadowPass が uniform に積む ONE sanitized scalar（center 由来の default 含む）をそのまま共有。per-sample 独自 default は作らない
  - `planPartialScene`: `sanitizeAngularRadius(header.lightAngularRadius) > 0 && effective.samples > 1` なら union halo、それ以外は従来 `shadowHalo(center)`（historical 完全維持）
  - モジュール先頭の halo ルール説明も更新済み
- 単体テスト `tiles.test.ts` に describe 追加（9 件）:
  - hard-path baseline >= / radius 0 で center と完全一致 / 全 variant×samples の exact union 一致 / variant0 のみより広い / near-vertical(x=0) で左右両方 > 0 / 符号反転(+x 小さい中心→right>0, +y 小さい中心→bottom>0) / deterministic / maxDistance バリデーション
  - planner 統合テスト: soft シーンの dirtyRect が center-only 計算値より厳密に広い事を数値 assert ／ angularRadius=0 の hard frame は dirtyRect が旧実装計算値と完全一致
- 状態: `npx vitest run src/gpu/tiles.test.ts` → **62/62 pass**

注意（ハマりどころメモ）: `shadowHalo` の符号規約は「正の成分は MIN 側を拡張」（+x → left, +y → top）。円錐半角 0.25rad は純軸方向の中心より先に符号を反転させられない（例: ほぼ +x の光の sample が -x に行かない）。テスト/フィクスチャ設計時は中心成分を小さくする。

### 2. BLOCKER: center-only planner なら失敗する partial/full parity fixture — ❌ 未着手（設計メモあり）

実装先: `packages/renderer/test-browser/parity.mjs` の `runPartialReconstructionParity` 拡張 or 新 runner。
設計メモ:
- 光: center x = 0 の near-vertical（例 `(0, 0.0995, 0.995)` 正規化）、angularRadius = fround(0.15〜0.25)、samples 8、bounded maxDistance（例 24）
- tile size 8〜16（TILE_SIZE_MIN=8）で不足 halo が tile expansion 吸収されないようにする
- mover caster を 1px 水平移動。receiver 列は「center ray の dirty halo 外・sample ray union 内」に配置。sample の水平リーチ目安 ≈ sin(angularRadius)*maxDistance
- 必須 assert:
  - `api.sampledShadowHaloUnion(...) > api.shadowHalo(...)` を数値比較して detail に出す（exported pure functions を使用）
  - retained partial vs fresh forced-full で **raw visibility / reconstructed visibility / lighting color / final canvas** を test-only staging readback でバッファ比較（既存 `readback`/`readbackF32` ヘルパーを流用。partial snapshot は dispose 前に読む）

### 3. HIGH-DPR contract（MAX_RECONSTRUCTION_RADIUS_TEXELS）— ✅ 方針決定・実装・テスト済み

- **採用: 方針 A**。public 4 CSS px footprint をサポート display-DPR 範囲 `[1, 4]` で維持
- `shadow-reconstruct.ts`: `MAX_RECONSTRUCTION_RADIUS_TEXELS = 8 → 16`（= round(4 CSS px × 4)、worst tap (2·16+1)² = 1089）＋新定数 `SUPPORTED_DISPLAY_DPR_MAX = 4`（export 済み、index.ts も更新）
- 範囲外（DPR>4）は cost cap が勝ち CSS footprint が縮むことを**明文化**（無言のまま DPR-invariant と書く禁止事項は回避）
- `index.ts`: `SUPPORTED_DISPLAY_DPR_MAX` を追加 export
- テスト:
  - `shadow-reconstruct.test.ts`: `{radius:2}, dpr4` 期待値 8 に修正（cap でなくなるため）、DPR [1,1.5,2,3,4] × default 2px / explicit 4px の radiusTexels と footprint(radiusTexels/dpr==css) assert、範囲外 DPR5 → 16 texels (=3.2 CSS px) の劣化 assert → **16/16 pass**
  - `ukibori-dom/src/coords.test.ts`: defaults の DPR3/4 追加、radius4 CSS px の footprint 不変ループを [1,1.5,2,3,4] へ拡張 → **未実行（要確認）**
- DOM docs（`ukibori-dom/src/types.ts`, `coords.ts`）に supported range と範囲外劣化を明記

### 4. reconstructed canvas の quantization margin — ❌ 未着手

方針メモ:
- `oracle.mjs` `presentationReference` が内部で使う `visibility` 配列を戻り値に追加
- 新ヘルパー（oracle.mjs）: base-plane texel ごとに byte 空間での境界距離を計算
  - alpha 値[byte 単位] = saByte * strength、premult RGB = cByte * saByte * strength / 255
  - margin(v) = |v - floor(v) - 0.5| との距離
  - 合法 drift 上限: alpha ≤ saByte * TOL(1e-6)、RGB ≤ cByte*saByte/255*TOL → margin > 余裕係数(例 1e3倍 or 最低 1e-3)を assert
- `parity.mjs` の `present-reconstructed-soft-shadow` 処理で report + FAIL 条件にする
- margin 不足なら fixture の shadowAlpha/tint/radius を調整（production compositor は触らない）
- 現状の失敗実績: `present-soft-shadow-custom-tint-alpha` と `present-reconstructed-soft-shadow` が各 2 texel の ±1 バイト差で FAIL（texel(11,5)/(12,5)。cpu=[3,1,3,3] vs gpu=[2,0,3,3]、alpha 差）。#41 の「積が整数になる」前提が recon の非 dyadic 商で崩れているのが原因想定

### 5. visibility-reconstructed の classification — ❌ 未着手

方針: `compareReconstructedVisibility` の `mismatchReport` 呼び出しに context を追加
- non-finite / [0,1] 違反 → `{ classification: "contract" }`
- tolerance 超過のみ → `{ classification: "precision" }`
- `classifyMismatch` は context.classification を最優先するので、これだけで解決（"visibility-reconstructed" 自体のフォールスルーは unclassified のまま残るが context で必ず分類される）

### 6. docs cleanup — 🔶 部分完了

- ✅ `dirty.ts`: "The six pipeline stages" → seven + `upload -> height -> normal -> shadow -> reconstruction -> lighting -> presentation`
- ✅ `pipeline.ts` dispose doc: presentation, lighting, **reconstruction**, shadow, normal, height, uploader, timestamp profiler の順に修正
- ✅ `shadow.ts` `ShadowOptions.reconstruction` doc: "(CSS px)" → "SCENE units — only the DOM layer's public API is CSS px"
- ✅ grep 確認済み（0 件）: "six pipeline stages|six stages"、"exact reconstructed visibility"、"bit-identical reconstruction"、"binary shadow visibility only"、"reconstruction gate is dimensionless"、"center-direction halo is sufficient"
- ⬜ 追加 grep 未実施: README.md / test-browser docs / `packages/renderer` 内 "CSS px" 表記の残り（shadow-reconstruct.ts 内は DOM 専用文脈なので OK のだが要再確認）、"disposal"/"dispose sequence" 系の reconstruction 抜け

### 7. retained scheduler semantics 再確認 — ⬜ テスト実行で確認するのみ（コード変更なしの予定）

確認ポイント: hard frame は historical halo + Recon bypass／soft frame は union halo + recon/lighting halo／light/angularRadius 変更は semantic full／recon option-only は recon→lighting→presentation／identical frame は全 retained。

### 8. planner performance — ✅ 方針通り（caching 無し・都度計算）

128 directions 上限の host 計算。premature caching 導入せず。

### 9. WGSL compile validation — ✅ 維持（311d8f2 の内容に手付き無し）

`RECONSTRUCTION_PASS_WGSL` の compilationInfo check は parity.mjs に残っている。触っていない。

### 10〜13. テスト一式実行 / catalog version / master 確認 / 最終報告 — ⬜ 未着手

- catalog.mjs / goldens は**現時点で未変更**（version bump 不要のはず。item 2/4 を parity.mjs と oracle.mjs だけで実装すれば bump 不要で済む）
- origin/master 確認は作業完了直前に実施（開始時点: 29e4224 で進行無しを確認済み…ただし最終再確認が必要）

---

## 変更済みファイル（未コミット）

1. `packages/renderer/src/gpu/tiles.ts` — sampledShadowHaloUnion 追加、planPartialScene 分岐、module doc 更新
2. `packages/renderer/src/gpu/tiles.test.ts` — #43 halo describe 追加（import に computeSoftSampleDirections / SHADOW_KERNEL_VARIANTS / parseHeader / sampledShadowHaloUnion を追加）
3. `packages/renderer/src/shadow-reconstruct.ts` — cap 16 化 + SUPPORTED_DISPLAY_DPR_MAX + docs
4. `packages/renderer/src/shadow-reconstruct.test.ts` — DPR コントラクトテスト更新
5. `packages/renderer/src/index.ts` — SUPPORTED_DISPLAY_DPR_MAX export
6. `packages/ukibori-dom/src/coords.ts` — doc 更新（import は NET: SUPPORTED_DISPLAY_DPR_MAX は import から削除済み、doc のみ言及）
7. `packages/ukibori-dom/src/coords.test.ts` — DPR3/4 追加テスト
8. `packages/ukibori-dom/src/types.ts` — reconstruction doc に supported range 明記
9. `packages/renderer/src/gpu/dirty.ts` — seven stages 修正
10. `packages/renderer/src/gpu/pipeline.ts` — dispose doc 修正
11. `packages/renderer/src/shadow.ts` — reconstruction.radius 単位表記修正

## 検証状態（このスナップショット時点）

- `vitest src/gpu/tiles.test.ts`: 62/62 ✅
- `vitest src/shadow-reconstruct.test.ts`: 16/16 ✅
- renderer フル suite: 直近（変更前ベース）803 tests pass ＋ 4 ファイルが環境起因のロード失敗（wasm-browser-contract / issue30-contract / test-browser-contract / wasm determinism — ベースラインでも同一、無関係）
- `tsc --noEmit` (renderer): 最新編集後に**未再実行**
- ukibori-dom tests: coords.test.ts 編集後に**未再実行**
- real WebGPU harness (`CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" npm run test:webgpu` @ packages/renderer):
  - 311d8f2 時点の結果: reconstruction parity 0 mismatch (max abs 6e-8)。残FAIL = `shadow-reconstruction-dpr2`（CPU オラクル razor-edge stability throw、ベースラインから存在・別件）＋ presentation 2 fixture の ±1 バイト（item 4 の対象）
  - 今日の変更後は**未実行**

## 再開手順の目安

1. `npm run typecheck -w ukibori-renderer` → `npx vitest run`（renderer）→ `npm test -w ukibori-dom` → `npm test -w ukibori`
2. item 5 → oracle.mjs（小）→ item 4 → oracle.mjs + parity.mjs → item 2 → parity.mjs（最大工数）
3. goldens/catalog に触ったら公式 updater のみ（`npm run goldens:update -w ukibori-renderer`）
4. `npm run build` 全ワークスペース → real WebGPU harness フル実行 → 残 FAIL の帰属整理
5. `git fetch origin && git log HEAD..origin/master` で進んでいれば merge
6. commit（fix(renderer) 系、repo スタイル準拠）→ push → 最終報告（レビュー指示 13 の 19 項目)

## その他の作業アーティファクト（repo 外）

- 再現ハーネス: `C:\Users\karub\AppData\Local\Temp\opencode\ukibori-repro\`（repro.html/.mjs/run.mjs。Chrome headless + CDP で個別検証するとき便利）
