# R0〜R3の完了条件と検証根拠

対象は#79〜#82の完了条件21項目。検証コードの基準は`582afa380e3c066baa0abdc6e7948a0cdd53977f`、React切替修正は`4139ea7`。実装・検証はPRに保存し、取り込み順は#83 → #84 → #85 → #86 → 追加検証PRとなる。

## R0 — #79

- [x] 固定fixture、DPR、GPU/OS/browser、scene条件、warmupを記録。基準は[再現条件](README.md#再現条件)と[before.json](before.json)。最終確認の端末とbrowserは[acceptance-dynamic.json](acceptance-dynamic.json)に収録した。
- [x] DOM計測・scene構築/upload・GPU pass・全フレームを区別してmedian/p95を記録。[計測表](README.md)と3つのbefore/after JSONが根拠。表示完了latencyは未測定、全体のwall値はscheduler/readbackを含むと明記した。
- [x] SDF dispatch数と静止後のidle復帰を観測。変更前はSDF 1回、R1後は0回。最終固定fixtureの両effects条件でも0回、idle=trueを確認した。
- [x] R1前の結果を保存し比較可能にした。before / after-r1は同じDPR、scene、shadow、warmup 20回・sample 60回。通常照明のdispatchは10→9、発光時は13→12。
- [x] DOM操作・focus・SSR/fallbackを維持。[操作検証](acceptance-press.json)、ReactのSSR/hydration・Radix・backendテスト、切替時のDOM identity回帰テストを確認した。

## R1 — #80

- [x] マスク不変の連続elevation更新でmaskSdfPasses=0。[実GPU結果](acceptance-webgpu.json)のretainedMasksで24中間状態と16 geometry変更を確認した。
- [x] mask追加/削除/順序/サイズ/alpha/配置、再allocation、device lossを検証。unitのmetadata再配置・workspace再作成・失敗retryと、実GPUの24 mask変更・16配置/size/profile変更・device loss復帰が根拠。
- [x] 強制フル再計算とCPU参照を比較。全保持フィールドはforced-fullと完全一致、CPU heightは既存許容誤差1e-4、ownershipは完全一致。
- [x] light/material-only保持、idle、disposeを維持。既存pipeline/HeightPassテスト、grain更新時のfield完全一致・zero dispatch、device loss後の新device生成を検証した。
- [x] R0と同条件でbefore/after median/p95とdispatchを比較。[計測表](README.md)にGPU heightの短縮と、readback込み全体時間では改善を確認できないことを記録した。

scene内のmask位置・Surface寸法は高さ合成を更新する。マスクローカルSDFの入力が同じならSDFを再利用する。定義・alpha・workspace内配置・metadata bufferが変わる場合はSDFを破棄する。位置変更を無視して高さまで保持する動作にはしない。

## R2 — #81

- [x] pointer/touch/keyboard、cancel、disabled、focus-visible、ARIAを維持。操作検証5条件でtrusted mouse/touch/keyを実行。capture喪失・window blur・consumer prevention・props/refはpress-recipe unitでも検証した。
- [x] 押下・戻り・選択の中間フレームを検証。各rowのmid/releaseMidは端点の間にあり、selectedは0または0.375へ正確に到達した。rendererでも24中間状態をCPUと比較した。
- [x] 終了・unmount後の不要なdispatchを防ぐ。WebGPU/CPUの有効なserialでidleを判定し、途中unmount前後のserialは両経路で不変。hookの遅延callbackも再予約しない。
- [x] reduced-motion、WebGPU/CPU/CSS fallbackを明示。[操作ガイド](interaction.md)に能力差を記載。実deviceを破棄した場合とnavigator.gpu非公開の場合に、grain有効のままCPUへ移行し、同じDOMで入力・選択・idle復帰が続くことを確認した。
- [x] headless UI合成とSSR/hydration導入例を確認。Radix ToggleのasChildでprops/ref/eventを合成し、renderToStringからhydrateしてbutton identityを維持。client境界の導入例は操作ガイドに記載した。
- [x] 条件を固定した操作性能・表示品質を報告。下表とacceptance-press.jsonに通常照明/発光のGPU・CPUを分けて保存。形状/影の比較誤差は既存goldenと同じで、CSSではgrain/発光/物理影を省略する。clip/transform/text fidelityの保証範囲もガイドに記載した。

backendとeffectsの同時切替で、破棄済みlayerへ更新を送る不具合が見つかった。作成時の構造条件と現在の条件が一致するlayerだけをcontextへ公開するよう修正した。非同期作成の完了前後で同じbuttonが残り、clickが動き、onErrorが空となる回帰テストは、修正前に失敗し修正後に成功した。

## R3 — #82

- [x] Surfaceに固定した座標とseed再現性を検証。GPUでseedを変えて戻すとpixelが完全一致。平行移動した内側のpixelは1 channel 1 byte以内で一致する。
- [x] DPR/resize/縮小のscaleとaliasingを制御。DPR 0.75/1/1.5/2、Surface自体とtargetのresize、セル幅が1 texel以下の無効化を確認。[材質契約](material.md)に減衰式を記載した。
- [x] 微細材質更新でheight/shadowを再計算しない。実GPU20条件でheight/caster/ownership/normal/visibilityを完全保持。CPU DOMではbuffer identityを保って再照明し、新規reference描画と一致する。
- [x] silhouetteとcast shadowを変えない契約を明記。roughnessだけを変え、床面には適用しない。unitと実GPUでgeometry/normal/shadowを比較した。
- [x] 既定offで従来出力を維持。無指定・strength=0・縮小で解像不能なgrainは既定出力と完全一致。既存121 fixtureは誤差条件を変更せず成功。CPU/GPUの新規grainはRGBA8各channel 1 byte以内、CPU/CSS fallback、性能・追加80 byte/Surfaceのメモリ影響は材質ガイドと計測表に記載した。

## 操作中の計測条件と結果

端末はApple M4 Pro、メモリ24 GiB、macOS 26.6.2（25G83）。browser/adapterの実値はJSONに保存した。stage 180×100 CSS px、button 100×40、margin 4、DPR 1、物理targetは各rowのrenderSize。shadowは1 sample、angularRadius 0、maxDistance 48。光はprovider既定のdirection=(-0.6,-0.8,1)、intensity 1、環境は固定したprovider既定値、材質はroughness 0.5/metallic 0。発光ありではemissive=(0.25,0.08,0.01)、bloom radius 8/intensity 0.5を使う。grainは操作性能の5条件ではoff、fallbackの2条件でon。

backend準備後200ms待機し、追加warmup更新は行わない。押下開始45ms後・戻り開始35ms後の中間状態を採取し、終点は最大3秒のguard内で正確な値への到達を待つ。観測フレームは押下・戻り・選択・mouse/touch・cancel・reduced-motion・disabledを含む。unmount/fallbackの測定は下表から除いた。条件と生データは[acceptance-press.json](acceptance-press.json)に保存した。

表は中央値 / p95、単位ms。DOM計測・scene構築はserialが増えたフレームだけを計上する。GPU各passはJSON内に別集計し、未実行のpassやCPU/CSSのGPU時間を0として扱わない。CSSは物理rendererを動かさないため未測定とした。

| backend | 発光/bloom | 観測フレーム | render host | DOM計測 host | scene構築 host |
| --- | --- | --- | --- | --- | --- |
| webgpu | なし | 49 | 1.500 / 3.400 | 0.100 / 0.100 | 0.100 / 0.100 |
| cpu | なし | 50 | 9.700 / 15.900 | 0.000 / 0.100 | 0.000 / 0.100 |
| css | なし | 0 | 未測定 | 未測定 | 未測定 |
| webgpu | あり | 49 | 1.500 / 2.700 | 0.100 / 0.200 | 0.000 / 0.100 |
| cpu | あり | 39 | 14.500 / 29.000 | 0.000 / 0.200 | 0.000 / 0.200 |

これは操作中のhost処理とopt-inのGPU pass計測であり、入力から表示完了までのlatencyは未測定。R0の20 warmup/60 sampleによる固定fixtureとは別の場面なので、性能差を直接比較しない。表示品質はgeometry/ownership/shadowのCPU比較、grainのRGBA8許容誤差、focus-visible・DOM identity・native入力の検証で確認した。60 FPSを保証する結果にはしない。

## 再実行

- `npm run typecheck` / `npm test` / `npm run build`。1592件（dev-loop 12、renderer 1125、DOM 218、React 237）が成功。
- `npm run test:webgpu -w ukibori-renderer`。121既存fixture、24中間状態、24 mask変更、16配置/寸法/profile変更、grain 20条件、Surface/target resize、seed再現、device loss復帰が成功。
- `npm run test:press:browser -w ukibori`。通常照明/発光のWebGPU・CPU、CSS、途中unmount、GPU喪失/非対応を検証する。
- `npm run test:dynamic:webgpu -w ukibori`。R0と同じfixtureの最終結果は[acceptance-dynamic.json](acceptance-dynamic.json)。通常照明・発光とも60 sampleでSDF 0回、終了後idle=true。
