# Phase 4: AWS デプロイ & CDK 基盤

## 概要

デモ環境を外部に公開するための AWS デプロイ基盤。
OSS 公開時にユーザーが `cdk deploy` で自環境を構築できることを目指す。

## アーキテクチャ

```
Route53 ─→ ALB (ACM/HTTPS) ─→ ECS Fargate "web" (:3000)
                                         │
                              ┌─── Public Subnets ────┐
                              │  ALB                   │
                              │  ECS Fargate "web"     │
                              │  ECS Fargate "worker"  │
                              └────────────────────────┘
                              ┌─── Isolated Subnets ──┐
                              │  Aurora/RDS PostgreSQL │
                              │  OpenSearch 3.x        │
                              └────────────────────────┘

S3 ← presigned URL (ブラウザ直接) / Worker 読み書き
SQS ← API enqueue → Worker consume (ロングポーリング)
```

### コンポーネント

| コンポーネント | サービス                              | 理由                                                   |
| -------------- | ------------------------------------- | ------------------------------------------------------ |
| Web            | ECS Fargate + ALB                     | L2 コンストラクト、SG で IP 制限、カスタムドメイン対応 |
| Worker         | ECS Fargate Service                   | SQS ロングポーリング、タイムアウトなし                 |
| DB             | RDS PostgreSQL / Aurora Serverless v2 | CDK パラメータで切替                                   |
| 検索           | OpenSearch (VPC)                      | kuromoji プラグイン、PostgreSQL フォールバック可       |
| ストレージ     | S3                                    | presigned URL でブラウザ直接アップロード               |
| キュー         | SQS + DLQ                             | 無料枠内、ElasticMQ と同一 API                         |
| WAF            | ALB WAF (オプション)                  | マネージドルール、IP 制限は SG で対応                  |

## VPC 設計

```
VPC (10.0.0.0/16)
├── Public Subnet A (AZ-a)  ← ALB / ECS Fargate (web, worker)
├── Public Subnet B (AZ-c)  ← ALB / ECS Fargate (web, worker)
├── Isolated Subnet A (AZ-a) ← RDS / OpenSearch
└── Isolated Subnet B (AZ-c) ← RDS (multi-AZ)
```

- ECS タスクは Public サブネットで `assignPublicIp: true`（NAT 不要）
- DB / OpenSearch は Isolated サブネット（インターネットアクセスなし）
- S3 Gateway VPC Endpoint（無料）で S3 トラフィックを最適化

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

### Small（デモ / PoC）: ~$64/月

| サービス           | スペック            | 月額 USD |
| ------------------ | ------------------- | -------- |
| ECS Fargate Web    | 0.25 vCPU / 0.5 GB  | ~$9      |
| ALB                | 常時稼働            | ~$18     |
| ECS Fargate Worker | 0.25 vCPU / 1 GB    | ~$13     |
| RDS PostgreSQL     | db.t4g.micro        | ~$15     |
| OpenSearch         | t3.small.search × 1 | ~$27     |
| S3 + SQS           | 最小                | ~$2      |
| Secrets Manager    | 2 secrets           | ~$1      |

OpenSearch なし（SEARCH_TYPE=postgres）: ~$37/月
WAF 追加（enableWaf=true）: +~$9/月
IP 制限は ALB SG で対応（追加コストなし）

### Medium（単一自治体）: ~$250/月

### Large（都道府県 / 国レベル）: ~$1,000/月

## CDK スタック構成

単一スタック構成。全リソースを ap-northeast-1 にデプロイ。

| スタック   | リージョン     | 用途       |
| ---------- | -------------- | ---------- |
| KukanStack | ap-northeast-1 | 全リソース |

```
infra/
├── bin/app.ts                        # エントリポイント
├── lib/
│   ├── kukan-stack.ts                # メインスタック
│   ├── config.ts                     # スケール別設定
│   └── constructs/
│       ├── network.ts                # VPC, SG, S3 Endpoint
│       ├── database.ts               # RDS / Aurora + Secrets Manager
│       ├── storage.ts                # S3 Bucket (CORS, lifecycle)
│       ├── queue.ts                  # SQS + DLQ
│       ├── search.ts                 # OpenSearch (VPC)
│       ├── web-service.ts            # ECS Fargate + ALB
│       ├── worker-service.ts         # ECS Fargate + Auto Scaling
│       └── waf.ts                    # WAF WebACL (オプション)
├── cdk.json
├── package.json
└── tsconfig.json
```

### CDK コンテキストパラメータ

全パラメータは `config.ts` にデフォルト値があり、`npx cdk deploy` のみで動作する。
環境固有の値（ドメイン名等）を永続化したい場合は `infra/cdk.context.json` に記述する。
`cdk.context.json` は `.gitignore` 対象のため、環境ごとに安全に管理できる。

| パラメータ         | 型                             | デフォルト                                         | 説明                                                   |
| ------------------ | ------------------------------ | -------------------------------------------------- | ------------------------------------------------------ |
| `scale`            | `small` \| `medium` \| `large` | `small`                                            | デプロイ規模（リソースサイズを一括制御）               |
| `dbEngine`         | `rds` \| `aurora`              | スケール依存（small=`rds`, medium/large=`aurora`） | DB エンジン                                            |
| `enableOpenSearch` | boolean                        | `true`                                             | `false` → PostgreSQL 全文検索フォールバック            |
| `enableWaf`        | boolean                        | `!allowedIpRanges`                                 | WAF on ALB（マネージドルール、~$9/月追加）             |
| `domainName`       | string                         | なし                                               | カスタムドメイン（未設定時は ALB デフォルトドメイン）  |
| `hostedZoneId`     | string                         | なし                                               | Route53 Hosted Zone ID（`domainName` 設定時に必要）    |
| `hostedZoneName`   | string                         | なし                                               | Route53 Hosted Zone 名（`domainName` 設定時に必要）    |
| `allowedIpRanges`  | string[]                       | なし                                               | IP 制限（ALB SG、IPv4 CIDR + IPv6 プレフィックス対応） |
| `bucketName`       | string                         | `kukan-resources`                                  | S3 バケット名                                          |

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
  "allowedIpRanges": ["203.0.113.0/24", "2001:db8::/32"],
}
```

#### スケール別デフォルト値

| パラメータ              | small               | medium               | large                            |
| ----------------------- | ------------------- | -------------------- | -------------------------------- |
| Web vCPU / Memory       | 0.25 / 512 MB       | 0.5 / 1 GB           | 1 / 2 GB                         |
| Web min / max instances | 1 / 2               | 1 / 5                | 2 / 10                           |
| Worker vCPU / Memory    | 0.25 / 1 GB         | 0.5 / 1 GB           | 1 / 2 GB                         |
| Worker min / max tasks  | 1 / 2               | 1 / 2                | 2 / 5                            |
| DB                      | RDS db.t4g.micro    | Aurora 0.5-2 ACU     | Aurora 2-8 ACU, multi-AZ         |
| OpenSearch              | t3.small × 1, 10 GB | m6g.large × 1, 50 GB | m6g.xlarge × 2, 100 GB, multi-AZ |
| DB Pool (web / worker)  | 5 / 3               | 10 / 5               | 20 / 10                          |

#### 使用例

```bash
# 最小構成（WAF 自動有効、カスタムドメインなし）
npx cdk deploy

# IP 制限あり（ALB SG で制御、WAF 自動無効）
npx cdk deploy -c allowedIpRanges='["203.0.113.0/24"]'

# IP 制限 + WAF 二重防御
npx cdk deploy -c allowedIpRanges='["203.0.113.0/24"]' -c enableWaf=true

# WAF 明示的に無効化
npx cdk deploy -c enableWaf=false
```

## セキュリティ

### IP 制限（ALB Security Group）

`allowedIpRanges` 設定時、ALB の Security Group で IP アドレスを制限。
IPv4 CIDR と IPv6 プレフィックスの両方に対応。追加コストなし。

- Web タスク SG: ALB からの 3000 番ポートのみ許可（直接アクセス不可）
- Worker タスク SG: インバウンドなし

### WAF（オプション）

WAF は `allowedIpRanges` の有無で自動制御される。
IP 制限は ALB SG で行うため、WAF はマネージドルール（SQLi/XSS 保護等）が必要な場合のみ有効化。

| `allowedIpRanges` | `enableWaf` 指定 | WAF 動作                               |
| ----------------- | ---------------- | -------------------------------------- |
| なし              | なし             | **自動有効**（セキュアバイデフォルト） |
| なし              | `true`           | 有効                                   |
| なし              | `false`          | 無効（明示的にオプトアウト）           |
| あり              | なし             | **自動無効**（SG で保護済み）          |
| あり              | `true`           | 有効（SG + WAF 二重防御）              |
| あり              | `false`          | 無効                                   |

マネージドルールグループ（3 つ）:

| ルールグループ                        | 内容                                               | 費用  |
| ------------------------------------- | -------------------------------------------------- | ----- |
| AWSManagedRulesCommonRuleSet          | SQLi, XSS, SSRF, パストラバーサル等                | $1/月 |
| AWSManagedRulesKnownBadInputsRuleSet  | Log4Shell, Spring4Shell 等の既知の脆弱性攻撃       | $1/月 |
| AWSManagedRulesAmazonIpReputationList | AWS 脅威インテリジェンスによる悪意ある IP ブロック | $1/月 |

WAF 費用合計: WebACL $5/月 + ルール $3/月 + リクエスト $0.60/百万 = **~$9/月**

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

# 4. 確認
# - ALB ドメイン（またはカスタムドメイン）でアクセス
# - データセット作成 → ファイルアップロード → パイプライン完了
# - 検索動作確認
```

## 関連ファイル

- CDK: `infra/` ディレクトリ全体
- Dockerfile: `Dockerfile`, `.dockerignore`
- Worker ヘルスチェック: `apps/worker/src/index.ts`
- Web ヘルスチェック: `apps/web/src/app/api/health/route.ts`
- SQS アダプター: `packages/adapters/queue/src/sqs.ts`
- ADR: `docs/adr/020-ecs-fargate-alb-migration.md`

## オンプレミス Docker Compose デプロイ

AWS を使わないオンプレミス・閉域網（LGWAN 等）向けの本番デプロイ。
同一の Dockerfile を共有し、Docker Compose profiles で開発用と本番用を切り替える。

### アーキテクチャ

```
Client ─→ Caddy (:80/:443) ─→ web (:3000)
                                    │
                         ┌──────────┤
                         ▼          ▼
                     postgres   opensearch
                         ▲          ▲
                         │          │
                      worker ──→ minio / elasticmq
```

### プロファイル設計

| コマンド                              | 起動サービス                             |
| ------------------------------------- | ---------------------------------------- |
| `docker compose up -d`                | インフラのみ（開発用、現状通り）         |
| `docker compose --profile prod up -d` | フルスタック本番（web + worker + caddy） |

### 設定ファイル

| ファイル            | 用途                                                 |
| ------------------- | ---------------------------------------------------- |
| `compose.yml`       | 統一 Compose ファイル（profiles で切替）             |
| `docker/Caddyfile`  | リバースプロキシ設定（TLS, IP 制限等をカスタマイズ） |
| `.env.prod`         | 本番環境変数オーバーライド（gitignore 対象）         |
| `.env.prod.example` | 本番環境変数テンプレート                             |

### 環境変数

本番 Compose では `.env`（開発デフォルト）+ `.env.prod`（本番オーバーライド）を `--env-file` で重ね合わせ。
`.env.prod` には Docker 内部エンドポイント（`http://minio:9000` 等）が含まれ、`.env` の `localhost` 値を上書きする。

ユーザーが設定すべき値:

| 変数                 | 必須 | 説明                                                                                 |
| -------------------- | ---- | ------------------------------------------------------------------------------------ |
| `BETTER_AUTH_URL`    | Yes  | 公開 URL（例: `https://catalog.example.com`）                                        |
| `BETTER_AUTH_SECRET` | Yes  | 認証セッション秘密鍵（32 文字以上）                                                  |
| `LOG_LEVEL`          | No   | pino ログレベル（`trace`/`debug`/`info`/`warn`/`error`/`fatal`、デフォルト: `info`） |

その他すべてのオプションは `.env.prod.example` を参照。

### セキュリティ考慮事項

- **TLS 終端**: Caddyfile で設定。Let's Encrypt 自動証明書またはカスタム証明書に対応。
- **IP 制限**: Caddyfile の `remote_ip` マッチャーで設定可能。
- **ポート公開**: インフラサービス（postgres:5432, minio:9000 等）はホストに公開される。本番環境ではファイアウォールでアクセスを制限するか、compose.yml の `ports:` を `expose:` に変更する。
- **パスワード管理**: `.env.prod` は `.gitignore` 対象。デフォルトパスワードから必ず変更すること。
- **DB SSL**: `POSTGRES_SSLMODE=require` で SSL 接続を有効化。AWS（RDS/Aurora PG16+）は SSL 必須のため CDK で自動設定。オンプレは postgres:16-alpine が SSL 非対応のためデフォルト `disable`。
- **ORIGIN_VERIFY_SECRET**: オンプレミスでは不要（CloudFront を経由しないため）。未設定時は middleware がスキップする。

### デプロイ手順

```bash
# 1. 環境変数を設定
cp .env.prod.example .env.prod
# .env.prod を編集

# 2. ビルド＆起動
docker compose --env-file .env --env-file .env.prod --profile prod up -d --build

# 3. 動作確認
curl http://localhost/api/health
```

### 関連ファイル

- Dockerfile: `Dockerfile`（マルチターゲット、変更不要）
- Compose: `compose.yml`
- Caddy: `docker/Caddyfile`
- 環境変数テンプレート: `.env.prod.example`
