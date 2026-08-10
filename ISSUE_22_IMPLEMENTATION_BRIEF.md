# Issue #22 実装指示書 — Exposure and environment illumination

## 情報源と優先順位

1. 上位方針: https://github.com/MasafumiYamaguchi/Ukibori/issues/12
2. 今回の作業: https://github.com/MasafumiYamaguchi/Ukibori/issues/22
3. リポジトリ内の既存契約・テスト・README

Issue #12を最上位のarchitecture invariant、Issue #22だけを今回の実装scopeとする。次のIssueへ進んではならない。

## 上位アーキテクチャ制約（Issue #12）

Ukiboriの主要pathは、DOM/primitive → shape → SDF/mask → height field → normal field → material/shared light → BRDF lighting + height-field shadow visibility → RGBA → DOM composite という2.5D rendererである。

- xはCSS pixel spaceの右、yは下、zは画面手前。
- `z-index`と物理`elevation`を混同しない。
- CSS box-shadowやgradientをphysical rendererの解決策にしない。
- SDF、height、normal、visibilityという実在する中間bufferを維持する。
- renderer semanticsをDOM/React層へ移さず、renderer → DOM → Reactの責務境界を保つ。
- 最終見た目だけでなく、要求された中間bufferをdebug viewとtestで確認可能にする。

## 現在のコードベース

現在のphysical CPU pathは次の構成である。

```text
<Ukibori>
  → UkiboriDom
  → buildScene / createScene
  → composeSdfHeightField (height + objectId)
  → computeVisibility
  → shadeHeightField
       → computeNormals
       → brdfDirect
       → baseColor * ambient + visibility * direct
       → sRGB encode
  → DOM compositor
```

- `packages/renderer/src/brdf.ts`はLambert `1 / PI`、GGX、height-correlated Smith、Schlick、metallic workflowを実装済み。
- `packages/renderer/src/lighting.ts`はlinear direct lightingとambientを合成後、直接sRGBへencodeしている。
- `packages/renderer/src/scene.ts`は共有directional lightとmaterial tableを所有するが、exposure/environmentはまだない。
- `packages/ukibori-dom`はlight/materialをsceneへ渡すretained integration層。
- `packages/ukibori`のproviderはlight/intensityを既存layerへ更新する。
- `demo/src/renderer-debug/RendererDebug.tsx`には同一geometry/lightのmaterial比較が既にある。

この流れを実ファイルで再確認してから変更すること。

## 目的

既存BRDFとgeometry/shadow pipelineを壊さず、physical rendererのsilicone/matte/metalがUIとして実用的な明るさと材質感を持つようにする。

```text
material / BRDF
  → direct directional lighting
    + environment illumination
  → exposure
  → sRGB output
```

## 必須実装

### Exposure

- linear lighting resultへsRGB encode前に適用する。
- MVPはfiniteで非負の単純なmultiplierでよい。
- 将来tone mappingを差し込める責務境界を明瞭にする。
- 0、非常に大きいfinite値、NaN、Infinity、負値のpolicyを明示しテストする。

### Environment diffuse

- dielectricへbaseColorに応じた簡易environment diffuseを加える。
- directional direct lightと独立したscene/shared environmentとする。
- surface/material別の根拠のないbrightness multiplierにしない。
- cast-shadow visibilityを掛けない。

### Environment specular

- metalがdirect specular lobe外でほぼ黒くならないよう、F0とroughnessを使った簡易environment specularを加える。
- HDRI/cubemap/full IBLは不要だが、将来置換可能な型と関数境界にする。
- environment OFFでは従来に近いdark responseを維持する。

### 共有APIと伝播

- rendererでenvironment/exposureのsemanticsを定義する。
- DOM integrationは値を保持しscene/lightingへ透過し、retained setterで更新できるようにする。
- React `<Ukibori>`から共有environment/exposureを指定できるようにする。例のprop名は調整してよい。
- prop更新でlayerやsurface registrationを再生成しない。
- SSRのserver/client初期出力を変えない。
- physical baseColor overrideは、責務境界を壊さず小さく実現できる場合だけ追加する。CSS `color`とは明確に分離し、sRGB入力ならrenderer前にlinear変換する。Issue #22完了に不要な大規模material APIへ発展させない。

### Preset

必要ならsilicone/matte/metal presetのbaseColorを調整してよい。ただしpresetを白くするだけで完了扱いにしてはならない。metalの本質的解決はenvironment contributionである。

### Debug view

同一geometry、同一directional lightで以下を人間が比較できるよう、既存renderer debug material sectionを更新する。

- material: silicone / matte / metal
- environment: OFF / ON
- exposure: low / default / high
- directional lightを動かした際、direct highlight/normal responseが残ること
- metalのenvironment OFF/ON差が分かること

## Acceptance Criteria

- [ ] Cook-Torrance BRDFを維持する。
- [ ] GGX / Smith / Schlickを維持する。
- [ ] Lambert diffuseの`1 / PI`を維持する。
- [ ] lighting計算をlinear color spaceで行う。
- [ ] `linear direct + environment → exposure → sRGB`の責務が明確である。
- [ ] siliconeとmatteが通常の明るいUI上で不自然に暗くない。
- [ ] metalのspecular highlight外の黒落ちをenvironment contributionで改善する。
- [ ] directional lightの方向依存responseを維持する。
- [ ] cast-shadow visibilityはdirect contributionだけへ従来どおり作用する。
- [ ] environment/exposure変更でgeometry、height、normal、objectId、visibilityが変わらない。
- [ ] material comparison debug viewで上記matrixを比較できる。
- [ ] environment OFF/ONを比較できる。
- [ ] exposure low/default/highを比較できる。
- [ ] exposure 0、environment intensity 0、specular intensity 0でfiniteな出力になる。
- [ ] very large finite exposure、roughness 0/1、metallic 0/1でもNaN/Infinityを生成しない。
- [ ] renderer tests、DOM/Reactの関連tests、typecheck、buildが通る。

buffer不変性は最終RGBAだけを比較して推測せず、height/normal/objectId/visibilityを直接比較するテストで証明すること。

## 禁止事項・Non-goals

- Lambertの`1 / PI`を削除しない。
- Cook-Torrance、GGX、Smith、Schlickをmagic formulaへ置換しない。
- material別magic brightness multiplierを入れない。
- CSS `filter: brightness()`、CSS background、box-shadowをcore solutionにしない。
- sRGB値をlinear値としてBRDFへ直接渡さない。
- geometry/SDF/normal/shadow algorithmを変更して明るさを解決しない。
- HDRI、cubemap、prefiltered environment map、BRDF LUT、GI、path tracing、glass/refractionを実装しない。
- Issue #22と無関係なrefactorを行わない。
- commit、push、`git reset`、`git clean`を行わない。

## 完了報告

実装・検証後は次を報告して停止する。

1. 変更ファイルと目的
2. 主要な設計判断とrenderer/DOM/React間のデータフロー
3. Acceptance Criteria各項目の対応状況
4. 実行したtest/typecheck/buildと結果
5. debug viewの起動方法と比較手順
6. 数値安定性とbuffer不変性を証明するtest
7. 未解決事項
8. `git status --short`と`git diff --stat`

次のIssueへ自動で進まず、Codexレビューを待つこと。

## 再開時の監査メモ

途中まで実装済みの場合も、差分全体をIssue #22の成果物として再確認すること。
特にrenderer / DOM / Reactの公開policyを一致させる。現在のpolicyではenvironment全体強度とexposureの負の有限値はそれぞれdefault `0.5` / `1`へfallbackし、diffuse/specular shareの負の有限値だけを`0`へclampする。React入口でも同じ結果になることを直接テストする。
