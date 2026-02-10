# buildfleet AIエージェント向け実装計画（フェーズ分割）

この計画は、以下の仕様を実装へ落とし込むための実行順序を定義する。

- `docs/codexcli-multi-agent-architecture.md`
- `docs/buildfleet-data-schemas.md`
- `docs/schemas/*.json`

## 0. 実行方針

- 実装はフェーズ順に進める（前フェーズの完了条件を満たすまで次へ進まない）。
- 各フェーズで `PM` が受け入れ基準を確認し、`Developer` が実装、`QA` が検証を担当する。
- すべての JSON ファイル読み書きで schema validation を実施する。
- Codex App Server 連携は `fleetctl` の内部実装に限定する。

## 1. フェーズ一覧

### Phase 1: プロジェクト骨格と共通基盤

目的:

- CLI とドメイン層の最小骨格を作る。

実装対象:

- `src/cli/index.ts` とサブコマンドの雛形
- 共通エラー型（`ERR_*`）と clock/repository 抽象
- JSON 原子的書き込み（tmp + rename）

担当:

- PM: 受け入れ基準確定
- Developer: 実装
- QA: スモークテスト

完了条件:

- `buildfleet --help` で `acceptance-test`, `backlog`, `fleetctl` が表示される。
- 単体テストで原子的書き込みが検証される。

成果物:

- `src/cli/*`
- `src/shared/*`
- `src/infra/fs/*`

### Phase 2: Schema バリデーションとデータモデル実装

目的:

- 現行仕様ファイルを読み書きできる状態にする。

実装対象:

- `acceptance-testing-spec.schema.json` のモデル実装
- `acceptance-testing-result.schema.json` のモデル実装
- `backlog-items.schema.json` のモデル実装
- `roles.schema.json`, `agent-runtime.schema.json`, `app-server-session.schema.json` のモデル実装
- App Server schema/型生成コマンドの実行と成果物取り込み

```bash
codex app-server generate-ts --out ./schemas
codex app-server generate-json-schema --out ./schemas
```
- 読み込み時/書き込み前後の AJV 検証

担当:

- PM: バリデーション失敗時メッセージ方針を確定
- PM: App Server 生成スキーマ差分レビュー基準を確定
- Developer: 実装
- QA: 不正データケース検証

完了条件:

- 正常系 JSON は全て通る。
- App Server 生成 schema/TS 型が `schemas/` に反映される。
- 不正 JSON で明示的なエラーコードを返す。

成果物:

- `src/domain/*-model.ts`
- `src/infra/fs/json-repository.ts`（検証統合）

### Phase 3: Acceptance Test コマンド実装

目的:

- `spec.json` と `results/*.json` の責務分離を実装する。

実装対象:

- `acceptance-test list|add|update|delete`
- `acceptance-test result add`
- `results/*.json` 正本化
- `spec.json.tests[].lastExecutionStatus` のキャッシュ更新
- `status` 遷移制約（`draft/ready/in-progress/archived`）

担当:

- PM: status 遷移受け入れ確認
- Developer: 実装
- QA: result 先行書き込みと整合回復検証

完了条件:

- `result add` 実行で `results/*.json` 作成後に `spec.json` が更新される。
- `lastExecutionStatus` が `not-run/passed/failed` で正しく更新される。

成果物:

- `src/cli/commands/acceptance-test.ts`
- `src/domain/acceptance/*`

### Phase 4: Backlog コマンドと整合性ガード実装

目的:

- backlog CRUD と安定スナップショットガードを実装する。

実装対象:

- `backlog epic|item add|list|update|delete`
- `wait-implementation` の list ガード
- `change-logs/*.md` front matter 書き込み
- `visibility` と `--include-hidden`（PM 限定）
- `acceptanceTestIds` 参照整合性チェック

担当:

- PM: 可視性仕様・権限確認
- Developer: 実装
- QA: mtime ガードと権限制約の検証

完了条件:

- `latestChangeLogMtime < itemsMtime` のとき `ERR_BACKLOG_SNAPSHOT_NOT_STABLE` を返す。
- `--include-hidden` は PM ロールのみ成功する。

成果物:

- `src/cli/commands/backlog.ts`
- `src/domain/backlog/*`
- `src/domain/relations/*`

### Phase 5: fleetctl 群制御実装（内部 App Server 連携）

目的:

- AI エージェント群を `fleetctl` で起動・停止・監視し、内部で Codex App Server と連携できるようにする。

実装対象:

- `fleetctl status|up|down|restart|logs`
- `fleetctl up` のデフォルト `--all`
- `fleetctl up` はデフォルト foreground、`-d` で background
- `--role <Role>` による対象フィルタ
- `.buildfleet/runtime/agents.json` と `.buildfleet/runtime/app-server-sessions.json` の状態遷移
- App Server handshake（`initialize -> initialized`）

担当:

- PM: 運用コマンドの最終確認
- Developer: 実装
- QA: 起動モード・死活監視・ログ集約・handshake の検証

完了条件:

- `fleetctl up` で全エージェント起動、`fleetctl down --all` で全停止。
- `fleetctl up -d` でバックグラウンド起動が確認できる。
- `fleetctl up` 時に透過起動した App Server との handshake 完了後、全 session が `ready` になる。
- `fleetctl status` が `running/stopped/degraded` を正しく集計する。

成果物:

- `src/cli/commands/fleetctl.ts`
- `src/domain/agents/*`
- `src/infra/process/fleet-process-manager.ts`
- `src/infra/appserver/*`

### Phase 6: イベント統合と watcher 実装

目的:

- 仕様イベントを運用プロセスへ接続する。

実装対象:

- `manual.triggered`, `git.main.updated`, `acceptance.result.created`, `backlog.poll.tick`, `fleet.lifecycle.changed`
- watcher 常駐プロセス（git/result/poll）
- イベントルータと実行ディスパッチ

担当:

- PM: イベント優先順位と再試行方針承認
- Developer: 実装
- QA: E2E シナリオ検証

完了条件:

- 主要イベントから期待コマンドが起動される。
- 重複イベントでも破壊的副作用が起きない。

成果物:

- `src/events/router.ts`
- `src/events/watchers/*`

### Phase 7: 品質ゲート・運用準備

目的:

- 継続運用可能な品質基準を満たす。

実装対象:

- 単体/統合/E2E テスト拡充
- `buildfleet doctor`（整合性診断）
- CI で schema サンプル検証
- エラーコード一覧と運用手順のドキュメント化

担当:

- PM: リリース可否判定
- Developer: 実装とCI整備
- QA: 回帰テスト

完了条件:

- CI が green（unit/integration/e2e/schema check）。
- 主要コマンドの障害復旧手順が文書化済み。

成果物:

- `docs/runbook.md`（新規）
- `docs/errors.md`（新規）
- CI workflow

## 2. フェーズ間依存

- Phase 1 完了後に Phase 2。
- Phase 2 完了後に Phase 3/4 を並行可能。
- Phase 3/4 完了後に Phase 5。
- Phase 5 完了後に Phase 6。
- Phase 6 完了後に Phase 7。

## 3. エージェント運用ルール（実装時）

- PM:
  - 各フェーズ開始前に受け入れ基準を Issue 化する。
  - 各フェーズ終了時に「完了条件チェック」を実施する。
- Developer:
  - 1 PR = 1フェーズ内の単一テーマを原則とする。
  - スキーマ変更時は `docs/buildfleet-data-schemas.md` を同時更新する。
- QA:
  - 各フェーズで最低1つの異常系テストを必須化する。
  - `fleetctl` 系は foreground/background 両モードを必ず検証する。

## 4. 初回着手順（推奨）

1. Phase 1 の CLI 骨格と `ERR_*` 定義を先に作成。
2. Phase 2 で AJV 統合を先に完了。
3. Phase 3 と Phase 4 を分離 PR で実装。
4. Phase 5 で `fleetctl up` の foreground/background と app-server handshake を先に固定。
5. Phase 6 以降で watcher と運用文書を整備。

