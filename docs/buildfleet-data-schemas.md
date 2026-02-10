# buildfleet data schema 仕様

## 1. 対象ファイル

- `.buildfleet/data/acceptance-testing/spec.json`
- `.buildfleet/data/acceptance-testing/results/<result-id>.json`
- `.buildfleet/data/backlog/items.json`
- `.buildfleet/roles.json`
- `.buildfleet/runtime/agents.json`
- `.buildfleet/runtime/app-server-sessions.json`

## 2. acceptance-testing/spec.json

### 2.1 JSON Schema

- `docs/schemas/acceptance-testing-spec.schema.json` を参照。

### 2.2 status（テストケース自体のステータス）

- `draft`: 作成直後。内容未確定。
- `ready`: 実行可能。
- `in-progress`: テストケース更新作業中。
- `archived`: 廃止済み（通常一覧から除外）。

許可遷移:

- `draft -> ready`
- `ready -> in-progress`
- `in-progress -> ready`
- `draft|ready|in-progress -> archived`

### 2.3 lastExecutionStatus（最後のテスト実行結果）

- `not-run`: 未実行。
- `passed`: 直近実行が成功。
- `failed`: 直近実行が失敗。

更新ルール:

- テスト実行時は `status` を変更しない。
- テスト実行結果確定時に `lastExecutionStatus` を更新する。

## 3. acceptance-testing/results/*.json

### 3.1 JSON Schema

- `docs/schemas/acceptance-testing-result.schema.json` を参照。

### 3.2 正本ルール

- 実行結果の正本は `results/*.json`。
- `spec.json.tests[].lastExecutionStatus` はキャッシュ値。
- 書き込み順序は「`results/*.json` 書き込み成功 -> `spec.json` 更新」。
- 不整合時は `executedAt` が最新の `results/*.json` を正として self-heal する。

## 4. reports/*.md の位置づけ

- `reports/*.md` は人間向けの派生サマリ。
- 機械可読な正本は `results/*.json`。
- `reports/*.md` は再生成・上書き可能。

## 5. backlog/items.json

### 5.1 JSON Schema

- `docs/schemas/backlog-items.schema.json` を参照。

### 5.2 status（Epic）

- 値: `todo`, `in-progress`, `done`, `blocked`
- 許可遷移:
  - `todo -> in-progress`
  - `in-progress -> done`
  - `todo|in-progress -> blocked`
  - `blocked -> todo|in-progress`
  - `done -> in-progress` は `--reopen` 指定時のみ許可

### 5.3 status（Item）

- 値: `todo`, `wait-implementation`, `in-progress`, `done`, `blocked`
- 許可遷移:
  - `todo -> wait-implementation`
  - `wait-implementation -> in-progress`
  - `in-progress -> done`
  - `todo|wait-implementation|in-progress -> blocked`
  - `blocked -> todo|wait-implementation|in-progress`
  - `done -> in-progress` は `--reopen` 指定時のみ許可

## 6. 参照整合性と一意制約

- `acceptanceTestIds` に含まれる ID は `spec.json.tests[].id` に存在必須。
- `spec.tests[].id`、`items.epics[].id`、`items.items[].id`、`results[].resultId` はそれぞれ一意必須。
- 削除時はデフォルト拒否。`--force` 指定時のみ参照を除去して削除。

## 7. ロールと権限

- `.buildfleet/roles.json` の schema は `docs/schemas/roles.schema.json` を参照。
- ロール定義は `.buildfleet/roles.json`。
- `roles.json` はユーザーではなく AI エージェントにロールを付与する。
- `roles.json` の `agents[].id` にはエージェント識別子を設定する（例: `pm-agent`, `dev-agent-1`, `qa-agent`）。
- 未登録エージェントは `Developer` として扱う。
- `fleetctl --role <Role>` は `roles.json` に基づくロール単位の対象抽出に使用する。
- `--include-hidden`、`epic/item delete --force` は `PM` のみ許可。

サンプル:

```json
{
  "agents": [
    { "id": "pm-agent", "role": "PM" },
    { "id": "dev-agent-1", "role": "Developer" },
    { "id": "qa-agent", "role": "QA" }
  ]
}
```

## 8. バリデーション適用タイミング

- 読み込み時に schema validation。
- 書き込み前（入力）と書き込み後（永続化結果）で schema validation。
- CI で `docs/schemas/*.schema.json` とサンプル JSON の整合性を検証。
- App Server の型/スキーマは手書きせず、以下で生成した成果物を利用する。

```bash
codex app-server generate-ts --out ./schemas
codex app-server generate-json-schema --out ./schemas
```

- App Server バージョン更新時は上記コマンドを再実行し、差分をレビューして反映する。

## 9. 互換性・移行

- `version` メジャー更新時は migration script 必須。
- 旧フォーマット読み込みは 1 バージョン前まで後方互換。
- 移行失敗時はファイルを更新せずエラー終了。

## 10. fleet runtime state

### 10.1 JSON Schema

- `docs/schemas/agent-runtime.schema.json` を参照。

### 10.2 status（エージェント起動状態）

- `starting`: 起動処理中。
- `running`: 稼働中。
- `stopped`: 停止済み。
- `failed`: 起動・実行に失敗。

更新ルール:

- `fleetctl up`（デフォルト `--all`）直後は `starting`、heartbeat 受信後に `running`。
- `fleetctl up` はデフォルトでフォアグラウンド起動、`-d` 指定時はバックグラウンド起動。
- `fleetctl down --all` 成功時は `stopped`。
- プロセス異常終了時は `failed` と `lastError` を更新。

## 11. app-server session state

### 11.1 JSON Schema

- `docs/schemas/app-server-session.schema.json` を参照。

### 11.2 session status

- `disconnected`: App Server 未接続。
- `initializing`: `initialize` 実行中。
- `ready`: `initialized` 完了済み。
- `error`: 接続/プロトコルエラー。

更新ルール:

- `fleetctl up` で透過起動した App Server 直後は `initializing`。
- `initialized` 受信後は `ready`。
- 接続断または不正レスポンス受信時は `error`。
