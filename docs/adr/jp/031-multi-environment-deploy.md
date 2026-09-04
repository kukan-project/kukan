# ADR-031: マルチ環境（dev / prd 等）デプロイ設計（CDK Stage）

## ステータス

**承認済み（Accepted）** — 実装済み・稼働中（`infra/lib/kukan-stage.ts` / `config/environments.ts`）。ADR-030（CDK Pipelines）と対で設計する。サイト軸の追加は ADR-041 が拡張する。

## コンテキスト

現状の CDK は単一環境を前提としている。

- スタックを `bin/app.ts` で直接生成し、環境の概念がない（`infra/bin/app.ts`）
- 設定 `loadConfig` がフラット（`infra/lib/config.ts`）
- S3 バケット名が固定既定値 `kukan-resources`、その他にも固定の物理名が多数（クラスタ `kukan`、SQS `kukan-pipeline`、ECS `kukan-web`/`kukan-worker`、CF Function `kukan-viewer-request` 等）

OSS としてフォークされる前提では、フォーク側が **設定ファイル 1 つの編集で複数環境（例: dev / prd）を柔軟に構築**でき、かつ **同一アカウント運用と別アカウント運用の両方**を選べることが望ましい。デプロイは CDK Pipelines（ADR-030）で行うため、その API 単位である **CDK Stage** を環境境界として採用する。

### 名前空間の前提（重要）

- **S3 バケット名は AWS 全体でグローバル一意**。アカウントを分離しても同名は衝突する。
- IAM ロール名・ECS/OpenSearch/SQS/RDS 名・ロググループ等は**アカウントスコープ**。
- **CDK Stage はスタック名・論理 ID を Stage 名で名前空間化する**（例 `Dev-KukanStack`）。これにより**自動命名のリソース**は Stage ごとに一意になるが、**明示的な物理名を与えているリソースは Stage では自動分離されない**（リテラルのまま）。

## 決定

**環境定義ファイル `infra/config/environments.ts` で環境を宣言し、各環境を `KukanStage`（`cdk.Stage`）としてインスタンス化する。CDK Pipelines（ADR-030）がこの Stage を `addStage()` でデプロイする。同一アカウント・別アカウントのどちらも、このファイルの記述だけで切り替えられる。**

### KukanStage（環境境界）

```ts
// infra/lib/kukan-stage.ts
export class KukanStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: EnvironmentConfig & cdk.StageProps) {
    super(scope, id, props)
    const global = new KukanGlobalStack(this, 'KukanGlobalStack', { ... })  // us-east-1
    new KukanStack(this, 'KukanStack', { ...props, globalCertificateArn: global.certificateArn })
  }
}
```

- Global（us-east-1）+ Main（ap-northeast-1）の2スタックを Stage が内包。スタック名は `Dev-KukanStack` のように Stage 名でプレフィックスされる
- `env: { account, region }` を Stage 単位で設定 → 別アカウント運用が自然

### 環境定義ファイル

```ts
// infra/config/environments.ts（フォークが編集・コミット。upstream はコミットしない）
export interface EnvironmentConfig {
  account: string // 必須。対象アカウント ID（誤デプロイ防止。CDK が認証情報との不一致を拒否）
  region?: string // 省略 → ap-northeast-1
  scale?: Scale
  dbEngine?: DbEngine
  enableOpenSearch?: boolean
  enableWaf?: boolean
  allowedIpRanges?: string[]
  domainName?: string
  hostedZoneId?: string
  hostedZoneName?: string
  certificateArn?: string // 事前作成した us-east-1 ACM 証明書 ARN（pipeline 用、ADR-030）
  webAclArn?: string // 事前作成した us-east-1 WAF WebACL ARN（pipeline 用、ADR-030）
  bucketName?: string // 省略 → 自動命名（グローバル一意）
  enableGa4DataApi?: boolean
  githubRepo?: string // CodeConnections のソースリポジトリ
  deployBranch?: string // この環境をデプロイするブランチ
  overrides?: DeepPartial<ScaleComputed> // preset の個別パラメータ上書き（後述）
}

/** パイプラインを置く想定アカウント。配置先は認証情報が決め、これは一致を検証するだけ（省略可） */
export const pipelineAccount = '000000000000'

export const environments = {
  dev: { account: '000000000000', scale: 'small', deployBranch: 'develop' },
  prd: {
    account: '000000000000',
    scale: 'large',
    deployBranch: 'main',
    domainName: 'catalog.example.com',
  },
} satisfies Record<string, EnvironmentConfig>
```

- リポジトリには `infra/config/environments.example.ts` をコミットし、フォークは `environments.ts` にコピーして編集・コミットする（upstream は実値の `environments.ts` をコミットしない）。

### 同一アカウント / 別アカウントの両立

| モード         | `account` の指定        | 衝突回避                                                                                                       |
| -------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| 別アカウント   | 各 env で別の ID を指定 | アカウントで分離。Stage の `env` で指定                                                                        |
| 同一アカウント | 各 env で同じ ID を指定 | Stage 名でスタック名・論理 ID・自動命名リソースを分離。**明示的物理名は別途 env サフィックス化が必要**（下記） |

パイプライン自身を置くアカウントは、デプロイ先アカウントとは独立に選べる。CDK Pipelines は
各 Stage のアカウントの bootstrap ロールを assume してデプロイするため、**CI/CD 専用アカウントに
パイプラインだけを置き、dev / prd を別アカウントに配る**構成がコード変更なしで成立する
（信頼付き bootstrap・接続の置き場所・us-east-1 cert/WAF の作成先といった手順は
`docs/specs/jp/phase4-deploy.md`）。CodeConnections の接続はアカウント（＋リージョン）専有のため、
パイプラインアカウント側に 1 つ作れば全 env で共有できる。

artifact バケットの CMK 化（`crossAccountKeys`）は「パイプラインアカウント ≠ Stage の
アカウント」から自動導出するため、設定項目にしていない。

`environments.ts` の `pipelineAccount`（省略可）は、この分離に対する**誤デプロイ防止ガード**である。
env 側の `account` と違い、パイプラインの配置先は認証情報が黙って決めてしまう
（prd の認証情報で `cdk deploy KukanPipeline` すると prd にもう 1 本パイプラインが生える）。
宣言しておけば、認証情報のアカウントと食い違ったときに synth が即座に落ちる。

> [!NOTE]
> **推奨は prd の別アカウント運用**（分離・blast radius・課金・IAM 境界）。同一アカウント運用も
> first-class でサポートする（OSS 自己ホストの導入障壁を上げないため）が、caveat が 1 つある:
> 同一コミットを複数 env へほぼ同時にデプロイすると、CDK bootstrap のアセット用 ECR リポジトリ
> （現行 bootstrap は `ImageTagMutability: IMMUTABLE` で作成）へ同一タグを push して競合し得る。
> **transient かつ retry-safe**（`cdk-assets` が既存ダイジェストをスキップするため再実行で解消）で、
> 恒久対策は当該リポジトリの MUTABLE 化。別アカウント運用ならリポジトリが分かれるため無関係。
> 詳細と MUTABLE 化手順は `docs/specs/jp/phase4-deploy.md` を参照。

### 固定の物理名の扱い

Stage 名前空間化でも**明示的な物理名は自動分離されない**ため、同一アカウントで複数環境を持つ場合は以下を解消する。

- 可能なものは**明示的な物理名を外し**、CDK 自動命名（Stage プレフィックス付き）に委ねる: クラスタ名、ECS サービス名、SQS キュー名、CF Function 名
- 残すものは env サフィックス化（例 `kukan-pipeline-<env>`）
- **S3 はグローバル一意のため自動命名**（または `名前+account+env`）。参照は construct 経由（`bucket.bucketName` / `grantReadWrite()`）で、リテラル依存はないため変更は作成箇所（`storage.ts`）1 点で済む

### スケール preset の個別パラメータ上書き

現状は `scale`（small/medium/large）で `SCALE_DEFAULTS` を丸ごと採用し、`dbEngine` のみ後から上書き可能。これを env 定義の **deep-partial `overrides`** で preset にディープマージできるよう拡張する。

```ts
prd: {
  scale: 'large',
  overrides: { web: { maxSize: 20 }, opensearch: { instanceCount: 3, indexReplicas: 2 } },
},
// config.ts: const merged = deepMerge(SCALE_DEFAULTS[scale], envEntry.overrides ?? {})
```

- 個別上書きは env ファイルが主役。synth 時に整合性チェック（例 `indexReplicas < instanceCount`、Aurora `minAcu <= maxAcu`）を入れる

### 値の優先順位

env エントリ（`scale` + `overrides`）　＞　スケール既定（`config.ts`）　＞　組込み既定。一時的な実験は `cdk synth -c ...` の context 上書きで対応。

### CI（CDK Pipelines）との接続と環境定義の供給

- CDK Pipelines（ADR-030）が `environments.ts` を読み、env ごとに `pipeline.addStage(new KukanStage(...))` を行う。dev は自動、prd は `ManualApprovalStep` で承認、といったゲートを設定
- **重要**: パイプラインの Synth は **CodeBuild が git ソースから `cdk synth` する**。必要なファイルは役割が異なる:
  - **`environments.ts`（env 定義）= pipeline synth に必須**。CodeBuild の checkout に無いと正しい env を組めないため、**フォークが必ずコミット**する。upstream は実値をコミットせず `environments.example.ts` のみ提供（フレッシュ clone は example にフォールバック）
  - **`cdk.context.json`（AZ・CloudFront プレフィックスリストの lookup キャッシュ）= 再現性のためフォークがコミット推奨**。未コミットでも synth ロールに付与した lookup ロール（`cdk-*-lookup-role-*`、`sts:AssumeRole`）でライブ解決される（その分非決定的）
- どちらも gitignore せず、upstream はコミットしない
- `environments.ts` には connection ARN と account ID が載るが**秘密情報ではない**（`BETTER_AUTH_SECRET` 等は CDK 生成の Secrets。connection ARN は利用に IAM 権限が必要で単体では無価値）。account ID は `cdk.context.json` にも含まれる
- 秘匿したいフォークのみ、これらを gitignore して SSM Parameter Store 等から別途供給する例外運用も可

## トレードオフ

- **フォークの repo に connection ARN / account ID が載る**: 秘密情報ではないが、public フォークでは公開される。気にする場合は gitignore + 別供給の例外運用
- **同一アカウントは blast radius を共有**: 厳格な分離が必要なら別アカウントを選ぶ
- **明示的物理名の棚卸し**: 同一アカウント多環境には固定名の除去/サフィックス化が必要
- **standalone と pipeline は同一スタックを対象**: `KukanStage` を両モードで共有するため CFN スタック名（`<Env>-KukanStack`）が一致し衝突はしない。ただし **pipeline は git を source of truth** とするため、standalone での手元変更は次の push で巻き戻る。standalone は bootstrap / cert・WAF 作成 / 緊急対応に限定し、恒久的変更は commit/push で pipeline に追従させる（同時実行は CFN が `UPDATE_IN_PROGRESS` で拒否）

## 影響（実装時の変更点）

- 新規: `infra/config/environments.ts`（フォークがコミット）＋ `environments.example.ts`（upstream がコミット）＋ 型 `EnvironmentConfig`
- 新規: `infra/lib/kukan-stage.ts`（`KukanStage`、Global+Main を内包）
- `infra/bin/app.ts`: `environments.ts` を読み、CDK Pipelines（ADR-030）に Stage を登録（ローカル直接デプロイ用に Stage 単体生成も併設可）
- `infra/lib/config.ts`: `loadConfig` が env エントリ＋`overrides` をマージ、`bucketName` 既定を自動命名へ
- `infra/lib/constructs/*`: 固定物理名の除去/サフィックス化（cluster / service / queue / cf-function / bucket）
- `.gitignore`: `infra/config/environments.ts` と `cdk.context.json` は **ignore しない**（フォークがコミット）
- ドキュメント: `docs/specs/jp/phase4-deploy.md` / `README.md` に env 切替手順を追記

## 関連

- ADR-041（マルチサイトデプロイ）: 本 ADR の環境軸の内側にサイト軸を追加する拡張
- ADR-030（CDK Pipelines による自動デプロイ）: `docs/adr/jp/030-cdk-pipelines-deploy.md`
- ADR-020（ECS Fargate + ALB）: `docs/adr/jp/020-ecs-fargate-alb-migration.md`
- ADR-027（CloudFront 再導入・2 スタック構成）: `docs/adr/jp/027-cloudfront-reintroduction.md`
- デプロイ仕様: `docs/specs/jp/phase4-deploy.md`
