# 微細材質はroughnessだけを変える

R3の初版は、粒状感のある樹脂をSurfaceのroughness変化で表す。省略時と`strength: 0`では無効になる。高さ場・法線場・silhouette・caster・cast shadowは変わらず、床面には適用しない。

## Surfaceの左上に模様を固定する

描画texel `(tx, ty)` とSurfaceの位置から、次の順で座標を求める。

```text
texel center → scene coordinate: ((tx + 0.5) / dpr, (ty + 0.5) / dpr)
scene coordinate − surface origin → local coordinate
local coordinate / scale → noise cell coordinate
u32(seed, cell x, cell y) → smooth value noise → roughness
```

`scale`はセルの幅で、React/DOM APIではCSS px相当の長さとなる。既定3、`strength`は既定0.3、`seed`は既定0でu32へ正規化する。時刻を入力に含めない。同じ設定なら再現でき、位置の変更は模様の原点も移動する。サイズ変更時はセル幅を維持し、見える範囲が変わる。任意のCSS transformには対応しない。

整数hashはu32の乗算・XOR・shiftを使い、CPUは`Math.imul`、WGSLはu32演算で対応させる。セル間をsmoothstepで補間する。4096セルごとに周期化し、整数変換の範囲を制限する。CPUのサンプル計算もf32へ丸める。

## 解像できない粒は弱める

有効なセル幅を `q = scale × renderDpr` texelとすると、変動幅へ `clamp((q − 1) / 3, 0, 1)` を掛ける。1 texel以下で変化を消し、4 texel以上で指定された変化を保つ。DPR・qualityを下げると同じCSSサイズでも細部が弱まる。これは初版の低域化方針であり、異方性フィルタや画像mipmapは導入していない。

DOM統合はsceneをdevice pxへ変換済みなので、セル幅も一度だけDPR倍する。GPU encoderへ渡すDPRは既存どおり1とする。rendererの`shadePreparedFields`を直接使う場合は、`LightingOptions.dpr`へ描画DPRを指定する。

## 高さと影の保持を維持する

GPU ABI v5ではMaterialRecordの48/52/56 byteにscale/strength/seedを格納する。strideは64 byteのまま。v4以前はvalidatorで拒否するため、保存したencoded sceneは再encodeする。

通常のlightingは従来のmaterial table/idを直接読む。grain有効時だけ、MaterialRecordとSurface原点を組にした80 byteのレコードをSurface数だけ生成し、既存の2 bindingをshading table/objectIdへ差し替える。storage binding数は8、compute dispatch数は1のまま。共有materialを使うSurface同士も、原点を個別に保持する。

材質だけの変更ではGPUのheight/normal/shadowを再実行しない。CPU DOM fallbackでは、grainが前後どちらかで有効な場合に、既存のscene byte classifierでmaterial-only変更を確認し、中間バッファを保持して再照明する。geometryまたは影設定が変われば従来のフル計算へ戻る。CSS fallbackでは粒を省略し、通常のDOM操作を保つ。

GPUの追加メモリは80 × Surface数 byte（最小80 byte）。その表をlighting更新ごとにuploadし、profilingの`grainInputBytesUploaded`にも記録する。tableのGPU allocationは再利用し、disposeで解放する。SDF保持用のCPU比較コピーはmask定義とalpha payloadの合計サイズとなる。

## 比較条件

CPU参照にはGPUで実際に使ったnormal・ownership・再構成後のvisibilityを渡す。DPR 0.75/1/1.5/2、seed/scale変更、縮小時の無効化、Surfaceの平行移動とresizeを検証する。新しいgrainのRGBA8比較は1 channelあたり1 byte以内とし、既存のgolden条件は変更しない。高さ保持と強制フル再計算の比較は完全一致を要求する。
