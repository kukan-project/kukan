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
npx cdk deploy
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
| NAT       | t4g.nano Instance                |

### Environment-specific settings / 環境固有の設定

Store environment-specific values in `infra/cdk.context.json` (gitignored):
環境固有値は `infra/cdk.context.json`（gitignore 対象）に記述:

```jsonc
// infra/cdk.context.json
{
  "domainName": "demo.example.com",
  "hostedZoneId": "Z0123456789",
  "hostedZoneName": "example.com",
}
```

Or override temporarily via CLI / CLI で一時オーバーライド:

```bash
npx cdk deploy -c scale=medium -c enableWaf=true
```

See [docs/specs/phase4-deploy.md](docs/specs/phase4-deploy.md) for all parameters.
全パラメータの詳細は上記リンクを参照。

## Documentation / ドキュメント

- [Design Document / 設計書](docs/design-v4.md)
- [AWS Deployment Spec / デプロイ仕様](docs/specs/phase4-deploy.md)
- [ADR (Architecture Decision Records / 設計判断記録)](docs/adr/)

## License / ライセンス

TBD
