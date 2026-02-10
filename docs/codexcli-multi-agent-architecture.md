# CodexCLI 複数エージェント統合 技術設計（TypeScript）

## 1. 目的
PM / Developer / QA の複数ロールが、CodexCLI 上で同一リポジトリを安全に扱えるようにする。主な狙いは次の 3 点。

1. **イベント駆動で役割ごとの処理を連携**すること。
2. **ファイルベースの状態管理（JSON + Markdown）**を維持しつつ整合性を保つこと。
3. PM の計画更新中に開発が先行しないよう、`backlog list --status=wait-implementation` に対して**変更ログ更新時刻によるガード**を実現すること。

---

## 2. スコープと前提

- 実装言語は TypeScript（Node.js 20 以上想定）。
- データ永続化は Git 管理下のファイル（ローカル FS）を使用。
- 運用は中央リポジトリ + 各開発者のクローン作業ディレクトリ。
- CLI は `buildfleet` として提供し、将来的に CodexCLI サブコマンドへ統合可能な構造にする。

---

## 3. 全体アーキテクチャ

```text
┌──────────────────────────────────────────────────────────┐
│                    buildfleet (TypeScript)                │
│  ┌───────────────┐  ┌────────────────┐  ┌─────────────┐ │
│  │ Command Layer │  │  Event Router  │  │ Policy Guard│ │
│  └──────┬────────┘  └──────┬─────────┘  └──────┬──────┘ │
│         │                   │                    │        │
│  ┌──────▼───────────────────▼────────────────────▼──────┐ │
│  │                  Domain Services                      │ │
│  │ AcceptanceService / BacklogService / RelationService │ │
│  └──────┬──────────────────────┬────────────────────────┘ │
│         │                      │                          │
│  ┌──────▼─────────┐    ┌───────▼────────┐                 │
│  │ Repository I/F │    │  Report Writer │                 │
│  │ (FS + Git)     │    │  (Markdown)    │                 │
│  └──────┬─────────┘    └───────┬────────┘                 │
└─────────┼──────────────────────┼──────────────────────────┘
          │                      │
   .buildfleet/data/acceptance-testing/*      .buildfleet/data/backlog/*
```

### 3.1 レイヤ責務

- **Command Layer**: CLI 引数解釈・出力整形。
- **Event Router**: manual / git(main更新) / ファイル作成イベントを標準イベントに正規化。
- **Policy Guard**: 実行前検証（時刻ガード、依存関係、可視性ルール）。
- **Domain Services**: ユースケース実行（add/list/update/delete）。
- **Repository I/F**: JSON/MD の原子的読み書き、Git メタ情報取得。

---

## 4. ディレクトリ / ファイル仕様

```text
.buildfleet/data/acceptance-testing/
  spec.json
  reports/
    <report-id>.md
  results/
    <result-id>.json

.buildfleet/data/backlog/
  items.json
  change-logs/
    <change-id>.md

.buildfleet/
  roles.json
  runtime/
    agents.json
    app-server-sessions.json
  logs/
    agents/
      <agent-id>.log
```

### 4.1 `.buildfleet/data/acceptance-testing/spec.json` と `.buildfleet/data/backlog/items.json` の仕様

- スキーマ仕様は `docs/buildfleet-data-schemas.md` に分離。
- 取り得るステータス値（列挙）も同ファイルで管理。
- `status` と `lastExecutionStatus` は責務分離し、実行時は `lastExecutionStatus` のみ更新。

### 4.2 `.buildfleet/runtime/agents.json` の仕様

- スキーマ仕様は `docs/buildfleet-data-schemas.md` の fleet runtime state を参照。
- 起動中エージェントの状態（`starting|running|stopped|failed`）と PID を保持。

### 4.3 `.buildfleet/runtime/app-server-sessions.json` の仕様

- スキーマ仕様は `docs/buildfleet-data-schemas.md` の app-server session state を参照。
- エージェントごとの App Server 接続状態、`threadId`、`activeTurnId` を保持。
### 4.4 `.buildfleet/data/backlog/change-logs/*.md`（例）

- Front matter に最小メタ情報を保持し、監査・時刻ガードに利用。

```md
---
id: CHG-20260112-001
actor: PM
type: backlog-update
createdAt: 2026-01-12T02:05:00Z
itemsJsonVersion: 3
---

- E-001 の依存関係を更新
- I-003 を wait-implementation に変更
```

---

## 5. イベントモデル

## 5.1 標準イベント型

```ts
type SystemEvent =
  | { type: "manual.triggered"; actor: "PM" | "QA" | "Developer" }
  | { type: "git.main.updated"; commit: string }
  | { type: "acceptance.result.created"; path: string }
  | { type: "backlog.poll.tick"; actor: "Developer" | "QA"; at: string }
  | { type: "fleet.lifecycle.changed"; status: "starting" | "running" | "stopped" | "degraded" };
```

## 5.2 要件とのマッピング

- PM/QA
  - `manual.triggered`
  - `git.main.updated`
  - 対応コマンド: `acceptance-test list|add|update|delete`
- PM
  - `acceptance.result.created`
  - 対応コマンド: `backlog epic|item add|list|update|delete`
- Developer/QA
  - `backlog.poll.tick`（ポーリング）
  - 対応コマンド: `backlog list --status=wait-implementation`

---

## 6. コマンド設計

## 6.1 Acceptance Test

```bash
buildfleet acceptance-test list
buildfleet acceptance-test add --title "..." --epic E-001 --item I-003
buildfleet acceptance-test update --id AT-001 --status ready
buildfleet acceptance-test result add --id AT-001 --status passed --summary "..."
buildfleet acceptance-test delete --id AT-001
```

- `spec.json` を source of truth とし、テストケース実行結果は `results/*.json` に保存。
- `results/*.json` を正本、`spec.json.tests[].lastExecutionStatus` をキャッシュ値として扱う。
- add/update/delete 時は `updatedAt` を必ず更新。

## 6.2 Backlog

```bash
buildfleet backlog epic add --title "..."
buildfleet backlog item add --epic E-001 --title "..."
buildfleet backlog list --status=wait-implementation
buildfleet backlog item update --id I-003 --status in-progress
buildfleet backlog item delete --id I-003
```

- 変更操作は必ず `items.json` 更新 + `change-logs/*.md` 追記を同一トランザクションで実施。
- `acceptanceTestIds` により Acceptance と Epic/Item を相互参照。

## 6.3 Fleet Control (`fleetctl`)

```bash
buildfleet fleetctl status
buildfleet fleetctl up
buildfleet fleetctl up -d
buildfleet fleetctl up --role Developer
buildfleet fleetctl up --role Developer -d
buildfleet fleetctl down --all
buildfleet fleetctl down --role QA
buildfleet fleetctl restart --all
buildfleet fleetctl logs --role Developer --tail 200
```

- `fleetctl up` のデフォルト対象は `--all`（`.buildfleet/roles.json` で定義された全エージェント）。
- `fleetctl up` はデフォルトでフォアグラウンド起動し、`-d` 指定時のみバックグラウンド起動する。
- `fleetctl up/down/restart --role <Role>` でロール単位の群制御を行える。
- 起動時は `.buildfleet/runtime/agents.json` を `starting` で作成/更新し、heartbeat 受信で `running` に遷移。
- `fleetctl up` 実行時に各エージェント用の `codex app-server` を透過的に起動する。
- App Server 起動直後に `initialize` を送信し、`initialized` 受信後に対話処理へ進む。
- `fleetctl down --all` は全 PID に SIGTERM を送信し、停止確認後 `stopped` へ遷移。
- `fleetctl down` 実行時は対応する App Server プロセスも透過的に停止する。
- `fleetctl restart --all` は `down -> up` を同一コマンドで実施。
- `fleetctl restart` は App Server を含めて `down -> up` を一括で実施する。
- `fleetctl logs` は `.buildfleet/logs/agents/<agent-id>.log` を role フィルタ付きで集約表示する。

---

## 7. 重要ポリシー（時刻ガード）

要件:

- `backlog list --status=wait-implementation` 実行時、
  - `max(mtime(.buildfleet/data/backlog/change-logs/*.md)) < mtime(.buildfleet/data/backlog/items.json)`
  - であれば **エラー**。

### 7.1 意図

PM が `items.json` を更新した直後、change-log 作成完了前に開発者が実装着手対象を取得することを防ぐ。

### 7.2 実装方針

1. `items.json` の mtime 取得。
2. `change-logs/*.md` の最新 mtime 取得（0 件なら epoch）。
3. `latestChangeLogMtime < itemsMtime` なら `ERR_BACKLOG_SNAPSHOT_NOT_STABLE`。
4. CLI は再試行を促す（例: 3 秒後）。

```ts
if (latestChangeLogMtime < itemsMtime) {
  throw new DomainError(
    "ERR_BACKLOG_SNAPSHOT_NOT_STABLE",
    "backlog is being updated; retry later"
  );
}
```

> 推奨: mtime に加えて `itemsJsonVersion` を change-log front matter に保存し、将来的に厳密な整合性検証へ拡張する。

---

## 8. Epic 非可視依存（依存関係整理）

「特定 Epic が全完了まで非可視」を次で実現:

- Epic に `visibility` を持たせる。
- `visibility.type = blocked-until-epic-complete`
- `dependsOnEpicIds` の全 Epic が `done` になるまで、`backlog list` デフォルト出力から除外。
- `--include-hidden` で PM のみ確認可能。

判定ロジック:

```ts
function isVisible(epic: Epic, epicsById: Map<string, Epic>): boolean {
  if (epic.visibility.type !== "blocked-until-epic-complete") return true;
  return epic.visibility.dependsOnEpicIds.every(id => epicsById.get(id)?.status === "done");
}
```

---

## 9. 中央リポジトリからの Clone 作業モデル

Developer/QA は中央リポジトリから作業ディレクトリを作成:

1. `git clone <central-repo> work/<user>/<ticket>`
2. `buildfleet backlog list --status=wait-implementation`
3. 対象 item を `in-progress` へ更新（PR 前提）
4. 実装・テスト
5. `spec.json` のテストケース実行結果を `.buildfleet/data/acceptance-testing/results/*.json` に記録（必要に応じて）
6. PR マージで `main` 更新 → PM/QA 側イベントが再実行

補助コマンド（任意）:

```bash
buildfleet workspace init --from-origin main --ticket I-003
```

---

## 10. モジュール構成（TypeScript）

```text
src/
  cli/
    index.ts
    commands/
      acceptance-test.ts
      backlog.ts
      fleetctl.ts
  events/
    router.ts
    watchers/
      git-main-watcher.ts
      result-file-watcher.ts
      backlog-poller.ts
  domain/
    acceptance/
      acceptance-service.ts
      acceptance-model.ts
    agents/
      fleet-manager.ts
      fleet-registry.ts
    backlog/
      backlog-service.ts
      backlog-model.ts
      visibility-policy.ts
      stable-snapshot-guard.ts
    relations/
      relation-service.ts
  infra/
    appserver/
      app-server-client.ts
      jsonl-rpc-transport.ts
      turn-event-subscriber.ts
    fs/
      json-repository.ts
      markdown-repository.ts
      mtime-provider.ts
    process/
      fleet-process-manager.ts
    git/
      git-client.ts
  shared/
    errors.ts
    clock.ts
```

---

## 11. 競合・障害時の扱い

- JSON 書き込みは「一時ファイル作成 → rename」で原子的に反映。
- 同時更新は `version` による楽観ロック（不一致で `ERR_VERSION_CONFLICT`）。
- 壊れた JSON 検出時はコマンド失敗 + 修復手順を表示。
- `backlog list --status=wait-implementation` はガード失敗を warning でなく error 扱い。
- 読み込み時・書き込み前後で JSON Schema バリデーションを実施する。
- `fleetctl status` 実行時に PID が不在/死活不一致のエージェントは `failed` へ self-heal する。

---

## 12. テスト戦略

- **Unit**
  - `stable-snapshot-guard.ts`
  - `visibility-policy.ts`
  - Acceptance/Backlog の CRUD バリデーション
  - fleet status 集計（running/stopped/degraded）
- **Integration（FS 実ファイル）**
  - `items.json` 更新のみ先に行ったケースで list がエラーになること
  - change-log 追加後に list 成功すること
  - acceptance-test と epic/item 関連が保持されること
  - `fleetctl up/down/restart` で `.buildfleet/runtime/agents.json` が更新されること
- **E2E（CLI）**
  - イベント発火 → コマンド実行 → ファイル出力確認まで
  - `fleetctl up -> status -> logs -> down` の一連操作

---

## 13. 導入ステップ（推奨）

1. Phase 1: Acceptance/Backlog の CRUD CLI を先行実装。
2. Phase 2: `stable-snapshot-guard` と change-log front matter 導入。
3. Phase 3: Epic 非可視依存と `--include-hidden`。
4. Phase 4: fleetctl 群制御 + App Server session 管理を実装。
5. Phase 5: event watcher（git 更新 / result 作成 / polling）を常駐プロセス化。
6. Phase 6: 運用メトリクス（エラー率、再試行回数、イベント遅延）を可視化。

---

## 14. 追加提案（実運用向け）

- `schemas/*.json` を置いて AJV で JSON 検証。
- App Server 連携の型/スキーマは手動定義でなく、以下の生成コマンドで取得した成果物を利用する。

```bash
codex app-server generate-ts --out ./schemas
codex app-server generate-json-schema --out ./schemas
```

- App Server バージョン更新時は再生成して差分をレビューする。
- `buildfleet doctor` で整合性診断（孤立 item、未参照 acceptance test 等）。
- `.buildfleet/data/backlog/change-logs` に actor 署名（Git user/email）を強制し、監査性を強化。
