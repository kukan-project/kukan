# ADR-030: CDK Pipelines による自動デプロイ（CodeConnections）

## ステータス

**承認済み（Accepted）** — 実装済み・稼働中（`infra/lib/stacks/pipeline-stack.ts`。CodePipeline は V2）。ADR-031（Stage ベースのマルチ環境）と対で設計する。パイプラインのスタックを 1 つ置く部分（「パイプライン構成」の 1 項目めとセットアップ手順 3）は ADR-074 が置換した（環境ごとに `KukanPipeline-<Env>`）。

## コンテキスト

`main` 等への push を起点にした自動デプロイを実現したい。実現方式に2つの選択肢がある。

| 方式                  | 実行場所                           | 概要                                                              |
| --------------------- | ---------------------------------- | ----------------------------------------------------------------- |
| GitHub Actions + OIDC | GitHub ランナー（AWS 外）          | ワークフローで `cdk deploy` を実行。OIDC で一時クレデンシャル取得 |
| **CDK Pipelines**     | AWS 内（CodePipeline + CodeBuild） | CDK コードでパイプラインを定義。push 起点・自己変異               |

当初は GitHub Actions + OIDC を検討した（未コミット）。しかし以下の要件から **CDK Pipelines** を採用する。

- マルチ環境（dev / prd、将来はマルチアカウント）へ**承認ゲート付きで段階デプロイ**したい
- デプロイ機構を **AWS / CDK に一元化**し、自己変異（パイプライン定義変更時に自身を更新）の恩恵を得たい
- 外部に保持する信頼関係（OIDC ロール）の管理を避けたい

CDK Pipelines の API は CDK Stage を単位に設計されているため、Stage ベースのマルチ環境設計（ADR-031）と自然に噛み合う。

## 決定

**CDK Pipelines（`aws-cdk-lib/pipelines`）+ CodeConnections（GitHub App 連携）で、ブランチ push を起点に自動デプロイする。**

### ソース / トリガー

```ts
new CodePipeline(this, 'Pipeline', {
  selfMutation: true,
  synth: new ShellStep('Synth', {
    input: CodePipelineSource.connection('kukan-project/<repo>', '<branch>', {
      connectionArn: '<CodeConnections ARN>',
    }),
    commands: ['corepack enable', 'pnpm install --frozen-lockfile', 'cd infra && npx cdk synth'],
  }),
})
```

- 指定ブランチへの push を AWS が検知 → CodePipeline 起動 → Synth（CodeBuild）→ Stage デプロイ
- `triggerOnPush` 既定 true。ブランチ／ファイルパス／タグでのトリガーフィルタは CodePipeline V2 で可能（必要時はエスケープハッチで設定）
- 認証は **CodeConnections（AWS Connector GitHub App）**。長期トークン不要

### パイプライン構成

- `KukanPipelineStack` に `CodePipeline` を定義（ADR-074 で置換：スタックは環境ごとに 1 つ）
- 各環境を Stage（ADR-031 の `KukanStage`）として `addStage()`。`pre`/`post` に `ManualApprovalStep` を挟み、prd は手動承認・dev は自動、といったゲートを設定可能
- ブランチ戦略: `develop` → dev、`main` → prd。「1 パイプラインに複数 Stage（wave + 承認）」または「ブランチ別パイプライン」のいずれかを選ぶ
  - （2026-10 補足）実装は**ブランチ別パイプライン**（環境ごとに 1 本、各環境の `deployBranch` で起動）を選んだ。本番に入る版を ADR-035 のリリース（`main` への ff とタグ）に揃えるためで、`ManualApprovalStep` は置いていない。1 本に Stage を並べると、`develop` への push のたびに本番の承認待ちが積まれ、本番の版とリリースが結びつかなくなる

### セットアップ手順（初回のみ手動）

1. **CodeConnections 接続を作成**: AWS コンソールで GitHub App（AWS Connector）を承認し、Connection ARN を取得（この承認は IaC 化できない一度きりの手動操作）
2. `cdk bootstrap`（各アカウント / リージョン。クロスアカウント時は信頼関係付きでブートストラップ）
3. **パイプラインスタックを初回手動デプロイ**（ADR-074 以降は環境ごと：`cd infra && npx cdk deploy KukanPipeline-<Env>`）
4. 以降は push で自動デプロイ。パイプライン定義の変更も自己変異で反映される

## トレードオフ

- **cross-region 参照と非互換（重要）**: CloudFront の ACM 証明書・WAF は us-east-1 必須だが、CDK Pipelines は cross-region 参照（CDK の `crossRegionReferences`）と非互換である。cross-region 参照は Lambda 付きの support stack（`BootstraplessSynthesizer`）を使い、main stack の Docker アセットと衝突して synth が失敗する。よって pipeline モードでは us-east-1 の cert/WAF を**一度 standalone で作成**し、その ARN を `environments.ts` の `certificateArn` / `webAclArn` に**文字列で渡す**（ADR-031）。standalone モードは従来どおり cross-region 参照で cert/WAF を自動作成できる
- **context lookup の決定化**: synth は CodeBuild 上で動くため、context lookup（AZ・CloudFront プレフィックスリスト）を解決する必要がある。`cdk.context.json` は gitignore せず、**フォークが値をコミット**して synth を決定的にする（upstream はコミットしない）。未コミットでも synth ロールに付与した lookup ロールの `sts:AssumeRole` 権限でライブ解決されるが、その分非決定的
- **CodeConnections の承認は手動**: GitHub App の認可はコンソールでの一度きりの手動操作で、完全な IaC 化はできない（Connection ARN のみコードで参照）
- **コスト**: CodePipeline ~$1/月 + CodeBuild のビルド時間課金
- **AWS 完結ゆえの分離**: ユニットテスト等の一般 CI を GitHub 側に持つ場合、デプロイ（AWS）と CI（GitHub）が二分される
- **bootstrap がクロスアカウントでやや複雑**
- GitHub Actions 案との比較: 自己変異・ネイティブなマルチアカウント / 承認ゲートを得る一方、GitHub ランナーの汎用性は失う

### 補足（2026-11）：ARN を貼った後も GlobalStack が自分の WebACL を管理する

pipeline モードの環境は WebACL の ARN を貼るので、standalone の GlobalStack から WebACL が外れていた。
外れると WebACL と IP セットは Retain で残るが、後から加わった WAF のログ設定とバケットのポリシーは
Retain の対象から漏れていて削除され、ログが止まった。以後のルールの変更（レート制限・認証情報の
ヘッダーを伏せる設定など）も、どこからも WebACL に届かなかった（「手元で ARN を外して GlobalStack を
デプロイする」手順を踏んだときだけ届いた）。

Retain の対象を足すだけ（ログは残るがルールは届かない）ではなく、**GlobalStack が作った WebACL は、
ARN を貼った後も GlobalStack が管理し続ける**ことにした。

- 見分けは ARN の名前で行う。WebACL には名前を付けておらず、CloudFormation が論理 ID
  （`WafWebAclBE24253C`、構築パス `Waf/WebAcl` から CDK が作る）に乱数を足して名前を付ける。
  ARN が us-east-1・同じアカウント・`WafWebAclBE24253C-` で始まる名前なら、自分の WebACL とみなす。
  新しい設定は要らない。論理 ID が変わると見分けが壊れ WebACL も作り直しになるので、合成のたびに
  CDK の付けた論理 ID と照合する
- 外部で作った WebACL の ARN は扱わない。「足りない方だけ作る」目的（使われない WebACL に課金しない）は保つ
- standalone の合成では、自分の WebACL の ARN が貼ってあれば、ほかに作るものが無くても GlobalStack を
  組む。ルールの変更は `webAclArn` を外さずに GlobalStack の standalone デプロイで届く。pipeline の
  合成では GlobalStack を組まない
- サイトは貼った ARN の文字列を読み、リージョンをまたぐ参照を持たない。そのため GlobalStack を
  パイプラインの Stage に入れられる見込みがある（cross-region 参照が無ければ上の非互換は当たらない）。
  今回は行わず、今後の案として残す

## 影響（実装時の変更点）

- 新規: `infra/lib/stacks/pipeline-stack.ts`（`CodePipeline` 定義）、`infra/lib/stacks/kukan-stage.ts`（Stage、ADR-031）
- **廃止**: `infra/lib/constructs/ci-oidc.ts`、`.github/workflows/deploy.yml`（GitHub Actions + OIDC 案の撤回。`kukan-stack.ts` の `CiOidc` 配線も除去）
- `infra/bin/app.ts`: パイプラインスタックを生成（ローカル直接デプロイ用に Stage 単体生成も併設可）
- 設定: CodeConnections の Connection ARN を環境設定（ADR-031 の `environments.ts`）または context に追加
- ドキュメント: `docs/specs/jp/phase4-deploy.md` / `README.md` / `site` を CDK Pipelines 手順へ更新

## 関連

- ADR-031（Stage ベースのマルチ環境デプロイ）: `docs/adr/jp/031-multi-environment-deploy.md`
- ADR-074（パイプラインのスタックを環境ごとに分ける）: `docs/adr/jp/074-pipeline-stack-per-environment.md`
- ADR-020（ECS Fargate + ALB）: `docs/adr/jp/020-ecs-fargate-alb-migration.md`
- ADR-027（CloudFront 再導入・2 スタック構成）: `docs/adr/jp/027-cloudfront-reintroduction.md`
- AWS 公式: [CDK Pipelines](https://docs.aws.amazon.com/cdk/v2/guide/cdk_pipeline.html) / [CodeConnections](https://docs.aws.amazon.com/dtconsole/latest/userguide/connections.html)
