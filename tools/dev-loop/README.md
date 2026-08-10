# Codex supervisor loop

OpenCode上のDeepSeek V4 Flashを実装担当、`codex exec`を読み取り専用のレビュー担当として動かします。実装、検証、レビュー、差し戻しを同じOpenCodeセッションで反復します。

## 実行前の確認

- `opencode models`に`opencode-go/deepseek-v4-flash`が表示されること
- `codex exec`が認証済みであること
- 作業ツリーに残したい未コミット変更がある場合、事前に内容を把握していること
- `.codex-loop.json`の`checkpoint`が今回実施したいCPであること
- リポジトリと親ディレクトリの`AGENTS.md`があれば、その内容が実装プロンプトへ渡されること

## 実行

```sh
npm run dev:loop -- --checkpoint ISSUE-22
```

既定の実装モデルは`opencode-go/deepseek-v4-flash`、variantは`max`です。OpenCodeの同一セッションIDを次の反復へ渡し、Codexが`approve`するか、`blocked`になるか、最大反復回数に達するまで進みます。

検証コマンドが非0終了した場合は、その時点で後続の検証コマンドを止め、失敗結果をCodexへ渡します。Codexが`revise`した場合だけ次の反復へ進みます。OpenCode、Codex、Git証拠取得、設定、構造化レビュー自体の失敗はその場で停止します。

## 設定

`.codex-loop.json`では、指示書、チェックポイント、最大反復回数、モデル、variant、検証コマンドを設定できます。CLIの`--checkpoint`、`--max-iterations`、`--model`、`--variant`は設定を一時的に上書きします。設定は厳密に検証され、`CP1`〜`CP6`または`ISSUE-<number>`以外、空の検証コマンド、改行を含むコマンド、コミット・push・reset・cleanなどの変更系Git操作は拒否されます。

`reviewPaths`には、レビュー証拠の対象にするrepository-relativeなGit pathspecの配列を指定できます。

```json
{
  "reviewPaths": ["packages/renderer", "tools/dev-loop/*.mjs"]
}
```

指定すると、ループ開始時のbaseline status、各反復のstatus、`git diff --stat`、`git diff`、未追跡ファイルの内容がすべてそのpathspecに限定されます。これにより、Issue #22〜#26をコミットせず順次実装しても、対象範囲の累積diffをCodexへ渡せます。未指定時はリポジトリ全体を対象にする従来の挙動です。pathspecは空でないrepository-relativeな文字列に限られ、絶対path、`..`セグメント、制御文字、64個を超える配列は拒否されます。

OpenCodeとCodexの待ち時間は`implementationTimeoutMs`と`reviewTimeoutMs`でミリ秒単位に設定できます。既定値はそれぞれ`300000`（5分）と`120000`（2分）で、正の有限整数（最大`2147483647`）だけが許可されます。タイムアウトするとプロセスを終了し、対象phaseと設定値を`.codex-loop/state.json`および`logs/iteration-*-failure.log`へ記録して停止します。

検証コマンドは、信頼できるリポジトリ設定としてのみ記述してください。コマンド文字列は固定の`/bin/zsh -lc`へ渡しますが、プロセスの`spawn`自体は常に`shell: false`です。コマンドの標準出力と標準エラーは検証結果とログに保存されます。

## ログと安全境界

途中経過、検証、Git証拠、Codex応答、構造化レビューは`.codex-loop/`に保存され、このディレクトリはGit管理されません。ループはコミット、push、`git reset`、`git clean`を行いません。Codexは`read-only`サンドボックスで起動されます。

DeepSeekが非対話実行中にファイル編集と検証を完遂できるよう、OpenCodeは`--auto`付きで起動します。これは未拒否のOpenCode権限を自動承認するため、信頼できる指示書とリポジトリでだけ実行してください。実装プロンプトでは対象リポジトリ外の変更と破壊的Git操作を禁止し、作業ディレクトリも`--dir`で固定します。最終差分の確認とコミットは人間の責任です。

Codexのレビューは次のJSON形式に限定されます。

```json
{
  "decision": "approve | revise | blocked",
  "summary": "短い要約",
  "findings": [{ "severity": "critical | major | minor", "message": "指摘" }],
  "next_instruction": "revise時の具体的な指示"
}
```

終了コードは、承認が`0`、差し戻しなしで上限到達またはblockedが`2`、実行・設定・レビューの失敗が`1`です。最終的な差分は人間が確認してからコミットしてください。
