# Phase 4: AWS デプロイ & CDK 基盤

## 概要

デモ環境を外部に公開するための AWS デプロイ基盤。
OSS 公開時にユーザーが `cdk deploy` で自環境を構築できることを目指す。

## アーキテクチャ

```
Route53 ─→ CloudFront (WAF + Cache) ─→ [VPC Origin] ─→ ALB (HTTP) ─→ ECS Fargate "web" (:3000)

                              ┌─── Public Subnets ────┐
                              │  ECS Fargate "web"     │
                              │  ECS Fargate "worker"  │
                              └────────────────────────┘
                              ┌─── Isolated Subnets ──┐
                              │  ALB (internal)        │
                              │  Aurora/RDS PostgreSQL │
                              │  OpenSearch 3.x        │
                              └────────────────────────┘

S3 ← presigned URL (ブラウザ直接) / Worker 読み書き
SQS ← API enqueue → Worker consume (ロングポーリング)
```

### コンポーネント

| コンポーネント | サービス                              | 理由                                                            |
| -------------- | ------------------------------------- | --------------------------------------------------------------- |
| Web            | ECS Fargate + ALB + CloudFront        | L2 コンストラクト、CF Function で IP 制限、カスタムドメイン対応 |
| Worker         | ECS Fargate Service                   | SQS ロングポーリング、タイムアウトなし                          |
| DB             | RDS PostgreSQL / Aurora Serverless v2 | CDK パラメータで切替                                            |
| 検索           | OpenSearch (VPC)                      | kuromoji プラグイン、PostgreSQL フォールバック可                |
| ストレージ     | S3                                    | presigned URL でブラウザ直接アップロード                        |
| キュー         | SQS + DLQ                             | 無料枠内、ElasticMQ と同一 API                                  |
| WAF            | CloudFront WAF (オプション)           | マネージドルール（ADR-027）                                     |

## VPC 設計

```
VPC (10.0.0.0/16)
├── Public Subnet A (AZ-a)  ← ECS Fargate (web, worker)
├── Public Subnet B (AZ-c)  ← ECS Fargate (web, worker)
├── Isolated Subnet A (AZ-a) ← ALB (internal) / RDS / OpenSearch
└── Isolated Subnet B (AZ-c) ← ALB (internal) / RDS (multi-AZ)
```

- ECS タスクは Public サブネットで `assignPublicIp: true`（NAT 不要）
- ALB / DB / OpenSearch は Isolated サブネット（インターネットアクセスなし）
- CloudFront VPC Origin が ALB に直接接続（パブリック IP 不要）
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

### Small（デモ / PoC）: ~$120/月

※ ap-northeast-1（東京）リージョン基準。税別。

| サービス            | スペック             | 月額 USD |
| ------------------- | -------------------- | -------- |
| ECS Fargate Web     | 0.25 vCPU / 0.5 GB   | ~$9      |
| ECS Fargate Worker  | 0.25 vCPU / 1 GB     | ~$13     |
| ALB                 | 常時稼働（internal） | ~$18     |
| RDS PostgreSQL      | db.t4g.micro + 20 GB | ~$22     |
| OpenSearch          | t3.small.search × 1  | ~$43     |
| CloudFront          | VPC origin + 転送    | ~$2      |
| パブリック IPv4     | ECS タスク × 2       | ~$8      |
| S3 + SQS            | 最小                 | ~$2      |
| Secrets Manager     | 1 secret             | ~$1      |
| ECR + CloudWatch 等 | 最小                 | ~$2      |

OpenSearch なし（SEARCH_TYPE=postgres）: ~$77/月
WAF 追加（enableWaf=true）: +~$9/月
IP 制限は CloudFront Function で対応（追加コストなし）
消費税（日本リージョン 10%）: 別途加算

### Medium（単一自治体）: ~$266/月

| サービス                         | スペック                    | 月額 USD |
| -------------------------------- | --------------------------- | -------- |
| ECS Fargate Web                  | 0.5 vCPU / 1 GB × 1         | ~$23     |
| ECS Fargate Worker               | 0.5 vCPU / 1 GB × 1         | ~$23     |
| ALB                              | 常時稼働（internal）        | ~$18     |
| Aurora Serverless v2             | 0.5–2 ACU, Single-AZ        | ~$57     |
| OpenSearch                       | m6g.large.search × 1 (50GB) | ~$127    |
| CloudFront                       | VPC origin + 転送           | ~$3      |
| パブリック IPv4                  | ECS タスク × 2              | ~$8      |
| S3 + SQS + Secrets + ECR + CW 等 | —                           | ~$7      |

### Large（都道府県 / 国レベル）: ~$1,191/月

| サービス                         | スペック                          | 月額 USD |
| -------------------------------- | --------------------------------- | -------- |
| ECS Fargate Web                  | 1 vCPU / 2 GB × 2                 | ~$90     |
| ECS Fargate Worker               | 1 vCPU / 2 GB × 2                 | ~$90     |
| ALB                              | 常時稼働（internal）              | ~$18     |
| Aurora Serverless v2             | 2–8 ACU, Multi-AZ (Writer+Reader) | ~$444    |
| OpenSearch                       | m6g.xlarge.search × 2 (200GB)     | ~$510    |
| CloudFront                       | VPC origin + 転送                 | ~$5      |
| パブリック IPv4                  | ECS タスク × 4                    | ~$15     |
| WAF（オプション）                | マネージドルール                  | ~$9      |
| S3 + SQS + Secrets + ECR + CW 等 | —                                 | ~$10     |

## CDK スタック構成

2スタック構成。CloudFront 用のグローバルリソース（ACM 証明書・WAF WebACL）は us-east-1 にデプロイ。

| スタック         | リージョン     | 用途                                     |
| ---------------- | -------------- | ---------------------------------------- |
| KukanGlobalStack | us-east-1      | ACM 証明書 + WAF WebACL（CloudFront 用） |
| KukanStack       | ap-northeast-1 | VPC, ECS, RDS, CloudFront 等             |

KukanGlobalStack はドメイン名指定時または WAF 有効時に自動作成される。

```
infra/
├── bin/app.ts                        # エントリポイント（standalone / pipeline 分岐）
├── config/
│   ├── environments.example.ts       # 環境定義テンプレート（commit）
│   └── environments.ts               # 環境定義（フォークがコミット。example をコピーして編集）
├── lib/
│   ├── kukan-stage.ts                # KukanStage（Global+Main を内包、env 境界）
│   ├── pipeline-stack.ts             # CDK Pipelines（CodeConnections、env ごと）
│   ├── kukan-stack.ts                # メインスタック
│   ├── global-stack.ts               # グローバルスタック（us-east-1）
│   ├── config.ts                     # 設定解決（EnvironmentConfig / loadConfig）
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

### 環境設定（environments.ts）

環境（dev / prd 等）は `infra/config/environments.ts` で定義する（ADR-031）。
`environments.example.ts` をコピーして編集する。`environments.ts` は **gitignore せず、フォークがコミットする**（upstream はコミットしない）。これにより CodeBuild の synth が checkout の中身だけで完結する（ADR-031）。

**各エントリ = 1 環境**。pipeline モードでは env ごとに 1 パイプラインが作られ、それぞれの `deployBranch` でデプロイされる。example は dev / prd の 2 つを定義しているため、**単一環境で運用する場合は不要なエントリ（例: `dev`）を削除する**（残すと 2 環境分デプロイされる）。なお `environments.ts` から env を削除しても、既にデプロイ済みのスタックは自動削除されない（手動で `cdk destroy` が必要）。
デプロイ時は `-c env=<name>` でどの環境かを選ぶ。同一アカウント・別アカウントのどちらも
このファイルの記述だけで切り替わる（`account` 省略＝同一、指定＝別アカウント）。

```bash
cp infra/config/environments.example.ts infra/config/environments.ts
# environments.ts を編集
```

各 env のフィールド（すべて任意。未設定はスケール既定／組込み既定にフォールバック）:

| フィールド         | 型                             | デフォルト         | 説明                                                                                       |
| ------------------ | ------------------------------ | ------------------ | ------------------------------------------------------------------------------------------ |
| `account`          | string                         | **必須**           | 対象アカウント ID。誤デプロイ防止のため必須（認証情報のアカウントと不一致なら CDK が拒否） |
| `region`           | string                         | `ap-northeast-1`   | 対象リージョン                                                                             |
| `scale`            | `small` \| `medium` \| `large` | `small`            | デプロイ規模（リソースサイズを一括制御）                                                   |
| `dbEngine`         | `rds` \| `aurora`              | スケール依存       | DB エンジン                                                                                |
| `enableOpenSearch` | boolean                        | `true`             | `false` → PostgreSQL 全文検索フォールバック                                                |
| `enableWaf`        | boolean                        | `!allowedIpRanges` | WAF on CloudFront（マネージドルール、~$9/月追加）                                          |
| `allowedIpRanges`  | string[]                       | なし               | IP 制限（CloudFront Function、IPv4 CIDR + IPv6 対応）                                      |
| `domainName`       | string                         | なし               | カスタムドメイン（未設定時は CloudFront デフォルトドメイン）                               |
| `hostedZoneId`     | string                         | なし               | Route53 Hosted Zone ID（`domainName` 設定時に必要）                                        |
| `hostedZoneName`   | string                         | なし               | Route53 Hosted Zone 名（`domainName` 設定時に必要）                                        |
| `certificateArn`   | string                         | なし               | 事前作成した us-east-1 ACM 証明書 ARN（pipeline モード用、ADR-030）                        |
| `webAclArn`        | string                         | なし               | 事前作成した us-east-1 WAF WebACL ARN（同上）                                              |
| `bucketName`       | string                         | 自動命名           | S3 バケット名（未設定でグローバル一意な自動命名、ADR-031）                                 |
| `enableGa4DataApi` | boolean                        | `false`            | GA4 アクセス統計ダッシュボード                                                             |
| `bedrock`          | object \| `false`              | 有効（Titan v2）   | Bedrock 埋め込みによるセマンティック検索（ADR-034）。`false` で無効化                      |
| `githubRepo`       | string                         | なし               | CodeConnections ソースリポジトリ（`owner/repo`、ADR-030）                                  |
| `deployBranch`     | string                         | `main`             | この env を pipeline でデプロイするブランチ                                                |
| `overrides`        | deep-partial                   | なし               | スケール preset の個別パラメータ上書き（後述）                                             |

優先順位: CLI `-c` フラグ > `environments.ts` の env エントリ > スケール既定（`config.ts`）> 組込み既定。

```ts
// infra/config/environments.ts の例
export const connectionArn = 'arn:aws:codeconnections:ap-northeast-1:...:connection/...'

export const environments = {
  dev: {
    scale: 'small',
    enableWaf: false,
    githubRepo: 'kukan-project/demo.kukan.dev',
    deployBranch: 'develop',
  },
  prd: {
    scale: 'large',
    githubRepo: 'kukan-project/demo.kukan.dev',
    deployBranch: 'main',
    domainName: 'demo.example.com',
    hostedZoneId: 'Z0123456789',
    hostedZoneName: 'example.com',
    allowedIpRanges: ['203.0.113.0/24', '2001:db8::/32'],
    certificateArn: 'arn:aws:acm:us-east-1:...:certificate/...', // pipeline 用に一度作成（後述）
  },
} satisfies Record<string, EnvironmentConfig>
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

#### overrides（preset の個別上書き）

`scale` で大枠を選び、個別パラメータだけ env エントリで微調整できる（ADR-031）。

```ts
prd: {
  scale: 'large',
  overrides: { web: { maxSize: 20 }, opensearch: { instanceCount: 3, indexReplicas: 2 } },
}
```

#### 使用例（standalone デプロイ）

```bash
# dev 環境をデプロイ
npx cdk deploy -c env=dev --all

# prd 環境をデプロイ
npx cdk deploy -c env=prd --all

# 一時的に scale を上書き（env エントリより優先）
npx cdk deploy -c env=dev -c scale=medium --all
```

## セキュリティ

### IP 制限（CloudFront Function）

`allowedIpRanges` 設定時、CloudFront Function（Viewer Request）で IP アドレスを制限（ADR-027）。
IPv4 CIDR と IPv6 プレフィックスの両方に対応。追加コストなし。

- ALB: internal（CloudFront VPC Origin 経由のみ、マネージドプレフィックスリストで制限）
- Web タスク SG: ALB からの 3000 番ポートのみ許可（直接アクセス不可）
- Worker タスク SG: インバウンドなし

### WAF（オプション）

WAF は `allowedIpRanges` の有無で自動制御される（ADR-027）。
IP 制限は CloudFront Function で行うため、WAF はマネージドルール（SQLi/XSS 保護等）が必要な場合のみ有効化。
WAF は CLOUDFRONT スコープで us-east-1（KukanGlobalStack）にデプロイされる。

> [!NOTE]
> pipeline モードでは us-east-1 リソース（WAF / ACM 証明書）を作成できない（CDK Pipelines は
> cross-region 参照と非互換、ADR-030）。WAF を使う env は一度 standalone で作成し、`webAclArn` を
> `environments.ts` に設定する。WAF が不要なら `enableWaf: false`。詳細は後述の CI/CD 節を参照。

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

デプロイには2つのモードがある。Docker イメージのビルド・ECR プッシュは CDK が
`DockerImageAsset` で自動実行するため、手動の `docker build` / `docker push` は不要。

| モード            | コマンド                             | 用途                                         |
| ----------------- | ------------------------------------ | -------------------------------------------- |
| **A. Standalone** | `npx cdk deploy -c env=<name> --all` | 初回セットアップ・ローカルからの手動デプロイ |
| **B. Pipeline**   | push（CDK Pipelines が自動実行）     | 継続的デプロイ（ADR-030）                    |

スタック名は env でプレフィックスされる（例 `Dev/KukanStack` → CloudFormation スタック名 `Dev-KukanStack`）。

> [!IMPORTANT]
> **2つのモードは同じ CloudFormation スタックを対象にする**（どちらも `KukanStage` 経由で
> `Prd-KukanStack` 等を生成）。よって衝突はしないが、**pipeline が source of truth**（git の
> コミット内容をデプロイ）であることに注意:
>
> - standalone は**手元の作業ツリー**をデプロイするため、未コミットの変更は**次の push で pipeline
>   が git の状態に巻き戻す**。standalone での変更は必ず commit/push して git と一致させる
> - pipeline 実行中に同じスタックを standalone で叩くと CloudFormation が `UPDATE_IN_PROGRESS`
>   で弾く（**同時実行しない**）
> - ローカルの `cdk.context.json` がコミット済みと異なると synth 結果が変わりリソースが揺り戻る
>   （churn）。ローカルでもコミット済み context を使う
>
> standalone は **初回 bootstrap / us-east-1 の cert・WAF 作成 / 緊急ホットフィックス**に限定し、
> 恒久的な変更手段にしない。

### A. Standalone デプロイ（手動・環境単位）

```bash
# 1. AWS ログイン
aws sso login

# 2. 環境定義を用意（初回のみ）
cp infra/config/environments.example.ts infra/config/environments.ts
# environments.ts を編集（scale, domain, allowedIpRanges 等）

# 3. CDK Bootstrap（アカウント/リージョンごとに初回のみ）
#    カスタムドメイン/WAF を使う env は GlobalStack が us-east-1 のため us-east-1 も bootstrap する
cd infra && npx cdk bootstrap aws://<account-id>/ap-northeast-1 aws://<account-id>/us-east-1

# 4. デプロイ（env を指定。Docker ビルド + ECR プッシュ + 全リソース作成）
npx cdk deploy -c env=dev --all

# 5. 初期ユーザー作成（初回のみ。DB 接続情報は環境変数から取得）
pnpm db:create-user --email admin@example.com --name admin --password <password> --role sysadmin
# 一般ユーザーも作成可能（--role 省略でデフォルト 'user'）
pnpm db:create-user --email user@example.com --name taro --password <password>

# 6. 確認
# - CloudFront ドメイン（またはカスタムドメイン）でアクセス
# - データセット作成 → ファイルアップロード → パイプライン完了 → 検索動作確認
```

カスタムドメイン/WAF を使う env では、us-east-1 の global stack（ACM 証明書 / WAF）も
同時に作成される（standalone は cross-region 参照に対応）。

## CI/CD 自動デプロイ（CDK Pipelines + CodeConnections）

### B. Pipeline デプロイ

`deployBranch` への push を起点に、CDK Pipelines（AWS CodePipeline + CodeBuild）が
自動デプロイする（ADR-030）。CodeConnections（GitHub App）をソースに起動し、パイプラインは
自己変異（定義変更時に自身を更新）し、各環境を CDK Stage（ADR-031）としてデプロイする。

- パイプライン定義: `infra/lib/pipeline-stack.ts`（env ごとに1パイプライン）
- 環境境界: `infra/lib/kukan-stage.ts`（`KukanStage` が Global+Main を内包）
- 環境定義: `infra/config/environments.ts`
- 認証: CodeConnections（長期トークン不要）

### CodeConnections 接続の作成（コンソール操作）

GitHub App の認可はブラウザでの操作が必須のため、AWS コンソールから作成する
（CLI/CDK で作成しても `PENDING` 状態になり、結局ブラウザでの認可が必要）。
接続はアカウント単位で一度だけ作れば、複数パイプラインで使い回せる。

1. AWS コンソールで **CodeBuild** を開く → 左メニュー下部の **Settings → Connections**
   （「Settings → Connections」は CodeBuild / CodePipeline 等「Developer Tools」共通の設定。Developer Tools のトップは見つけにくいので CodeBuild 経由が分かりやすい）
2. **Create connection** をクリック
3. プロバイダで **GitHub** を選択 → 接続名（例 `kukan-github`。AWS 側の識別ラベルで GitHub には表示されない）を入力 → **Connect to GitHub**
4. **Install a new app** をクリック → GitHub 側で **AWS Connector for GitHub** をインストール・認可。
   このとき **「Only select repositories」を選び、デプロイ対象のリポジトリのみ**に絞る
   （`All repositories` は付与しすぎ。最小権限の原則）
5. AWS に戻り **Connect** → 接続ステータスが **Available** になる
6. 接続の詳細ページで **ARN をコピー**（`arn:aws:codeconnections:<region>:<account>:connection/...`）
7. その ARN を `infra/config/environments.ts` の **トップレベル `connectionArn`**（env エントリ内ではなく、全 env 共通の export）に設定

> [!NOTE]
> 旧名称は「AWS CodeStar Connections」。コンソールやドキュメントで両表記が混在する場合がある（同じ機能）。

#### 接続の使い回し（スコープ）

接続は**作成した IAM ユーザー個人ではなく、アカウント（＋リージョン）のリソース**であり、
GitHub App の認可も接続単位（IAM ユーザー単位ではない）。再利用範囲は以下のとおり。

| 範囲                                             | 使い回し | 補足                                                                        |
| ------------------------------------------------ | :------: | --------------------------------------------------------------------------- |
| 同一アカウント内の別 IAM ユーザー/ロール         |    ✅    | `codeconnections:UseConnection` 権限があれば誰でも利用可                    |
| 同一アカウント内の複数パイプライン（dev/prd 等） |    ✅    | 同じ `connectionArn` を使い回す                                             |
| 別の AWS アカウント                              |    ❌    | 接続はアカウント専有。リソース共有（RAM）非対応。アカウントごとに作成が必要 |

重要: 接続を使うのは**パイプライン（source アクション）**であり、**パイプラインが動くアカウントにだけ**
接続があればよい。デプロイ先（Stage）が別アカウントでも、そこへは cross-account ロールで配るため
デプロイ先アカウントに接続は不要。本構成（`KukanPipelineStack` を1アカウントに置き、env ごとに
パイプラインを作る）では、**接続は1つ**作って `connectionArn` を全 env で共有すれば足りる
（パイプライン自体を各アカウントに分割する場合のみ、アカウントごとに接続が必要）。

### セットアップ手順（初回のみ手動）

```bash
# 1. 環境定義を用意（初回のみ）
cp infra/config/environments.example.ts infra/config/environments.ts
#    environments.ts を編集（env ごとに githubRepo / deployBranch / scale / domain 等。
#    connectionArn は手順2で取得した値を設定）

# 2. CodeConnections 接続を作成（上記「コンソール操作」を参照）
#    → Connection ARN を environments.ts の connectionArn に設定
#    ※ GitHub App 承認はコンソール/ブラウザでの一度きりの手動操作（IaC 化不可）

# 3. Bootstrap（cdk deploy の前提。各アカウント・各リージョンで初回のみ）
#    GlobalStack は us-east-1 のため us-east-1 も必須。ap-northeast-1 と併せて bootstrap する
cd infra && npx cdk bootstrap aws://<account-id>/ap-northeast-1 aws://<account-id>/us-east-1
#    クロスアカウント運用時は、パイプラインアカウントを信頼する形でデプロイ先アカウントも bootstrap

# 4. カスタムドメイン/WAF を使う env は、us-east-1 の cert/WAF を一度だけ standalone で作成
npx cdk deploy -c env=prd Prd/KukanGlobalStack
#    出力された ACM 証明書 ARN / WAF WebACL ARN を
#    environments.ts の certificateArn / webAclArn に設定
#    （CDK Pipelines は cross-region 参照と非互換のため ARN を文字列で渡す）

# 5. environments.ts と cdk.context.json をコミット（フォークがコミット。CodeBuild の synth が読む）
#    cdk synth で context lookup（AZ・CloudFront プレフィックスリスト）を解決して cdk.context.json を生成
npx cdk synth >/dev/null
git add infra/config/environments.ts infra/cdk.context.json && git commit -m "chore: env config"

# 6. パイプラインスタックを初回手動デプロイ
npx cdk deploy KukanPipeline

# 7. 以降は対象ブランチへの push で自動デプロイ（パイプライン定義の変更も自己変異で反映）
```

承認ゲート（例: prd は `ManualApprovalStep` で手動承認、dev は自動）はパイプライン定義で設定する。

> [!IMPORTANT]
> **CDK Pipelines は cross-region 参照と非互換。** カスタムドメイン/WAF（us-east-1）を使う env は、
> 手順4で cert/WAF を一度作成し、ARN を `certificateArn` / `webAclArn` に設定すること。
> 未設定のまま us-east-1 リソースが必要な env を pipeline に含めると、synth が
> 「`KukanGlobalStack` を standalone で作成して ARN を設定せよ」という明示エラーで停止する。
> WAF が不要なら `enableWaf: false`。

> [!NOTE]
> **synth に必要なファイル**（CodeBuild が git ソースから synth するため）。どちらも gitignore せず、
> upstream はコミットしない（フォークがコミット）:
>
> - **`environments.ts`（env 定義）= pipeline synth に必須**。フォークが必ずコミットする（upstream は
>   `environments.example.ts` のみ）。connection ARN / account ID が載るが秘密情報ではない
>   （`BETTER_AUTH_SECRET` 等は CDK 生成の Secrets）。
> - **`cdk.context.json`（AZ・CloudFront プレフィックスリストの lookup キャッシュ、`PrefixList.fromLookup`）
>   = 再現性のためフォークがコミット推奨**。未コミットでも synth ロールの lookup ロール
>   （`cdk-*-lookup-role-*`、`sts:AssumeRole`）でライブ解決されるが、その分非決定的。
>
> 秘匿したいフォークのみ、これらを gitignore して別途供給する運用も可。

> [!IMPORTANT]
> CodeConnections の GitHub App 承認はコンソールでの一度きりの手動操作で、完全な IaC 化はできない（Connection ARN のみコードで参照）。

## 関連ファイル

- CDK: `infra/` ディレクトリ全体
- 環境定義: `infra/config/environments.ts`（フォークがコミット）, `infra/config/environments.example.ts`
- CI/CD: `infra/lib/pipeline-stack.ts`, `infra/lib/kukan-stage.ts`
- Dockerfile: `Dockerfile`, `.dockerignore`
- Worker ヘルスチェック: `apps/worker/src/index.ts`
- Web ヘルスチェック: `apps/web/src/app/api/health/route.ts`
- SQS アダプター: `packages/adapters/queue/src/sqs.ts`
- ADR: `docs/adr/jp/020-ecs-fargate-alb-migration.md`, `docs/adr/jp/030-cdk-pipelines-deploy.md`, `docs/adr/jp/031-multi-environment-deploy.md`

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
- **ALB 直アクセス防止**: AWS では CloudFront VPC Origin により ALB は internal（パブリック IP なし）。オンプレミスでは Caddy がリバースプロキシとして前面に立つ。

### デプロイ手順

```bash
# 1. 環境変数を設定
cp .env.prod.example .env.prod
# .env.prod を編集

# 2. ビルド＆起動
docker compose --env-file .env --env-file .env.prod --profile prod up -d --build

# 3. 初期ユーザー作成（初回のみ）
pnpm db:create-user --email admin@example.com --name admin --password <password> --role sysadmin

# 4. 動作確認
curl http://localhost/api/health
```

### 関連ファイル

- Dockerfile: `Dockerfile`（マルチターゲット、変更不要）
- Compose: `compose.yml`
- Caddy: `docker/Caddyfile`
- 環境変数テンプレート: `.env.prod.example`

## アクセス統計（GA4 連携）

インターネット公開環境向けのアクセス統計機能。GA4 を計測基盤とし、KUKAN 自体には計測ロジックを持たない。
LGWAN 等の閉域網では `brandConfig.gaMeasurementId` 未設定（デフォルト）により自動的に無効化される。

設計判断の詳細: `docs/adr/jp/024-ga4-access-analytics.md`

### 4a: gtag.js 条件埋め込み

`brandConfig.gaMeasurementId`（`brand-config.ts`）で制御。`null`（デフォルト）の場合は gtag.js をロードしない。フォーク側が Measurement ID を直接記述する（ADR-023 の方針に準拠、環境変数は介さない）。

**計測対象:**

| 計測項目             | 方式                          | 追加コード                       |
| -------------------- | ----------------------------- | -------------------------------- |
| ページビュー         | GA4 自動計測                  | なし                             |
| ファイルダウンロード | カスタムイベント              | `DownloadButton` の `onClick`    |
| サイト内検索         | Enhanced Measurement 自動検出 | なし（`?q=` パラメータから自動） |

**実装対象ファイル:**

| ファイル                                      | 変更内容                                         |
| --------------------------------------------- | ------------------------------------------------ |
| `apps/web/src/types/brand.ts`                 | `gaMeasurementId?: string \| null` 追加          |
| `apps/web/src/brand/brand-config.ts`          | `gaMeasurementId: null` をデフォルト値として追加 |
| `apps/web/src/app/layout.tsx`                 | `<Script>` で gtag.js 条件埋め込み               |
| `apps/web/src/components/download-button.tsx` | `onClick` でカスタムイベント送信                 |

**ダウンロードイベント:**

```typescript
gtag('event', 'file_download', {
  file_name: displayFilename,
  link_url: href,
  dataset_name: datasetNameOrId,
  resource_id: resourceId,
  format: format,
})
```

### 4b: 管理画面の統計ダッシュボード

GA4 Data API からデータを取得し、管理画面（sysadmin 限定）に統計ランキングを表示する。

**環境変数:**

| 環境変数           | 用途                                   | 未設定時                   |
| ------------------ | -------------------------------------- | -------------------------- |
| `GA4_PROPERTY_ID`  | GA4 プロパティ ID                      | 統計ページに設定案内を表示 |
| `GA4_CLIENT_EMAIL` | サービスアカウントのメールアドレス     | 同上                       |
| `GA4_PRIVATE_KEY`  | サービスアカウントの秘密鍵（PEM 形式） | 同上                       |

**統計ページ:**

| ランキング             | 説明                                        |
| ---------------------- | ------------------------------------------- |
| データセット閲覧数     | `/dataset/{name}` のページビュー            |
| リソース閲覧数         | `/dataset/.../resource/{id}` のページビュー |
| リソースダウンロード数 | `file_download` カスタムイベント            |
| 検索キーワード         | Enhanced Measurement のサイト内検索         |

**UI 機能:**

- 期間指定: プリセット（7 日 / 30 日 / 90 日 / 1 年）+ カレンダー自由選択
- ランキング: ページネーション付き
- 未設定時: メニュー表示あり、ページ内に GA4 セットアップ手順の案内を表示

**データ取得:**

- GA4 Data API をリアルタイム呼び出し + lru-cache（TTL 1 時間）
- `@google-analytics/data` Node.js クライアント使用
- サービスアカウント認証

**実装対象ファイル:**

| ファイル                                                     | 内容                                        |
| ------------------------------------------------------------ | ------------------------------------------- |
| `packages/api/src/services/analytics-service.ts`             | GA4 Data API 呼び出し + キャッシュ          |
| `packages/api/src/routes/admin.ts`                           | `GET /admin/analytics/*` エンドポイント追加 |
| `apps/web/src/app/dashboard/admin/analytics/page.tsx`        | 統計ダッシュボードページ                    |
| `apps/web/src/components/analytics/analytics-ranking.tsx`    | ランキング表示コンポーネント                |
| `apps/web/src/components/analytics/analytics-date-range.tsx` | 期間選択コンポーネント                      |

### 関連ファイル（アクセス統計）

- ADR: `docs/adr/jp/024-ga4-access-analytics.md`
- ダウンロードボタン: `apps/web/src/components/download-button.tsx`
- ブランド設定: `apps/web/src/brand/brand-config.ts`（ADR-023）
