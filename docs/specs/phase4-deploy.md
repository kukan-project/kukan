# Phase 4: AWS デプロイ & CDK 基盤

## 概要

デモ環境を外部に公開するための AWS デプロイ基盤。
OSS 公開時にユーザーが `cdk deploy` で自環境を構築できることを目指す。

## アーキテクチャ

```
Route53 ─→ CloudFront (ACM/WAF) ─→ App Runner "web"
                                         │ VPC Connector
                                         ▼
                              ┌─── Private Subnets ───┐
                              │  Aurora/RDS PostgreSQL │
                              │  OpenSearch 3.x        │
                              │  ECS Fargate "worker"  │
                              └────────────────────────┘
                                         │
                              ┌─── Public Subnet ─────┐
                              │  NAT Instance (t4g.nano)│
                              └────────────────────────┘

S3 ← presigned URL (ブラウザ直接) / Worker 読み書き
SQS ← API enqueue → Worker consume (ロングポーリング)
```

### コンポーネント

| コンポーネント | サービス                                          | 理由                                             |
| -------------- | ------------------------------------------------- | ------------------------------------------------ |
| Web            | App Runner                                        | HTTP 駆動、自動スケーリング、ゼロ運用            |
| Worker         | ECS Fargate Service                               | SQS ロングポーリング、タイムアウトなし           |
| DB             | RDS PostgreSQL / Aurora Serverless v2             | CDK パラメータで切替                             |
| 検索           | OpenSearch (VPC)                                  | kuromoji プラグイン、PostgreSQL フォールバック可 |
| ストレージ     | S3                                                | presigned URL でブラウザ直接アップロード         |
| キュー         | SQS + DLQ                                         | 無料枠内、ElasticMQ と同一 API                   |
| CDN            | CloudFront + ACM + WAF                            | カスタムドメイン、HTTPS 終端                     |
| NAT            | t4g.nano Instance (small) / NAT Gateway (medium+) | コスト最適化                                     |

## VPC 設計

```
VPC (10.0.0.0/16)
├── Public Subnet A (AZ-a)  ← NAT Instance
├── Public Subnet B (AZ-c)
├── Private Subnet A (AZ-a) ← RDS / OpenSearch / Fargate / VPC Connector ENI
└── Private Subnet B (AZ-c) ← RDS (multi-AZ) / VPC Connector ENI
```

- S3 Gateway VPC Endpoint（無料）で S3 トラフィックを NAT 経由から除外

## Worker ヘルスチェック

ECS Fargate の HTTP ヘルスチェックで SQS ポーリングループの正常性を監視。

- **エンドポイント**: `GET http://localhost:8080/health`
- **正常判定**: `lastPollAt` が 60 秒以内 **OR** `processingJobSince` がセット（ジョブ処理中）
- **異常判定**: 両方 null or `lastPollAt` が 60 秒超 & 非処理中 → 503
- **ECS 動作**: 503 × 3 回 → unhealthy → タスク自動再起動

## DB エンジン選択

CDK の `dbEngine` パラメータ（`rds` | `aurora`）で切替。

|                  | RDS PostgreSQL t4g.micro | Aurora Serverless v2 (0 ACU) |
| ---------------- | ------------------------ | ---------------------------- |
| 月額 (常時)      | ~$15                     | ~$73 (0.5 ACU min)           |
| 月額 (4h/日)     | ~$15                     | ~$13                         |
| 月額 (未使用)    | ~$15                     | ~$1.20 (storage のみ)        |
| コールドスタート | なし                     | ~15 秒                       |

## コスト試算

### Small（デモ / PoC）: ~$68/月

| サービス              | スペック            | 月額 USD |
| --------------------- | ------------------- | -------- |
| App Runner Web        | 0.25 vCPU / 0.5 GB  | ~$5      |
| ECS Fargate Worker    | 0.25 vCPU / 0.5 GB  | ~$9      |
| RDS PostgreSQL        | db.t4g.micro        | ~$15     |
| OpenSearch            | t3.small.search × 1 | ~$27     |
| S3 + SQS + CloudFront | 最小                | ~$3      |
| NAT Instance          | t4g.nano            | ~$3      |
| WAF                   | 基本ルール          | ~$6      |

OpenSearch なし（SEARCH_TYPE=postgres）: ~$41/月

### Medium（単一自治体）: ~$250/月

### Large（都道府県 / 国レベル）: ~$1,000/月

## CDK スタック構成

```
infra/
├── bin/app.ts                        # エントリポイント
├── lib/
│   ├── kukan-stack.ts                # メインスタック
│   ├── config.ts                     # スケール別設定
│   └── constructs/
│       ├── network.ts                # VPC, NAT, SG, S3 Endpoint
│       ├── database.ts               # RDS / Aurora + Secrets Manager
│       ├── storage.ts                # S3 Bucket (CORS, lifecycle)
│       ├── queue.ts                  # SQS + DLQ
│       ├── search.ts                 # OpenSearch (VPC)
│       ├── web-service.ts            # App Runner (L2 alpha) + ECR + VPC Connector
│       ├── worker-service.ts         # ECS Fargate + ECR + Auto Scaling
│       └── cdn.ts                    # CloudFront + Route53 + ACM + WAF
├── cdk.json
├── package.json
└── tsconfig.json
```

### CDK コンテキストパラメータ

全パラメータは `config.ts` にデフォルト値があり、`npx cdk deploy` のみで動作する。
環境固有の値（ドメイン名等）を永続化したい場合は `infra/cdk.context.json` に記述する。
`cdk.context.json` は `.gitignore` 対象のため、環境ごとに安全に管理できる。

| パラメータ         | 型                             | デフォルト                                         | 説明                                                         |
| ------------------ | ------------------------------ | -------------------------------------------------- | ------------------------------------------------------------ |
| `scale`            | `small` \| `medium` \| `large` | `small`                                            | デプロイ規模（リソースサイズを一括制御）                     |
| `dbEngine`         | `rds` \| `aurora`              | スケール依存（small=`rds`, medium/large=`aurora`） | DB エンジン                                                  |
| `enableOpenSearch` | boolean                        | `true`                                             | `false` → PostgreSQL 全文検索フォールバック                  |
| `enableCloudFront` | boolean                        | `true`                                             | `false` → App Runner に直接アクセス                          |
| `enableWaf`        | boolean                        | `false`                                            | WAF on CloudFront（~$6/月追加）                              |
| `domainName`       | string                         | なし                                               | カスタムドメイン（未設定時は CloudFront デフォルトドメイン） |
| `hostedZoneId`     | string                         | なし                                               | Route53 Hosted Zone ID（`domainName` 設定時に必要）          |
| `hostedZoneName`   | string                         | なし                                               | Route53 Hosted Zone 名（`domainName` 設定時に必要）          |
| `region`           | string                         | `ap-northeast-1`                                   | デプロイ先リージョン                                         |

パラメータの指定方法（優先度順）:

1. CLI `-c` フラグ（一時的なオーバーライド）
2. `infra/cdk.context.json`（環境固有、gitignore 対象）
3. `config.ts` のデフォルト値

```jsonc
// infra/cdk.context.json の例
{
  "domainName": "demo.example.com",
  "hostedZoneId": "Z0123456789",
  "hostedZoneName": "example.com",
}
```

#### スケール別デフォルト値

| パラメータ              | small               | medium               | large                            |
| ----------------------- | ------------------- | -------------------- | -------------------------------- |
| Web vCPU / Memory       | 0.25 / 512 MB       | 0.5 / 1 GB           | 1 / 2 GB                         |
| Web min / max instances | 1 / 2               | 1 / 5                | 2 / 10                           |
| Worker vCPU / Memory    | 0.25 / 512 MB       | 0.5 / 1 GB           | 1 / 2 GB                         |
| Worker min / max tasks  | 1 / 1               | 1 / 2                | 2 / 5                            |
| DB                      | RDS db.t4g.micro    | Aurora 0.5-2 ACU     | Aurora 2-8 ACU, multi-AZ         |
| OpenSearch              | t3.small × 1, 10 GB | m6g.large × 1, 50 GB | m6g.xlarge × 2, 100 GB, multi-AZ |
| NAT                     | t4g.nano Instance   | NAT Gateway          | NAT Gateway                      |
| DB Pool (web / worker)  | 5 / 3               | 10 / 5               | 20 / 10                          |

#### 使用例

```bash
# 最小構成（デフォルト値のみ、カスタムドメインなし）
npx cdk deploy

# CLI で一時的にオーバーライド
npx cdk deploy -c scale=medium -c enableWaf=true
```

## Dockerfile

プロジェクトルートに単一マルチターゲット Dockerfile:

```bash
docker build --target web -t kukan-web .
docker build --target worker -t kukan-worker .
```

## DB マイグレーション

Worker 起動時にマイグレーションを自動実行:

1. Worker プロセス起動 → `runMigrations()` を呼び出し（SQS ポーリング開始前）
2. Drizzle の advisory lock により複数タスクの同時実行でも安全
3. マイグレーション完了後に SQS ポーリングとヘルスチェックサーバーを開始

## デプロイ手順

Docker イメージのビルド・ECR プッシュは CDK が `DockerImageAsset` で自動実行するため、
手動での `docker build` / `docker push` は不要。

```bash
# 1. AWS SSO ログイン
aws sso login

# 2. CDK Bootstrap（初回のみ）
cd infra && npx cdk bootstrap

# 3. CDK デプロイ（Docker ビルド + ECR プッシュ + 全リソース作成）
npx cdk deploy

# カスタムドメイン付きの場合:
npx cdk deploy \
  -c domainName=demo.example.com \
  -c hostedZoneId=Z0123456789 \
  -c hostedZoneName=example.com

# 4. 確認
# - CloudFront ドメイン（またはカスタムドメイン）でアクセス
# - データセット作成 → ファイルアップロード → パイプライン完了
# - 検索動作確認
```

## 関連ファイル

- CDK: `infra/` ディレクトリ全体
- Dockerfile: `Dockerfile`, `.dockerignore`
- Worker ヘルスチェック: `apps/worker/src/index.ts`
- SQS アダプター: `packages/adapters/queue/src/sqs.ts`
- ADR: `docs/adr/018-app-runner-plus-fargate.md`
