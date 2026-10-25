# R0・R1: 動的Surfaceの基準計測とGPU mask SDFの保持

静的な文字・SVG maskと、高さが連続的に変わるbuttonを同じsceneに置き、同じ条件で改善前後を比較した。基準はmaster `16b8aa104b7f75ad502589539bdb9ee2353a52ff`。対象は#79・#80。

マスク定義・alpha・workspace配置が不変なら、GPU SDFを再利用する。高さ・厚み・profile・Surface位置だけの変更ではSDFを再計算しない。mask追加・削除・順序・寸法・形式・alpha・配置、workspace/meta再allocation、dispose、device lossでは必要な再計算を行う。比較はhashではなく保持した入力bytesとGPU allocationのidentityを使う。

## 高さ処理は短縮したが、待ち時間の改善は確認できない

表は各60フレームの中央値 / p95、単位ms。GPU各passはtimestamp-query、host時間はperformance.nowで測る。全sampleは[before.json](before.json)と[after-r1.json](after-r1.json)へ保存した。

| 条件・指標 | R0（変更前） | R1（SDF保持） |
| --- | --- | --- |
| 通常 / GPU height | 2.699 / 2.716 | 0.129 / 0.130 |
| 通常 / GPU lighting | 0.037 / 0.042 | 0.037 / 0.037 |
| 通常 / DOM render host | 0.700 / 1.600 | 0.400 / 0.500 |
| 通常 / DOM計測 host | 0.000 / 0.100 | 0.000 / 0.100 |
| 通常 / scene構築 host | 0.100 / 0.100 | 0.000 / 0.100 |
| 通常 / scene upload host | 0.000 / 0.100 | 0.000 / 0.100 |
| 通常 / 更新〜GPU計測readback完了 | 16.700 / 18.100 | 17.900 / 18.900 |
| 発光・bloom / GPU height | 2.695 / 2.725 | 0.129 / 0.133 |
| 発光・bloom / GPU lighting | 0.037 / 0.040 | 0.037 / 0.043 |
| 発光・bloom / DOM render host | 1.600 / 1.900 | 0.500 / 1.600 |
| 発光・bloom / DOM計測 host | 0.100 / 0.200 | 0.000 / 0.100 |
| 発光・bloom / scene構築 host | 0.100 / 0.200 | 0.000 / 0.200 |
| 発光・bloom / scene upload host | 0.000 / 0.100 | 0.000 / 0.000 |
| 発光・bloom / 更新〜GPU計測readback完了 | 16.400 / 18.100 | 16.400 / 18.800 |
R1では高さ更新ごとの`maskSdfPasses`が1から0になった。通常照明のcompute dispatchは10→9、effects有効時は13→12で、composeの5 passは維持する。SDF以外の再設計は行っていない。

読み戻しを含む待ち時間にはschedulerの待機とGPU profilingのreadbackが含まれる。表示完了までのlatencyは未測定であり、60 FPSの保証には使わない。host計測は約0.1ms刻みなので、表の0は処理時間ゼロを意味しない。GPU presentationの計測値にも実行間の差があるため、全体の変化をSDF保持だけの効果とはしない。

## 再現条件

| 項目 | 固定値 |
| --- | --- |
| 端末 | MacBook Pro / Apple M4 Pro / 24GB |
| OS | macOS 26.6.2（25G83） |
| browser / adapter | Headless Chrome 156 / Apple Metal 3（software adapterではない） |
| viewport / effective DPR | 800×600 / 1 |
| stage | 320×180 CSS px、margin 8 |
| scene | 3 Surface: Arial bold 16pxの「UI」、16×16 SVG evenodd mask、112×48 button |
| geometry | buttonのelevation `8−6p`、thickness `3−2p`、bevel幅4 |
| shadow | 8 samples、angularRadius 0.12、maxDistance 48、reconstruction radius 2 |
| warmup / sample | 各条件20更新 / 60更新 |

benchmarkは`packages/ukibori/test-browser/dynamic-surfaces.tsx`、runnerは`test-dynamic-surfaces.mjs`。通常の計測は`npm run test:dynamic:webgpu -w ukibori`。`DYNAMIC_RESULT_PATH`を指定するとmarker付きの全結果を保存できる。R1の変更前を再測定するときは基準コミットへ同じfixture/runnerだけを適用する。


## 検証

rendererの単体テストに、連続高さ更新・partial dispatch・マスク変更・encoded bytesの再利用・forceMaskSdf・dispose・失敗後のretry・分割dispatchのtimestampを追加した。実GPUテストはDPR 0.75/1/1.5/2、24中間状態、24マスク変更、CPU height誤差1e-4、強制フル再計算との完全一致、実device lossと新adapter/deviceからの復帰を確認する。light/material-onlyとidleの既存テストも維持する。

実行コマンド: `npm test`、`npm run typecheck`、`npm run build`、`npm run test:webgpu -w ukibori-renderer`。実GPU結果は[webgpu-retained-mask.json](webgpu-retained-mask.json)に保存する。readbackは検証専用で、通常の描画には追加しない。SDF保持用の追加CPUメモリはmask定義とalpha payloadの比較コピーの合計で、disposeで解放する。
