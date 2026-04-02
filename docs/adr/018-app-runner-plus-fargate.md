# ADR-018: Web = App Runner, Worker = ECS Fargate

## ステータス

**置換済み（Superseded by ADR-020）**

## コンテキスト

KUKAN のデプロイ基盤として、Web（Next.js）と Worker（SQS consumer）の実行方式を決定する必要がある。

### 要件

- **Web**: HTTP リクエスト駆動、オートスケーリング、ゼロ運用に近いマネージドサービス
- **Worker**: SQS ロングポーリングによる常駐プロセス、長時間ジョブ対応

### 検討した選択肢

| 方式 | Web         | Worker                          | 備考                                              |
| ---- | ----------- | ------------------------------- | ------------------------------------------------- |
| A    | App Runner  | App Runner                      | Worker が CPU スロットリングで SQS ポーリング停止 |
| B    | App Runner  | ECS Fargate Service             | ★ 採用                                            |
| C    | App Runner  | EventBridge Pipes → ECS RunTask | コールドスタート 30-60 秒、デュアルモード必要     |
| D    | ECS Fargate | ECS Fargate                     | 運用コスト増（ALB 必要）、メリットなし            |

## 決定

**Web = App Runner、Worker = ECS Fargate Service** を採用する。

### Web → App Runner

- HTTP ベースのリクエスト/レスポンスに最適化
- ECR イメージプッシュで自動デプロイ
- リクエスト数に応じた自動スケーリング（min/max 設定可能）
- VPC Connector で RDS / OpenSearch へ接続

### Worker → ECS Fargate Service

- **SQS ロングポーリング**がスロットリングなしで動作
- ローカル開発（Docker Compose + ElasticMQ）と本番の**アーキテクチャ完全一致**
- ジョブ実行時間に**制限なし**（大容量 CSV の Parquet 変換等）
- HTTP ヘルスチェック（`/health`）で SQS ポーリングループの正常性を監視
  - `lastPollAt`（最終ポーリング時刻）と `processingJobSince`（ジョブ処理中フラグ）を追跡
  - ポーリング停止 & 非処理中 → 503 → ECS が unhealthy 判定 → 自動タスク再起動

### App Runner が Worker に不適な理由

App Runner はプロビジョニング済みインスタンスの CPU をスロットリングする（AWS re:Post 確認済み）。
これにより SQS `ReceiveMessage` の 20 秒ロングポーリングが事実上動作しなくなる。
セルフ ping 等の回避策は効果がないことが確認されている。

## 影響

- コスト: Worker は ECS Fargate 常時稼働（small: ~$9/月）
- CDK: App Runner (L2 alpha) + ECS Fargate Service の 2 つのコンストラクトが必要
- Docker: 単一 Dockerfile にマルチターゲット（`web` / `worker`）

## 関連

- CDK 実装: `infra/lib/constructs/web-service.ts`, `infra/lib/constructs/worker-service.ts`
- Worker ヘルスチェック: `apps/worker/src/index.ts`, `packages/adapters/queue/src/sqs.ts`
