# KUKAN

**Knowledge Unified Katalog And Network**

A modern, full-stack TypeScript alternative to CKAN.
みんなが使えるデータカタログ — CKANモダンクローン。

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
docker compose up -d
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

| Variable                          | Default                 | Description                                                  |
| --------------------------------- | ----------------------- | ------------------------------------------------------------ |
| `POSTGRES_HOST`                   | `localhost`             | PostgreSQL hostname                                          |
| `POSTGRES_PORT`                   | `5432`                  | PostgreSQL port                                              |
| `POSTGRES_DB`                     | `kukan`                 | PostgreSQL database name                                     |
| `POSTGRES_USER`                   | `kukan`                 | PostgreSQL user                                              |
| `POSTGRES_PASSWORD`               | `kukan`                 | PostgreSQL password                                          |
| `POSTGRES_SSLMODE`                | `disable`               | `require` for RDS/Aurora, `disable` for local                |
| `BETTER_AUTH_SECRET`              | _(must set)_            | Auth session secret (min 32 chars)                           |
| `BETTER_AUTH_URL`                 | `http://localhost:3000` | Auth callback base URL                                       |
| `S3_ENDPOINT`                     | _(omit for AWS)_        | S3-compatible endpoint (MinIO: `http://localhost:9000`)      |
| `S3_BUCKET`                       | `kukan-dev`             | S3 bucket name                                               |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | _(omit for IAM role)_   | S3 credentials (MinIO: `minioadmin`)                         |
| `SEARCH_TYPE`                     | `opensearch`            | `opensearch` or `postgres` (fallback)                        |
| `OPENSEARCH_URL`                  | `http://localhost:9200` | OpenSearch endpoint                                          |
| `SQS_ENDPOINT`                    | _(omit for AWS)_        | SQS-compatible endpoint (ElasticMQ: `http://localhost:9324`) |
| `SQS_QUEUE_URL`                   | _(required)_            | SQS queue URL                                                |
| `SQS_REGION`                      | _(omit for local)_      | AWS region for SQS                                           |
| `AI_TYPE`                         | `none`                  | `none` / `bedrock` / `openai` / `ollama`                     |
| `WEB_DB_POOL_MAX`                 | `5`                     | DB connection pool size (web)                                |
| `WORKER_DB_POOL_MAX`              | `3`                     | DB connection pool size (worker)                             |

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

- AWS CLI configured / AWS CLI 設定済み
- Docker (CDK builds images automatically / CDK が自動ビルド)

### Deploy / デプロイ手順

```bash
# 1. Ensure AWS credentials are configured / AWS 認証情報を設定
# (e.g. aws configure, aws sso login, or environment variables)

# 2. CDK Bootstrap (first time only / 初回のみ)
cd infra && npx cdk bootstrap

# 3. Deploy (Docker build + ECR push + all resources / 全リソース作成)
npx cdk deploy
```

Deploys a `small` configuration by default:
パラメータなしで `small` 規模のデフォルト構成がデプロイされる:

| Component | Service                                |
| --------- | -------------------------------------- |
| Web       | ECS Fargate + ALB (0.25 vCPU / 512 MB) |
| Worker    | ECS Fargate (0.25 vCPU / 512 MB)       |
| DB        | RDS PostgreSQL db.t4g.micro            |
| Search    | OpenSearch t3.small.search             |
| WAF       | 3 managed rule groups (optional)       |

### CDK parameters / CDK パラメータ一覧

| Parameter          | Type                           | Default            | Description                                                 |
| ------------------ | ------------------------------ | ------------------ | ----------------------------------------------------------- |
| `scale`            | `small` \| `medium` \| `large` | `small`            | Resource sizing preset                                      |
| `dbEngine`         | `rds` \| `aurora`              | Scale-dependent    | DB engine (`small`=RDS, `medium`+=Aurora)                   |
| `enableOpenSearch` | boolean                        | `true`             | `false` → PostgreSQL full-text fallback                     |
| `enableWaf`        | boolean                        | `!allowedIpRanges` | WAF on ALB (~$9/mo). Auto-enabled when no `allowedIpRanges` |
| `domainName`       | string                         | —                  | Custom domain (ALB default domain when unset)               |
| `hostedZoneId`     | string                         | —                  | Route53 Hosted Zone ID (required with `domainName`)         |
| `hostedZoneName`   | string                         | —                  | Route53 Hosted Zone name (required with `domainName`)       |
| `allowedIpRanges`  | string[]                       | —                  | IP allowlist via ALB Security Group (CIDR, IPv4+IPv6)       |
| `bucketName`       | string                         | `kukan-resources`  | S3 bucket name                                              |

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
npx cdk deploy -c scale=medium -c enableWaf=true
```

See [docs/specs/phase4-deploy.md](docs/specs/phase4-deploy.md) for full details.
詳細は上記リンクを参照。

## On-Premise Deployment / オンプレミスデプロイ

Deploy KUKAN with Docker Compose for on-premise or air-gapped environments (e.g. LGWAN).
Docker Compose でオンプレミス・閉域網環境にデプロイ。

### Prerequisites / 前提条件

- Docker Engine 24+ with Compose V2
- 4 GB+ RAM (8 GB recommended / 推奨)

### Deploy / デプロイ手順

```bash
# 1. Configure environment / 環境変数を設定
cp .env.example .env        # Set BETTER_AUTH_SECRET / BETTER_AUTH_SECRET を設定
cp .env.prod.example .env.prod  # Set BETTER_AUTH_URL etc. / BETTER_AUTH_URL 等を設定

# 2. Build and start all services / ビルド＆全サービス起動
docker compose --env-file .env --env-file .env.prod --profile prod up -d --build

# 3. Verify / 動作確認
curl http://localhost/api/health
```

### Services / サービス構成

| Service    | Description                   | External Port |
| ---------- | ----------------------------- | ------------- |
| Caddy      | Reverse proxy (HTTP/HTTPS)    | 80, 443       |
| Web        | Next.js application           | —             |
| Worker     | Pipeline worker (SQS polling) | —             |
| PostgreSQL | Database                      | 5432          |
| MinIO      | S3-compatible storage         | 9000          |
| ElasticMQ  | SQS-compatible queue          | 9324          |
| OpenSearch | Full-text search (kuromoji)   | 9200          |

### Environment / 環境変数

`.env` (dev defaults) + `.env.prod` (prod overrides) are loaded via `--env-file` stacking.
`.env`（開発デフォルト）+ `.env.prod`（本番オーバーライド）を `--env-file` で重ね合わせ。

`.env.prod` contains Docker internal endpoints (e.g. `http://minio:9000`) that override
the `localhost` values in `.env`. See [.env.prod.example](.env.prod.example) for all options.

| Variable             | Required | Description                                     |
| -------------------- | -------- | ----------------------------------------------- |
| `BETTER_AUTH_URL`    | Yes      | Public URL (e.g. `https://catalog.example.com`) |
| `BETTER_AUTH_SECRET` | Yes      | Auth session secret (min 32 chars)              |

### TLS / HTTPS

Edit `docker/Caddyfile`. See the file for examples including:
`docker/Caddyfile` を編集。以下の設定例がファイル内にあります:

- Automatic HTTPS with Let's Encrypt / Let's Encrypt 自動証明書
- Custom certificates / カスタム証明書（庁内 CA 等）
- IP restriction / IP 制限
- Virtual hosts / 仮想ホスト

### Update / アップデート

```bash
git pull
docker compose --env-file .env --env-file .env.prod --profile prod up -d --build
```

### Logs / ログ確認

```bash
docker compose logs -f web worker
```

## Documentation / ドキュメント

- [Design Document / 設計書](docs/design-v4.md)
- [AWS Deployment Spec / デプロイ仕様](docs/specs/phase4-deploy.md)
- [ADR (Architecture Decision Records / 設計判断記録)](docs/adr/)

## License / ライセンス

TBD
