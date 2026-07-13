# KUKAN

**Knowledge Unified Katalog And Network**

[![GitHub Release](https://img.shields.io/github/v/release/kukan-project/kukan)](https://github.com/kukan-project/kukan/releases)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

> [!WARNING]
> **Beta (July 2026)** — KUKAN is under active development. APIs, schemas, and configurations may change without notice.
>
> **ベータ版（2026年7月）** — KUKAN は開発中です。API、スキーマ、設定は予告なく変更される場合があります。

> [!NOTE]
> **Versioning** — KUKAN follows [Semantic Versioning](https://semver.org/) (`vX.Y.Z` tags; `1.0.0` is reserved
> for GA). Use the latest [release](https://github.com/kukan-project/kukan/releases) for trial deployments, and check
> the [CHANGELOG](CHANGELOG.md) for breaking changes before upgrading. After upgrading, a search index rebuild
> (`POST /api/v1/admin/reindex-metadata`) may be required due to mapping or schema changes.
>
> **バージョニング** — KUKAN は[セマンティックバージョニング](https://semver.org/lang/ja/)に従います（`vX.Y.Z`
> タグ。`1.0.0` は正式リリース時に付与）。試用の際は最新の[リリース](https://github.com/kukan-project/kukan/releases)を
> ご利用ください。アップグレード前に [CHANGELOG](CHANGELOG.md) で破壊的変更を確認してください。更新後、
> マッピングやスキーマの変更により検索インデックスの再構築（`POST /api/v1/admin/reindex-metadata`）が
> 必要になる場合があります。

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

| Service               | Port                  | Description                             |
| --------------------- | --------------------- | --------------------------------------- |
| PostgreSQL 16         | 5432                  | Database                                |
| MinIO                 | 9000 / 9001 (Console) | S3-compatible storage                   |
| ElasticMQ             | 9324                  | SQS-compatible queue                    |
| OpenSearch 3          | 9200                  | Full-text search engine                 |
| OpenSearch Dashboards | 5601                  | Search management UI                    |
| Ollama                | 11435                 | Local LLM (embeddings + AI suggestions) |

#### Ollama GPU acceleration (optional) / Ollama GPU アクセラレーション（任意）

The bundled `ollama` service runs on **CPU by default**. To use a GPU:

同梱の `ollama` サービスは既定で **CPU 実行**。GPU を使う場合:

- **Linux / Windows (WSL2) with an NVIDIA GPU** — install the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html), then copy the git-ignored sample override and recreate the container:
  NVIDIA GPU の Linux / Windows (WSL2) — NVIDIA Container Toolkit を入れ、git-ignore されたサンプル override をコピーしてコンテナを再作成:

  ```bash
  cp compose.override.gpu.sample.yml compose.override.yml
  docker compose up -d --force-recreate ollama
  docker compose exec ollama ollama ps   # PROCESSOR should read "100% GPU"
  ```

  `docker compose` auto-merges `compose.override.yml`; delete it to fall back to CPU.
  `docker compose` は `compose.override.yml` を自動マージする。削除すれば CPU に戻る。

- **macOS** — Docker Desktop cannot pass the Apple GPU into Linux containers, so the containerized `ollama` stays CPU-only. For Metal GPU acceleration, run [Ollama natively](https://ollama.com/download) and point KUKAN at it instead:
  macOS — Docker Desktop は Apple GPU をコンテナに渡せず、コンテナ内 `ollama` は CPU のみ。Metal で高速化するには Ollama をネイティブ実行し、KUKAN からそれを参照:

  ```bash
  brew install ollama && ollama serve        # native, uses the Metal GPU (:11434)
  # .env — point at the native instance instead of the compose service (:11435)
  OLLAMA_URL=http://localhost:11434
  ```

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

| Variable                          | Default                 | Description                                                    |
| --------------------------------- | ----------------------- | -------------------------------------------------------------- |
| `POSTGRES_HOST`                   | `localhost`             | PostgreSQL hostname                                            |
| `POSTGRES_PORT`                   | `5432`                  | PostgreSQL port                                                |
| `POSTGRES_DB`                     | `kukan`                 | PostgreSQL database name                                       |
| `POSTGRES_USER`                   | `kukan`                 | PostgreSQL user                                                |
| `POSTGRES_PASSWORD`               | `kukan`                 | PostgreSQL password                                            |
| `POSTGRES_SSLMODE`                | `disable`               | `require` for RDS/Aurora, `disable` for local                  |
| `BETTER_AUTH_SECRET`              | _(must set)_            | Auth session secret (min 32 chars)                             |
| `BETTER_AUTH_URL`                 | `http://localhost:3000` | Auth callback base URL                                         |
| `S3_ENDPOINT`                     | _(omit for AWS)_        | S3-compatible endpoint (MinIO: `http://localhost:9000`)        |
| `S3_BUCKET`                       | `kukan-dev`             | S3 bucket name                                                 |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | _(omit for IAM role)_   | S3 credentials (MinIO: `minioadmin`)                           |
| `SEARCH_TYPE`                     | `opensearch`            | `opensearch` or `postgres` (fallback)                          |
| `OPENSEARCH_URL`                  | `http://localhost:9200` | OpenSearch endpoint                                            |
| `SQS_ENDPOINT`                    | _(omit for AWS)_        | SQS-compatible endpoint (ElasticMQ: `http://localhost:9324`)   |
| `SQS_QUEUE_URL`                   | _(required)_            | SQS queue URL                                                  |
| `SQS_REGION`                      | _(omit for local)_      | AWS region for SQS                                             |
| `AI_TYPE`                         | `none`                  | `none` / `bedrock` / `openai` / `ollama`                       |
| `WEB_DB_POOL_MAX`                 | `5`                     | DB connection pool size (web)                                  |
| `WORKER_DB_POOL_MAX`              | `3`                     | DB connection pool size (worker)                               |
| `LOG_LEVEL`                       | `info`                  | Pino log level (`trace`/`debug`/`info`/`warn`/`error`/`fatal`) |

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

Two deploy modes / デプロイは2モード:

- **Standalone** — `npx cdk deploy -c env=<name> '<Name>/**'` (manual, per-environment / 手動・環境単位)
- **Pipeline** — push-triggered CDK Pipelines (see below / 下記参照)

### Standalone deploy / Standalone デプロイ手順

```bash
# 1. Ensure AWS credentials are configured / AWS 認証情報を設定
# (e.g. aws configure, aws sso login, or environment variables)

# 2. Define your environments (first time only / 初回のみ環境を定義)
cp infra/config/environments.example.ts infra/config/environments.ts
# Edit environments.ts / environments.ts を編集

# 3. CDK Bootstrap (per account/region, first time only / 初回のみ)
#    Custom domain/WAF envs also need us-east-1 (GlobalStack) / 独自ドメイン/WAF は us-east-1 も
cd infra && npx cdk bootstrap aws://<account-id>/ap-northeast-1 aws://<account-id>/us-east-1

# 4. Deploy a named environment (Docker build + ECR push + all resources)
#    The stacks are nested in a Stage (e.g. Dev/KukanStack), so select the
#    Stage with a glob — `--all` only matches top-level stacks and finds none.
#    スタックは Stage 配下（例: Dev/KukanStack）にネストされるため Stage を
#    glob で指定する（--all はトップレベルのみ対象で何も見つからない）。
#    <Name> = pascal-cased env name (dev → Dev) / <Name> は env 名の PascalCase
npx cdk deploy -c env=dev 'Dev/**'
```

A `dev` environment in the example uses a `small` configuration:
example の `dev` は `small` 規模:

| Component | Service                                |
| --------- | -------------------------------------- |
| Web       | ECS Fargate + ALB (0.25 vCPU / 512 MB) |
| Worker    | ECS Fargate (0.25 vCPU / 512 MB)       |
| DB        | RDS PostgreSQL db.t4g.micro            |
| Search    | OpenSearch t3.small.search             |
| WAF       | 3 managed rule groups (optional)       |

### Environment config / 環境設定

Environments (dev / prd, etc.) are defined in `infra/config/environments.ts` (copy from
`environments.example.ts`; forks commit it, upstream does not). Each entry is an `EnvironmentConfig`:
環境は `infra/config/environments.ts`（example をコピー。フォークがコミット、upstream はコミットしない）で定義。各エントリのフィールド:

| Field               | Type                           | Default            | Description                                                                                      |
| ------------------- | ------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------ |
| `account`           | string                         | **required**       | Target account ID (misdeployment guard: CDK refuses if your credentials are for another account) |
| `region`            | string                         | `ap-northeast-1`   | Target region                                                                                    |
| `scale`             | `small` \| `medium` \| `large` | `small`            | Resource sizing preset                                                                           |
| `dbEngine`          | `rds` \| `aurora`              | Scale-dependent    | DB engine                                                                                        |
| `enableOpenSearch`  | boolean                        | `true`             | `false` → PostgreSQL full-text fallback                                                          |
| `enableWaf`         | boolean                        | `!allowedIpRanges` | WAF on CloudFront (~$9/mo)                                                                       |
| `allowedIpRanges`   | string[]                       | —                  | IP allowlist via CloudFront Function (CIDR, IPv4+IPv6)                                           |
| `domainName`        | string                         | —                  | Custom domain (CloudFront default domain when unset)                                             |
| `hostedZoneId/Name` | string                         | —                  | Route53 Hosted Zone (required with `domainName`)                                                 |
| `certificateArn`    | string                         | —                  | Pre-created us-east-1 ACM cert ARN (for pipeline mode)                                           |
| `webAclArn`         | string                         | —                  | Pre-created us-east-1 WAF WebACL ARN (for pipeline mode)                                         |
| `bucketName`        | string                         | auto               | S3 bucket name (auto-generated, globally unique, when unset)                                     |
| `enableGa4DataApi`  | boolean                        | `false`            | GA4 analytics dashboard                                                                          |
| `githubRepo`        | string                         | —                  | CodeConnections source repo (`owner/repo`)                                                       |
| `deployBranch`      | string                         | `main`             | Branch that deploys this env (pipeline mode)                                                     |
| `overrides`         | deep-partial                   | —                  | Fine-grained overrides of the scale preset                                                       |

Precedence: CLI `-c` > env entry > scale defaults. Override ad hoc:
優先順位: `-c` > env エントリ > スケール既定。一時上書き:

```bash
npx cdk deploy -c env=dev -c scale=medium 'Dev/**'
```

See [docs/specs/phase4-deploy.md](docs/specs/phase4-deploy.md) for full details.
詳細は上記リンクを参照。

### CI/CD (CDK Pipelines + CodeConnections) / 自動デプロイ

Deployment is automated with CDK Pipelines (AWS CodePipeline), triggered by branch pushes via a CodeConnections (GitHub App) source. The pipeline self-mutates and deploys each environment as a CDK Stage.
デプロイは CDK Pipelines（AWS CodePipeline）で自動化し、CodeConnections（GitHub App）ソース経由でブランチ push を起点に起動します。パイプラインは自己変異し、各環境を CDK Stage としてデプロイします。

```bash
# 1. Prepare your environment definitions (first time only) / 環境定義を用意（初回のみ）
cp infra/config/environments.example.ts infra/config/environments.ts
# Edit environments.ts (githubRepo / deployBranch / scale / domain, etc.) / environments.ts を編集

# 2. Create a CodeConnections connection in the AWS console (approve the GitHub App),
#    set its ARN as connectionArn in environments.ts
#    AWS コンソールで CodeConnections 接続を作成し、ARN を environments.ts の connectionArn に設定

# 3. Bootstrap first (prerequisite for cdk deploy; include us-east-1 for the GlobalStack)
#    先に bootstrap（cdk deploy の前提。GlobalStack 用に us-east-1 も含める）
cd infra && npx cdk bootstrap aws://<account-id>/ap-northeast-1 aws://<account-id>/us-east-1

# 4. For custom domain / WAF only: create the us-east-1 cert/WAF once (standalone), then
#    set certificateArn / webAclArn in environments.ts (CDK Pipelines can't do cross-region)
#    独自ドメイン/WAF を使う場合のみ: us-east-1 の cert/WAF を一度 standalone で作成し ARN を設定
npx cdk deploy -c env=prd Prd/KukanGlobalStack

# 5. Commit environments.ts + cdk.context.json so CodeBuild synth is hermetic (forks commit; upstream does not)
#    cdk synth resolves context lookups (AZs, CloudFront prefix list) into cdk.context.json
npx cdk synth >/dev/null
git add infra/config/environments.ts infra/cdk.context.json && git commit -m "chore: env config"

# 6. Deploy the pipeline stack once / 初回のみパイプラインスタックを手動デプロイ
npx cdk deploy KukanPipeline

# 7. After that, pushes to each env's deployBranch deploy automatically (self-mutating)
#    以降は各 env の deployBranch への push で自動デプロイ（自己変異）

# To deploy/diff a pipeline-managed env manually (hotfix), use its qualified path
# WITHOUT -c env — the -c env synthesis path differs and would change physical names,
# forcing resource replacement. / pipeline 管理環境を手動操作する場合は pipeline 修飾パスで
# 指定し -c env は付けない（-c env 合成だと物理名が変わり置換が発生する）。
npx cdk deploy 'KukanPipeline/Prd/KukanStack'
```

> [!IMPORTANT]
> CDK Pipelines is incompatible with cross-region references, so a custom domain / WAF
> (us-east-1) requires supplying `certificateArn` / `webAclArn` (step 2). Otherwise set `enableWaf: false`.
> CDK Pipelines は cross-region 参照と非互換のため、独自ドメイン/WAF（us-east-1）は手順2で ARN を供給するか `enableWaf: false` にしてください。

Design: [ADR-030 (CDK Pipelines)](docs/adr/jp/030-cdk-pipelines-deploy.md) / [ADR-031 (multi-env Stage)](docs/adr/jp/031-multi-environment-deploy.md).
詳細・設計判断は ADR-030 / ADR-031 を参照。

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

Check the [release notes](https://github.com/kukan-project/kukan/releases) for breaking changes and migration steps before upgrading.
アップグレード前にリリースノートで破壊的変更と移行手順を確認してください。

```bash
git fetch --tags
git checkout vX.Y.Z   # latest release / 最新リリース
docker compose --env-file .env --env-file .env.prod --profile prod up -d --build
```

### Logs / ログ確認

```bash
docker compose logs -f web worker
```

## Documentation / ドキュメント

- [Design Document / 設計書](docs/design-v4.md)
- [AWS Deployment Spec / デプロイ仕様](docs/specs/phase4-deploy.md)
- ADR (Architecture Decision Records / 設計判断記録): [日本語 (正本)](docs/adr/jp/) | [English](docs/adr/en/)

## License / ライセンス

[AGPL-3.0-only](LICENSE)
