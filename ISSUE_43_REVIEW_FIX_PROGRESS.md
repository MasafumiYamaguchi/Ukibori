# Issue #43 最終レビュー指摘修正 — 完了レポート

- Branch: `feat/issue-43-shadow-reconstruction`
- レビュー対象 HEAD: `311d8f2` → 修正完了 HEAD: `d2a6b60`（WIP）→ 本レポート時点で最終コミット済み（下記参照）
- origin/master: `29e4224`（開始時・完了時とも同一。merge 不要）
- 目的: correctness / portability / contract 問題のみ修正（機能追加・方式再設計なし）

---

## 修正内容（レビュー項目別）

### 1. BLOCKER — partial planner の shadow halo を全 soft sample 方向の union へ ✅
- `gpu/tiles.ts`: 新規 `sampledShadowHaloUnion(lightDirection, angularRadius, samples, maxDistance)`。
  - ShadowPass と同じ canonical `computeSoftSampleDirectionVariants`（f32 成分同一）で全 variant × 全 sample 方向を生成し、component-wise max で union。
  - center 方向を baseline に含むため union >= historical center halo を常に保証。
  - maxDistance は ShadowPass が uniform に積む ONE sanitized scalar を共有（per-sample 独自 default なし）。
- `planPartialScene`: `sanitizeAngularRadius > 0 && effective.samples > 1` なら union、それ以外は従来 `shadowHalo(center)`（hard path の historical semantics 完全維持）。
- 単体テスト `tiles.test.ts`（9件追加、62/62 pass）: hard-path 一致 / radius 0 で center と完全一致 / 全 variant×samples の exact union / variant0 のみより広い / near-vertical(x=0)で左右両方>0 / 符号反転(+x→right>0, +y→bottom>0) / deterministic / maxDistance 検証 / planner 統合（soft は center-only より厳密に広い dirtyRect、hard は旧実装と完全一致）。

### 2. BLOCKER — center-only planner なら失敗する regression fixture ✅
- `parity.mjs` `runPartialReconstructionParity` を強化:
  - **numeric assert**: 実エンコード/options で `sampledShadowHaloUnion > shadowHalo`（実測: center=[0,0,4,0] union=[5.481,5.481,9.412,1.496]）。
  - 小編集（badge 30,120→32,121、単一 surface）で partial を維持（union halo で btn-a 移動は 0.533 で full 化するため badge 編集に変更、コメント明記）。
  - retained partial vs forced-full を **raw visibility / reconstructed visibility / lighting color / objectId / final canvas** の全フィールドで byte 比較。

### 3. HIGH-DPR contract ✅
- 方針 **A** 採用: public 4 CSS px footprint をサポート display-DPR `[1,4]` で維持。
- `MAX_RECONSTRUCTION_RADIUS_TEXELS` 8 → 16（= round(4×4)、worst taps (2·16+1)²=1089）＋新定数 `SUPPORTED_DISPLAY_DPR_MAX = 4`（export）。
- 範囲外（DPR>4）は cost cap で CSS footprint が縮むことを production docs（shadow-reconstruct.ts / ukibori-dom types.ts / coords.ts）に明記。
- テスト: DPR [1,1.5,2,3,4] × default 2px / explicit 4px の radiusTexels と footprint assert、DPR5 の劣化（16→3.2 CSS px）assert、coords.test.ts も DPR3/4 へ拡張。renderer/dom 両 typecheck ✅。

### 4. Portable final-canvas fixture ✅
- 実機調査で判明: D3D の unorm8 encode は CPU の round-half-up に対し **最大 ~0.057 byte-unit の偏差**（高密度スイープで 66/400 反転）。再構成（非 dyadic 商）の積が .5 境界近くに乗ると exact-alpha ポリシーで false failure する。
- `present-soft-shadow-custom-tint-alpha`: `reconstruction: { enabled: false }` を追加 → raw #41 の意図（dyadic 積・portable、margin 0.068）を復元。
- `present-reconstructed-soft-shadow`: portable なジオメトリ/パラメータに変更（elev2/size4/samples8/radius3/shadowAlpha≈0.29/tint[160,70,180]）→ **min quantization margin 0.1224 byte units**（D3D 反転包絡線の 2.1倍、safety 1655x）。
- `oracle.mjs`: `presentationReference` が `visibility/objectId/reconstructed` を返却、新 `reconstructedCanvasQuantizationReport` を追加。`parity.mjs` が reconstructed canvas fixture で margin を pin（PORTABLE でなければ FAIL）し detail に数値を出力（実測 `min=1.224e-1 safety=1655x -> PORTABLE`）。

### 5. classification ✅
- `compareReconstructedVisibility`: non-finite / [0,1] 違反 → `contract`、tolerance 超過のみ → `precision` に分類（semantic/domain violation を precision に隠さない）。

### 6. docs cleanup ✅
- `dirty.ts`: "six pipeline stages" → seven（canonical order に reconstruction 追加）。
- `pipeline.ts`: dispose 順 doc に reconstruction 追加（presentation→lighting→reconstruction→shadow→normal→height→uploader→timestamp profiler）。
- `shadow.ts`: `ShadowOptions.reconstruction.radius` を「SCENE units（CSS px は DOM public API のみ）」に修正。
- `reconstruction-pass.ts`: dpr フィールド doc の "CSS px -> texels" → scene-unit 変換である旨に修正。
- `parity.mjs` `runRetainedParity`: first-frame の 6 段チェック → 7 段へ修正（#43 の reconstruction 追加漏れ）。
- 禁止フレーズを grep 確認: "six pipeline stages" / "exact reconstructed visibility" / "bit-identical reconstruction" / "binary shadow visibility only" / "reconstruction gate is dimensionless" / "center-direction halo is sufficient" — 全て 0 件。

### 7. retained scheduler semantics ✅
- 実 WebGPU で検証: hard frame は historical halo + Recon bypass、soft frame は union halo + recon/lighting halo、retained/repaint/option-only の各 invalidation が期待通りの closure（retainedProblems=0）。

### 8. planner performance ✅
- union 計算は毎フレーム host で 128 directions 上限。premature caching なし（決定論的実装を優先）。

### 9. WGSL compile validation ✅
- `RECONSTRUCTION_PASS_WGSL` の `RECONSTRUCTION_WORKGROUP_SIZE` declaration（311d8f2）を維持、`checkShaders()` の compilationInfo check も維持。

### 10. real WebGPU tests ✅
- 下記「検証結果」参照。全パス。

### 11. catalog/golden version ✅
- `CATALOG_VERSION` 4 → 5（fixture payload 変更: presentation 2 fixture の options/scene、DPR reconstruction 2 fixture の separation）。
- goldens は公式 updater で再生成: **@metadata の catalogVersion のみ変更**（per-fixture digest 不変。reconstruction 系は golden 対象外）。手書き digest なし。

### 12. latest master確認 ✅
- 開始時・完了時とも origin/master = `29e4224`（進捗なし、merge 不要）。

### 13. 最終報告 — 本ファイル + コミットメッセージで実施。

---

## 検証結果（実 WebGPU、NVIDIA/Blackwell、headless Chrome）

```
UKIBORI_WEBGPU_PASS
92 fixtures, 0 mismatches
  shadow         0/70640  exact（raw #41 parity 維持）
  reconstructed  0/2880   (max abs 5.96e-8, max ulp 1.00)
  lighting       0/70128  (RGBA8 max deltas R0 G0 B0 A0)
  presentation  19 fixtures, 0 hard / 0 bad-alpha
  retained / partial / recon-partial problems: すべて 0
  benchmark      640x360: CPU 284ms / GPU 3.75ms, speedup 75.8x
  presentation benchmark: present-only 3.25ms
quantization margin (present-reconstructed-soft-shadow): min=1.224e-1, safety=1655x -> PORTABLE
recon-partial halo: center=[0,0,4,0] union=[5.481,5.481,9.412,1.496] union>center=true
```

Node 側: renderer 813 tests pass（4 file は既知の環境依存ロード失敗 — wasm/browser contract、baseline と同一）、ukibori-dom 103、ukibori 173、goldens verify pass、typecheck 全 clean。

---

## 変更ファイル（最終）

- `packages/renderer/src/gpu/tiles.ts` / `tiles.test.ts` — union halo + 単体テスト
- `packages/renderer/src/index.ts` — `sampledShadowHaloUnion` / `SUPPORTED_DISPLAY_DPR_MAX` export
- `packages/renderer/src/shadow-reconstruct.ts` / `.test.ts` — cap 16 化 + DPR contract テスト
- `packages/renderer/src/gpu/dirty.ts` — seven stages
- `packages/renderer/src/gpu/pipeline.ts` — dispose doc
- `packages/renderer/src/gpu/reconstruction-pass.ts` — dpr doc
- `packages/renderer/src/shadow.ts` — radius 単位表記
- `packages/ukibori-dom/src/types.ts` / `coords.ts` / `coords.test.ts` — supported DPR range + テスト
- `packages/renderer/test-browser/catalog.mjs` — portable canvas fixture / DPR fixture separation / CATALOG_VERSION 5
- `packages/renderer/test-browser/oracle.mjs` — classification + quantization margin report
- `packages/renderer/test-browser/parity.mjs` — union>center assert + field-level partial/full 比較 + margin pin + 7 段チェック
- `packages/renderer/test-browser/goldens/cpu-goldens.json` — catalogVersion 5（公式 updater）

## 残課題（unresolved limitations）

- 4 つの vitest file-load failure（`wasm-browser-contract` / `issue30-contract` / `test-browser-contract` / `wasm/determinism`）は本環境固有の .mjs/wasm import 問題で baseline と同一、本ブランチの変更とは無関係（修正対象外として報告）。
- `present-reconstructed-soft-shadow` の canvas byte parity は「portable なジオメトリ選択」で保証している（margin 0.1224）。D3D の unorm8 encode 偏差（~0.057 byte-unit）は本ブランチで観測された backend 特性であり、production compositor は変更していない。
