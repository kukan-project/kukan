# KUKAN

**Knowledge Unified Katalog And Network**

みんなが使えるデータカタログ — CKANモダンクローン。
A modern, full-stack TypeScript alternative to CKAN.

Cloud-native, yet deployable on-premises and in air-gapped networks (e.g. LGWAN).
クラウドからオンプレミス・閉域網（LGWAN等）まで対応するハイブリッドデプロイ設計。

## Prerequisites / 必要環境

- Node.js 24+
- pnpm 9+
- Docker / Docker Compose

## Getting Started / 開発環境セットアップ

### 1. Install dependencies / 依存関係インストール

```bash
pnpm install
```

### 2. Start infrastructure / インフラ起動

```bash
docker compose -f docker/compose.yml up -d
```

| Service               | Port                  | Description             |
| --------------------- | --------------------- | ----------------------- |
| PostgreSQL 16         | 5432                  | Database                |
| MinIO                 | 9000 / 9001 (Console) | S3-compatible storage   |
| ElasticMQ             | 9324                  | SQS-compatible queue    |
| OpenSearch 3          | 9200                  | Full-text search engine |
| OpenSearch Dashboards | 5601                  | Search management UI    |

### 3. Environment variables / 環境変数

```bash
cp .env.example .env
```

Default values connect to the Docker Compose services.
Only `BETTER_AUTH_SECRET` needs to be changed:

デフォルト値で Docker Compose のサービスに接続できる。
`BETTER_AUTH_SECRET` のみ変更を推奨:

```bash
# .env
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
```

#### Environment variable reference / 環境変数一覧

| Variable                          | Default                                         | Description / 説明                                                                    |
| --------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| `DATABASE_URL`                    | `postgresql://kukan:kukan@localhost:5432/kukan` | PostgreSQL connection string / 接続文字列                                             |
| `BETTER_AUTH_SECRET`              | _(must set / 要設定)_                           | Auth session secret (min 32 chars) / 認証セッション秘密鍵                             |
| `BETTER_AUTH_URL`                 | `http://localhost:3000`                         | Auth callback base URL / 認証コールバック URL                                         |
| `S3_ENDPOINT`                     | _(omit for AWS / AWS時は省略)_                  | S3-compatible endpoint (MinIO: `http://localhost:9000`) / S3 互換エンドポイント       |
| `S3_BUCKET`                       | `kukan-dev`                                     | S3 bucket name / バケット名                                                           |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | _(omit for IAM role / IAM時は省略)_             | S3 credentials (MinIO: `minioadmin`) / S3 認証情報                                    |
| `SEARCH_TYPE`                     | `opensearch`                                    | `opensearch` or `postgres` (fallback) / 検索エンジン種別                              |
| `OPENSEARCH_URL`                  | `http://localhost:9200`                         | OpenSearch endpoint / エンドポイント                                                  |
| `SQS_ENDPOINT`                    | _(omit for AWS / AWS時は省略)_                  | SQS-compatible endpoint (ElasticMQ: `http://localhost:9324`) / SQS 互換エンドポイント |
| `SQS_QUEUE_URL`                   | _(required / 必須)_                             | SQS queue URL / キュー URL                                                            |
| `SQS_REGION`                      | _(omit for local / ローカル時は省略)_           | AWS region for SQS / SQS リージョン                                                   |
| `AI_TYPE`                         | `none`                                          | `none` / `bedrock` / `openai` / `ollama` — AI adapter type / AI アダプター種別        |
| `DB_POOL_MAX`                     | `5`                                             | DB connection pool size (web) / DB 接続プールサイズ（Web）                            |
| `WORKER_DB_POOL_MAX`              | `3`                                             | DB connection pool size (worker) / DB 接続プールサイズ（Worker）                      |

See [.env.example](.env.example) for all options including pool tuning.
プールチューニング等の全オプションは上記ファイルを参照。

### 4. Start dev server / 開発サーバー起動

```bash
pnpm dev
```

- Web: http://localhost:3000
- Worker: Starts automatically via SQS polling / SQS ポーリングで自動起動

## Common Commands / よく使うコマンド

```bash
pnpm dev          # Start all dev servers / 全開発サーバー起動
pnpm build        # Build all packages / 全パッケージビルド
pnpm test         # Run all tests / 全テスト実行
pnpm lint         # ESLint
pnpm typecheck    # TypeScript type check / 型チェック
pnpm format       # Prettier
pnpm db:generate  # Generate Drizzle migration / マイグレーション生成
pnpm db:migrate   # Run migrations / マイグレーション実行
```

## AWS Deployment / AWS デプロイ

### Prerequisites / 前提条件

- AWS CLI + SSO configured / SSO 設定済み
- Docker (CDK builds images automatically / CDK が自動ビルド)

### Deploy / デプロイ手順

```bash
# 1. AWS SSO login / ログイン
aws sso login

# 2. CDK Bootstrap (first time only / 初回のみ)
cd infra && npx cdk bootstrap

# 3. Deploy (Docker build + ECR push + all resources / 全リソース作成)
npx cdk deploy --all
```

Deploys a `small` configuration by default:
パラメータなしで `small` 規模のデフォルト構成がデプロイされる:

| Component | Service                          |
| --------- | -------------------------------- |
| Web       | App Runner (0.25 vCPU / 512 MB)  |
| Worker    | ECS Fargate (0.25 vCPU / 512 MB) |
| DB        | RDS PostgreSQL db.t4g.micro      |
| Search    | OpenSearch t3.small.search       |
| CDN       | CloudFront (default domain)      |
| WAF       | 3 managed rule groups            |
| NAT       | t4g.nano Instance                |

### CDK parameters / CDK パラメータ一覧

| Parameter          | Type                           | Default                                    | Description / 説明                                                                           |
| ------------------ | ------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `scale`            | `small` \| `medium` \| `large` | `small`                                    | Resource sizing preset / デプロイ規模                                                        |
| `dbEngine`         | `rds` \| `aurora`              | Scale-dependent / スケール依存             | DB engine / DB エンジン（`small`=RDS, `medium`+=Aurora）                                     |
| `enableOpenSearch` | boolean                        | `true`                                     | `false` → PostgreSQL full-text fallback / 全文検索フォールバック                             |
| `enableCloudFront` | boolean                        | `true`                                     | `false` → direct App Runner access / App Runner 直接アクセス                                 |
| `enableWaf`        | boolean                        | Secure by default / セキュアバイデフォルト | WAF on CloudFront (~$9/mo). Auto-enabled when no `allowedIpRanges` / IP 制限なし時に自動有効 |
| `domainName`       | string                         | —                                          | Custom domain / カスタムドメイン（未設定時は CloudFront デフォルト）                         |
| `hostedZoneId`     | string                         | —                                          | Route53 Hosted Zone ID（`domainName` 設定時に必要）                                          |
| `hostedZoneName`   | string                         | —                                          | Route53 Hosted Zone name / ゾーン名（`domainName` 設定時に必要）                             |
| `allowedIpRanges`  | string[]                       | —                                          | IP allowlist via CloudFront Function / IP 制限（CIDR, IPv4+IPv6）                            |
| `bucketName`       | string                         | `kukan-resources`                          | S3 bucket name / バケット名                                                                  |
| `region`           | string                         | `ap-northeast-1`                           | Deploy region / デプロイ先リージョン                                                         |

### Environment-specific settings / 環境固有の設定

Store environment-specific values in `infra/cdk.context.json` (gitignored):
環境固有値は `infra/cdk.context.json`（gitignore 対象）に記述:

```jsonc
// infra/cdk.context.json
{
  "domainName": "demo.example.com",
  "hostedZoneId": "Z0123456789",
  "hostedZoneName": "example.com",
  "allowedIpRanges": ["203.0.113.0/24"],
}
```

Or override temporarily via CLI / CLI で一時オーバーライド:

```bash
npx cdk deploy --all -c scale=medium -c enableWaf=true
```

See [docs/specs/phase4-deploy.md](docs/specs/phase4-deploy.md) for full details.
詳細は上記リンクを参照。

## Documentation / ドキュメント

- [Design Document / 設計書](docs/design-v4.md)
- [AWS Deployment Spec / デプロイ仕様](docs/specs/phase4-deploy.md)
- [ADR (Architecture Decision Records / 設計判断記録)](docs/adr/)

## License / ライセンス

TBD
