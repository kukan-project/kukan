# Phase 4: AWS デプロイ & CDK 基盤

> **完了フェーズの記録である。** 以降の ADR が実装を変えている箇所があるため、現在の姿は
> `CLAUDE.md` のフェーズ一覧と `docs/pipeline.md` を参照。以下のファイルパス・ステップ名は
> 当時のものである。

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
このファイルの記述だけで切り替わる（`account` に全 env 同じ ID＝同一、env ごとに別 ID＝別アカウント）。
パイプライン自身が建つアカウントはデプロイ先とは独立で、`cdk deploy KukanPipeline` を実行した
ときの認証情報（`CDK_DEFAULT_ACCOUNT`）で決まる。トップレベルの `pipelineAccount`（省略可）は
その配置先を*選ぶ*ものではなく、想定アカウントを宣言して認証情報との一致を synth 時に
検証するガードである（ADR-031、後述「セットアップ手順」）。

```bash
cp infra/config/environments.example.ts infra/config/environments.ts
# environments.ts を編集
```

フィールドの一覧（型・デフォルト・env 側 / サイト側の区分、過去互換の注記）は
公開ドキュメントの**環境設定リファレンス**に一元化した
（`site/src/content/docs/ja/system-admin-guide/environment-config.mdx`、公開 URL:
<https://kukan-project.github.io/ja/system-admin-guide/environment-config/>）。
`environments.example.ts` も全フィールドをコメント付きで列挙する（推奨の
マルチサイト形状のみを提示）。

要点: サイトスコープのフィールド（`enableWaf` 〜 `enableGa4DataApi`）を env
直下に書けるのはシングルサイト形状（`sites` なし）だけの**過去互換**で、`sites`
を宣言した環境では各サイトエントリに書く（混在は synth 時に validateSites が拒否）。

優先順位: CLI `-c` フラグ > `environments.ts` の env エントリ > スケール既定（`config.ts`）> 組込み既定。
ただし `-c` が効くのは環境エントリのフィールドのみで、サイトスコープのフィールドへの
`-c` はマルチサイト環境では無視される（1 つの `-c domainName=…` が全サイトへ
一括適用される事故の防止、ADR-041）。

```ts
// infra/config/environments.ts の例
export const connectionArn = 'arn:aws:codeconnections:ap-northeast-1:...:connection/...'

export const environments = {
  dev: {
    scale: 'small',
    githubRepo: 'kukan-project/demo.kukan.dev',
    deployBranch: 'develop',
    sites: [{ name: 'main', enableWaf: false }],
  },
  prd: {
    scale: 'large',
    githubRepo: 'kukan-project/demo.kukan.dev',
    deployBranch: 'main',
    sites: [
      {
        name: 'main',
        domainName: 'demo.example.com',
        hostedZoneId: 'Z0123456789',
        hostedZoneName: 'example.com',
        allowedIpRanges: ['203.0.113.0/24', '2001:db8::/32'],
        certificateArn: 'arn:aws:acm:us-east-1:...:certificate/...', // pipeline 用に一度作成（後述）
      },
    ],
  },
} satisfies Record<string, EnvironmentConfig>
```

#### スケール別デフォルト値

| パラメータ              | small               | medium                            | large                                             |
| ----------------------- | ------------------- | --------------------------------- | ------------------------------------------------- |
| Web vCPU / Memory       | 0.25 / 512 MB       | 0.5 / 1 GB                        | 1 / 2 GB                                          |
| Web min / max instances | 1 / 2               | 1 / 5                             | 2 / 10                                            |
| Worker vCPU / Memory    | 0.25 / 1 GB         | 0.5 / 1 GB                        | 1 / 2 GB                                          |
| Worker min / max tasks  | 1 / 2               | 1 / 2                             | 2 / 5                                             |
| DB                      | RDS db.t4g.micro    | Aurora 0.5-2 ACU                  | Aurora 2-8 ACU, multi-AZ                          |
| OpenSearch              | t3.small × 1, 10 GB | m6g.large × 1, 50 GB              | m6g.xlarge × 2, 100 GB, multi-AZ                  |
| DB Pool (web / worker)  | 5 / 3               | 10 / 5                            | 20 / 10                                           |
| バックアップ（ADR-037） | DB 保持 7日         | + S3 バージョニング、DB 保持 14日 | DB 保持 35日 + AWS Backup（日次35日・月次12ヶ月） |

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
# dev 環境をデプロイ（スタックは Stage 配下にネストするため Stage を glob 指定。
# --all はトップレベルのみ対象で Stage 内スタックを拾えない）
npx cdk deploy -c env=dev 'Dev/**'

# prd 環境をデプロイ
npx cdk deploy -c env=prd 'Prd/**'

# 一時的に scale を上書き（env エントリより優先）
npx cdk deploy -c env=dev -c scale=medium 'Dev/**'
```

## マルチサイト構成（ADR-041）

環境エントリに `sites: []` を宣言すると、その環境は SharedStack（共有の箱）+
SiteStack × N（サイト別リソース）に分割される。**opt-in 専用**であり、
`sites` の無い環境は従来の全部入り KukanStack を論理 ID 不変のまま合成し続ける
（synth スナップショットテストが機械検証する。`infra/lib/__tests__/`）。

**新規環境は `sites` 1 件（例: `sites: [{ name: 'main' }]`）で始めることを推奨**。
デプロイ済み環境への `sites` 後付けは全リソース置換になる（後述のブルーグリーン移行）
ため、将来サイトを増やす可能性が少しでもあれば最初からマルチサイト形状にしておく。

```
Dev (Stage)
├─ KukanSharedStack        VPC/SG・Aurora/RDS・OpenSearch・ECS クラスタ・
│                          Secrets Manager VPC endpoint・SSM パラメータ
└─ KukanSiteStack<Site>×N  サイト DB+ロール（Custom Resource）・S3・SQS・
                           web/worker サービス・CloudFront(+ドメイン)・Secrets
```

### 設定

```ts
prd: {
  account: '...',
  scale: 'medium',
  githubRepo: '...', deployBranch: 'main',
  sites: [
    {
      name: 'citya',            // ^[a-z][a-z0-9]{1,15}$（リソース名 kukan-<env>-<site>-* と DB 名 kukan_<site> に使用）
      domainName: 'catalog.city-a.example.jp',
      hostedZoneId: 'Z...', hostedZoneName: 'city-a.example.jp',
      certificateArn: 'arn:aws:acm:us-east-1:...',   // pipeline モードでは必須（standalone は自動作成、下記）
      webAclArn: 'arn:aws:wafv2:us-east-1:...',      // 複数サイトで共有可（同上）
    },
    { name: 'cityb', enableWaf: false },
  ],
},
```

- **証明書 / WAF**: シングルサイトと同じ規則。standalone モードでは不足分を
  GlobalStack が自動作成する（サイトごとの ACM 証明書 — `hostedZoneId` /
  `hostedZoneName` が必要 — と、WAF が有効で ARN 未指定のサイトが共有する
  WebACL 1 つ）。pipeline モードは cross-region 参照が使えないため（ADR-030）
  サイトごとに ARN を貼る（`npx cdk deploy -c env=<name> <Stage>/KukanGlobalStack`
  で一度作成して出力 ARN を設定）。自動作成済みの証明書 / WebACL は **RETAIN**
  — 外部 ARN への切り替えでテンプレートから消えても削除は試みない（GlobalStack
  は CloudFront より先に更新されるため、使用中リソースの削除はデプロイを失敗
  させる）。切り離されて残った WebACL は課金が続くため、参照が無くなったら
  手動で削除する
- **サイトスコープのフィールドは env 側に書けない**: domainName / hostedZone\* /
  certificateArn / webAclArn / enableWaf / allowedIpRanges / basicAuth /
  bucketName / enableGa4DataApi は `sites` 内でのみ宣言する（env 側に書くと
  synth 時に validateSites が拒否。黙って無視されるより安全）。例外は
  `overrides` のみで、env の値の上にサイトの値が deep-merge される（全サイト
  共通のチューニング + サイト個別上書き）。全サイトに同じゲートを掛けたい
  場合は TypeScript の変数として定義し各サイトへスプレッドする
- **AWS Backup**: マルチサイトでもそのまま使える（scale `large` の既定で有効）。
  DB プランは SharedStack（vault `kukan-<env>-backup`、共有クラスタを 1 回だけ
  スナップショット）、バケットプランは各 SiteStack（vault
  `kukan-<env>-<site>-backup`）に分かれる。クラスタ単位 PITR で「1 サイトだけ
  戻す」はできないため、サイト単位の復元には pg_dump の定期実行を補完する
  （ADR-037 / ADR-041 トレードオフ）
- **サイト中心で書きたい場合**: `environments.ts` は素の TypeScript なので、
  サイト台帳を先に定義して env エントリへ転置するヘルパーを書けばよい
  （ネイティブ構造が env 外側なのは、共有の箱・AWS アカウント・パイプラインが
  いずれも env 単位のため）

### デプロイ挙動

- 初回もデプロイ順は自動制御される: SharedStack → 先頭サイト（カナリア）→
  残りサイトの**直列デプロイ**（ローリング更新中は ECS が新旧タスクを併走させる
  ため、同時に更新されるサイトを常に 1 つに抑え、接続数バジェットの前提を守る）。SharedStack が書く SSM パラメータ（`/kukan/<env>/shared/*`:
  vpc/sg/ecs/db/search）を SiteStack がデプロイ時に解決する（CFN Export 不使用
  — 共有側の変更がサイト参照でロックされない）
- サイト DB（`kukan_<site>` + 専用ロール）は SiteStack 内の Lambda Custom
  Resource が冪等に作成する。マイグレーションは従来どおり各サイトのタスクが
  起動時に自 DB へ実行
- 本体コード変更 → 全サイトが順次ローリング。ブランドのみの変更（ADR-042）→
  該当サイトのみ（イメージのコンテンツハッシュ管理による）

### サイト削除時の残存リソース

SiteStack を削除（`cdk destroy` / sites から除去）した場合:

| リソース                                | 挙動                        | 手動パージ                                                                                                                                                        |
| --------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| サイト DB + ロール                      | **残る**（CR は削除しない） | master で `DROP DATABASE kukan_<site>; DROP ROLE kukan_<site>;`                                                                                                   |
| S3 バケット                             | **残る**（RETAIN）          | 空にしてから削除                                                                                                                                                  |
| Backup vault（awsBackup 有効時）        | **残る**（RETAIN）          | リカバリポイントの失効（または手動削除）後に `kukan-<env>-<site>-backup` を削除。**同名サイトを再追加する場合は先に削除**（固定名のため衝突、ADR-037 と同じ規則） |
| OpenSearch インデックス                 | **残る**（共有ドメイン内）  | `DELETE /kukan-<env>-<site>-search`                                                                                                                               |
| SQS キュー / Secrets / ECS / CloudFront | 削除される                  | DLQ は削除前に内容確認                                                                                                                                            |

### 既存シングルサイト環境の移行（ブルーグリーン）

デプロイ済み環境に `sites` を追加してはならない（スタック分割 + 物理名変更で
全リソース置換になる）。移行する場合は新環境を並行構築し、
pg_dump / restore → S3 sync → 再インデックス → DNS 切替 → 旧環境破棄の順で行う。

### 運用ノート

- DB 接続数はサイト数 ×（`WEB_DB_POOL_MAX` × **最大**タスク数 + worker プール）
  - **ローリング更新中の 1 サイト分**（新旧タスク併走）で見積もる。
    Aurora Serverless v2 の max_connections は maxACU で固定（縮退しても減らない）。
    synth 時に validateSites がこの worst case を AWS 公式表ベースの概算
    max_connections と比較し、**70% 超で警告・超過でエラー**にする（対処:
    `sites[].overrides.dbPool` / `web.maxSize` を絞る、`db.maxAcu` を上げる、
    または RDS Proxy）
- **`db.maxAcu` の引き上げとサイト追加は同一デプロイにしない**。max_connections は
  静的パラメータで、maxACU 変更後も**インスタンス再起動まで旧値のまま**残る。
  先に ACU 変更をデプロイして再起動を済ませ、新しい上限が効いてからサイトを追加する
- 共用 OpenSearch は medium（m6g.large.search）以上を推奨（1 サイトの
  再インデックスが全サイトの検索レイテンシに波及するため）。強制はしないが、
  2 サイト以上を burstable インスタンス（t3.\*）に載せると synth 時に警告が出る
- 非 AWS 環境（Docker Compose）は `docker/multi-site/` の opt-in テンプレートを
  使う（手順は同ディレクトリの README）

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

### 旧バージョンへ戻せないマイグレーション（Better Auth contract）

`account` テーブルから 1.6 互換のシム（`expiresAt` 列と `issuer` のデフォルト）を落とすマイグレーションが入っている。
適用後の DB に対して**それより前のイメージは認証が動かない** — サインイン・サインアップが
`column "expiresAt" does not exist` で 500 になる。

- ECS のローリング更新では、Worker がマイグレーションを適用した時点から旧タスクが入れ替わるまでの間、
  旧タスクが処理するサインイン・サインアップが失敗する
- 適用後にイメージだけロールバックしても認証は戻らない。ロールフォワードで復旧する
- オンプレの Docker Compose も安全ではない。`up -d --build` はサービスを個別に作り直すため、
  新しい worker がマイグレーションを適用した時点で旧 web コンテナがまだ認証を処理していれば同じことが起きる。
  このバージョンへ上げるときは、先に `docker compose --env-file .env --env-file .env.prod --profile prod down`
  でアプリを止めてから起動する

## デプロイ手順

デプロイには2つのモードがある。Docker イメージのビルド・ECR プッシュは CDK が
`DockerImageAsset` で自動実行するため、手動の `docker build` / `docker push` は不要。

> [!NOTE]
> **同一アカウントで複数環境（dev/prd）を運用する場合の ECR タグ競合**
> `DockerImageAsset` のイメージタグは**ビルド内容のハッシュ**で決まるため、同一コミットは
> dev と prd で同じタグになる。両環境を**同一アカウント・リージョン**で運用すると
> （`environments.ts` で全 env に同じ `account` を指定）CDK bootstrap のアセット用 ECR リポジトリ
> （既定で `cdk-hnb659fds-container-assets-<account>-<region>`）を共有するため、**同一コミットを
> dev と prd へほぼ同時にデプロイ**（dev マージ直後に prd マージ等）すると同じタグへの push が
> 競合し得る。現行の CDK bootstrap はこのリポジトリを **`ImageTagMutability: IMMUTABLE`** で作るため、
> 2 つ目の push が immutability 違反で失敗する。
>
> ただし **transient かつ retry-safe**: `cdk-assets` は push 前にタグ存在を確認し、既に同一
> ダイジェストがあればスキップするため、**落ちた側を再実行すれば解消**する（データ損失ではない）。
>
> 恒久対策（いずれか）:
>
> - **prd は別アカウント運用を推奨**（分離・blast radius・課金・IAM 境界。ADR-031）。別アカウントなら
>   リポジトリが分かれるため本競合は発生しない。
> - same-account を維持するなら、アセット用 ECR リポジトリを **MUTABLE 化**する。bootstrap
>   テンプレートを書き換えて bootstrap し直すのが IaC 的で確実（ハッシュタグなので上書きは
>   同一バイト列の再 push＝実質 no-op であり安全。イミュータビリティはハッシュタグで既に達成済み）:
>
>   ```bash
>   cd infra
>   npx cdk bootstrap --show-template \
>     | sed 's/ImageTagMutability: IMMUTABLE/ImageTagMutability: MUTABLE/' \
>     > bootstrap-mutable.yaml
>   npx cdk bootstrap --template bootstrap-mutable.yaml aws://<account>/<region>
>   ```
>
> - 組織 SCP が MUTABLE を許さない場合は、同一コミットの dev/prd デプロイを**直列化**する。

| モード            | コマンド                                   | 用途                                         |
| ----------------- | ------------------------------------------ | -------------------------------------------- |
| **A. Standalone** | `npx cdk deploy -c env=<name> '<Name>/**'` | 初回セットアップ・ローカルからの手動デプロイ |
| **B. Pipeline**   | push（CDK Pipelines が自動実行）           | 継続的デプロイ（ADR-030）                    |

スタック名は env でプレフィックスされる（例 `Dev/KukanStack` → CloudFormation スタック名 `Dev-KukanStack`）。

> [!IMPORTANT]
> **2つのモードは同じ CloudFormation スタック名を対象にするが、合成パスが異なる**。standalone は
> Stage を App 直下（`Dev/KukanStack/...`）に、pipeline は `KukanPipeline` 配下（`KukanPipeline/Dev/KukanStack/...`）に
> 置くため、**パスから生成される物理リソース名が変わる**。論理 ID はスタック内相対なので一致するが、
> 物理名が replacement-required なリソース（例: Application Auto Scaling の ScalingPolicy）は
> **置換**され、ECS サービス名が固定のため同一メトリクスに新旧2ポリシーが並び
> `Only one TargetTrackingScaling policy ...`（400）で失敗する。よって:
>
> - **pipeline 管理の環境を手動操作する場合は pipeline 修飾パスで指定し `-c env` を付けない**
>   （`npx cdk deploy 'KukanPipeline/Dev/KukanStack'`）。`-c env` の standalone 合成で叩かない
> - **pipeline が source of truth**（git のコミット内容をデプロイ）。standalone は手元の作業ツリーを
>   デプロイするため、未コミットの変更は次の push で pipeline が git 状態に巻き戻す
> - pipeline 実行中に同じスタックを手動で叩くと CloudFormation が `UPDATE_IN_PROGRESS` で弾く（**同時実行しない**）
> - ローカルの `cdk.context.json` がコミット済みと異なると synth 結果が変わりリソースが揺り戻る
>   （churn）。ローカルでもコミット済み context を使う
>
> `-c env` の standalone は **pipeline を使わない環境 / 初回 bootstrap / us-east-1 の cert・WAF 作成**に
> 限定する。pipeline 管理環境の緊急ホットフィックスは上記の pipeline 修飾パスで行う。

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
#    Stage 配下にネストするため Stage を glob 指定（--all は Stage 内スタックを拾えない）
npx cdk deploy -c env=dev 'Dev/**'

# 5. 初期ユーザー登録（初回のみ）
#    ブラウザでサインアップページを開いて登録する。ユーザーが1人もいない間は
#    自己登録が有効で、最初の登録者が自動的に sysadmin になる（ADR-038）。
#    ヘッドレスで作成する場合は CLI も使える（DB 接続情報は環境変数から取得）:
#      pnpm db:create-user --email admin@example.com --name admin --password <password> --role sysadmin

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
#    パイプラインをデプロイ先と別アカウントに置くなら pipelineAccount にその ID を設定
#    （配置先は手順6の認証情報で決まる。pipelineAccount はその一致を検証する誤デプロイ防止ガード）

# 2. CodeConnections 接続を作成（上記「コンソール操作」を参照）
#    → Connection ARN を environments.ts の connectionArn に設定
#    ※ GitHub App 承認はコンソール/ブラウザでの一度きりの手動操作（IaC 化不可）

# 3. Bootstrap（cdk deploy の前提。各アカウント・各リージョンで初回のみ）
#    3a. パイプラインとデプロイ先が同一アカウントの場合はこれ 1 回で済む
#        GlobalStack は us-east-1 のため us-east-1 も併せて bootstrap する
cd infra && npx cdk bootstrap aws://<account-id>/ap-northeast-1 aws://<account-id>/us-east-1

#    3b. 別アカウントにする場合は、アカウントごとに認証情報（--profile）を切り替えて実行する。
#        (1) はパイプラインアカウントで 1 回、(2)(3) はデプロイ先アカウントごとに繰り返す
#        （dev / prd をそれぞれ別アカウントにするなら 1 + 2×2 = 計 5 回）
#        (1) パイプラインアカウント: パイプライン自身が建つ ap-northeast-1 のみ
npx cdk bootstrap --profile <pipeline-profile> aws://<pipeline-account-id>/ap-northeast-1
#        (2) デプロイ先アカウントの ap-northeast-1: パイプラインアカウントを信頼させる
#            （パイプラインはこの信頼でデプロイ先の bootstrap ロールを assume する）
npx cdk bootstrap --profile <target-profile> --trust <pipeline-account-id> \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess \
  aws://<target-account-id>/ap-northeast-1
#        (3) デプロイ先アカウントの us-east-1: GlobalStack（cert/WAF）用。standalone デプロイ専用で
#            パイプラインは触らないため --trust は不要
npx cdk bootstrap --profile <target-profile> aws://<target-account-id>/us-east-1

# 4. カスタムドメイン/WAF を使う env は、us-east-1 の cert/WAF を一度だけ standalone で作成
#    （別アカウント運用ならデプロイ先アカウントの認証情報で実行する）
npx cdk deploy -c env=prd Prd/KukanGlobalStack
#    出力された ACM 証明書 ARN / WAF WebACL ARN を
#    environments.ts の certificateArn / webAclArn に設定
#    （CDK Pipelines は cross-region 参照と非互換のため ARN を文字列で渡す）

# 5. environments.ts と cdk.context.json をコミット（フォークがコミット。CodeBuild の synth が読む）
#    手順4で認証情報を切り替えた場合は、ここでパイプラインアカウントに戻す（-c env なしの synth は
#    pipeline モードで走るため、pipelineAccount ガードが認証情報と突き合わせて落ちる）
#    cdk synth で context lookup（AZ・CloudFront プレフィックスリスト）を解決して cdk.context.json を生成
npx cdk synth >/dev/null
git add infra/config/environments.ts infra/cdk.context.json && git commit -m "chore: env config"

# 6. パイプラインスタックを初回手動デプロイ（パイプラインアカウントの認証情報で実行する）
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
#    更新の場合、マイグレーションが旧イメージと両立しないバージョンでは先に down する
#    （「旧バージョンへ戻せないマイグレーション」を参照）
docker compose --env-file .env --env-file .env.prod --profile prod up -d --build

# 3. 初期ユーザー登録（初回のみ）
#    ブラウザでサインアップページを開いて登録する。ユーザーが1人もいない間は
#    自己登録が有効で、最初の登録者が自動的に sysadmin になる（ADR-038）。
#    ヘッドレスで作成する場合: pnpm db:create-user --email ... --role sysadmin

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
