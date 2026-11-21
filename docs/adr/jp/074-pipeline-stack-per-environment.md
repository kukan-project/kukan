# ADR-074: パイプラインのスタックを環境ごとに分ける

## ステータス

**承認済み（Accepted）** — 実装済み（`infra/bin/app.ts`、`infra/lib/stacks/pipeline-stack.ts`）。
ADR-030 の「パイプライン構成」のうち `KukanPipelineStack` を 1 つ置く部分とセットアップ手順 3、
ADR-031 の `pipelineAccount` と接続の共有の部分を置換する。

## コンテキスト

これまで `infra/bin/app.ts` はパイプラインのスタックを 1 つ（`KukanPipeline`）だけ作り、
その中で環境ごとに CodePipeline（`kukan-<env>`）を作っていた。各パイプラインは self-mutation で、
**自分のブランチのコードから `KukanPipeline` スタック全体**を更新する。

環境ごとに `deployBranch` が違い、ブランチの進み具合がずれる運用（develop → demo → main と昇格する等）
では、次のことが起きる。

1. prd のパイプラインが走るたびに、ほかの環境のパイプラインの定義も main の古いコードに戻り、
   次にその環境のパイプラインが走ると新しい定義に戻る。これが繰り返される
2. demo のブランチの `environments.ts` に足した環境のパイプラインは、main に届く前に prd の
   パイプラインが走ると消される
3. ある環境のブランチへの push が、ほかの環境のパイプラインの定義（ロールや build spec）まで
   書き換えられる。develop に push できる人が、prd のパイプラインを変えられることになる
4. スタックが 1 つなので、パイプラインを置くアカウントを環境ごとに変えられない
   （`pipelineAccount` と `connectionArn` が全環境で共通）。ADR-031 が勧める別アカウント運用でも、
   dev のパイプラインを dev のアカウントに、prd のパイプラインを prd のアカウントに置けない

### アプリのスタックのパスはテンプレートに入っている

パイプラインの Stage の下にあるアプリのスタック（`KukanStack`、`KukanSharedStack`、
`KukanSiteStack<Name>`）の CloudFormation のスタック名は `<Env>-<Stack>` で、親のスタックの ID を
含まない。しかし親の ID だけを変えて synth して比べると、テンプレートの中身は変わる。
CDK がアプリのルートからの構築パスで名前を作る所があるためで、実測では次が変わった。

- セキュリティグループのインバウンドルールの論理 ID（`NetworkWebSgfromKukanPipelineDemoKukanSharedStack…`
  のように、相手の SG のパスを含む）
- VPC とサブネットの `Name` タグ
- タスク定義の family、カスタムリソースのハンドラー

論理 ID が変わると CloudFormation は新しいルールを作ってから古いルールを消すので、同じ内容の
ルールが重なって作成に失敗するおそれがある。スタック名を `stackName` で固定するだけでは防げない。

## 決定

### 1. パイプラインのスタックは環境ごとに 1 つ

- スタックの ID と CloudFormation のスタック名は `KukanPipeline-<Env>`（`<Env>` は環境キーの
  `pascal()`、例 `KukanPipeline-Dev`）。`KukanPipelineStack` は 1 環境だけを受け取り、
  環境を回して各スタックを作るのは `buildPipelines()`（`bin/app.ts` が呼び、テストも同じものを呼ぶ）
- self-mutation は `cdk -a . deploy KukanPipeline-<Env>` で、自分のスタックだけを更新する。
  synth も自分の Stage のアセットだけをバンドルする（`--exclusively KukanPipeline-<Env> 'KukanPipeline/<Env>/**'`）
- 1 環境のパイプラインだけを手でデプロイできる：`npx cdk deploy KukanPipeline-Dev`
- 環境ごとの検査（`githubRepo` が無い環境はパイプラインを作らず、そこに `deployNotification` が
  あれば拒否する。us-east-1 の証明書・WAF が要る環境は拒否する）は変えない
- 環境のリージョンがパイプラインと違うときにできるリージョン間のサポートスタックも、パイプラインごとに
  持つ（`reuseCrossRegionSupportStacks: false`、名前は `KukanPipeline-<Env>-support-<region>`）。
  CDK の既定では同じリージョンの環境が最初のパイプラインのサポートスタックを共有し、ほかの環境の
  self-mutation がそれを更新してしまう

### 2. Stage は今までと同じパスに置く

各環境の Stage は、パイプラインのスタックの中ではなく、App 直下の素の Construct `KukanPipeline` の下に
置く。アプリのスタックの構築パスは `KukanPipeline/<Env>/<Stack>` のまま変わらず、スタック名・
アーティファクト ID・テンプレートも変わらない（コンテナイメージのアセットハッシュはソースから決まる
ので、どのコミットでも変わる）。CDK Pipelines は、パイプラインのスタックの外にある Stage も
`addStage()` で受け付ける。

`infra/lib/__tests__/synth-pipeline.test.ts` が、ブランチの違う 2 環境で synth して、
パイプラインのスタックが 2 つできること、アプリのスタックの名前が変更前と同じであること、
テンプレートが 1 つのスタックの中に Stage を置いた形と一致することを確かめる。

手で操作するときの修飾パス（`npx cdk deploy 'KukanPipeline/Dev/KukanStack'`、`-c env` なし）は
今までどおり使える。

### 3. パイプラインを置くアカウントを環境ごとに選べる

- 環境のエントリに `connectionArn` を書ける。書かない環境はトップレベルの値を使う（後方互換）
- パイプラインを置くアカウントは、そのパイプラインが使う接続のアカウントで決まる。CodeConnections の
  接続はアカウントに属し、パイプラインは自分のアカウントの接続しか読めないので、ほかのアカウントに
  置いても動かない。接続の ARN はアカウントから組み立てられない（末尾の ID は作成時に振られる）ので、
  書くのはアカウントではなく接続の ARN にする
- トップレベルの `pipelineAccount` は役目を終える。これまでの「認証情報のアカウントと違えば止める」
  ガードは、接続から決めたアカウントと認証情報の突き合わせが引き継ぐ。書いてあるフォークのために
  受け付け、トップレベルの接続のアカウントと食い違えば synth で拒否する。環境ごとの `pipelineAccount`
  は設けない（接続の ARN と同じことを繰り返すだけになる）
- synth は、認証情報のアカウントにあるパイプラインだけを作り、外したパイプラインを警告に出す。
  パイプラインの self-mutation はそのパイプラインのアカウントで synth するので、そのアカウントの
  パイプラインだけを作る。作るパイプラインが 1 つも無い認証情報なら synth を止める（ガード）
- これまでは `pipelineAccount` を書かなければ、どの認証情報でも全環境のパイプラインを作れた。
  動いているフォークでは接続は必ずパイプラインのアカウントにあるので、正しい認証情報での動きは
  変わらない
- スタックを分けて防げるのは、ほかの環境のパイプラインの意図しない上書きまでである。self-mutation が
  実行するコマンドはそのブランチのコードから作られ、同じアカウントのパイプラインは同じ bootstrap の
  デプロイ用ロールを使う。develop に push できる人が意図して prd のパイプラインのスタックを書き換える
  ことは、同じアカウントにある限り防げない。これを断つには、prd のパイプラインを dev のパイプラインと
  共有しないアカウントに置く（環境ごとの `connectionArn`）

## 移行（すでにデプロイしているフォーク）

パイプライン名 `kukan-<env>` と self-mutation の CodeBuild のプロジェクト名 `kukan-<env>-selfupdate`
は固定の物理名で、古い `KukanPipeline` スタックと新しいスタックに同時には存在できない。
古いスタックを先に削除してから、環境ごとのスタックをデプロイする。

この版のコードが届いた環境のブランチに push すると、古いパイプラインは synth か self-mutation
（`KukanPipeline` スタックがもう無い）で失敗し、デプロイには進まない。移行が済むまでその環境は
自動デプロイされない。

1. パイプラインのアカウントの認証情報で、古いスタックを削除する。新しいコードには `KukanPipeline`
   スタックが無いので `cdk destroy` では選べない：
   `aws cloudformation delete-stack --stack-name KukanPipeline`。
   パイプラインと違うリージョンの環境があれば、サポートスタック `KukanPipeline-support-<region>`
   も同じように削除する。アプリのスタック（`<Env>-KukanStack` など）は別の CloudFormation スタック
   なので残る
2. 環境ごとに、この版を含むそのブランチをチェックアウトし、`cd infra && npx cdk deploy KukanPipeline-<Env>`。
   新しいパイプラインは作られた直後にそのブランチの先頭で一度走る。アプリのスタックの名前と
   テンプレートは変わらないので、この版そのものの変更のほかに置き換わるものは無い。
   まだこの版が届いていないブランチの環境は、届いてから行う
3. `deployNotification` の環境では、Slack の webhook を入れたシークレットが古いスタックと一緒に
   削除される。新しいスタックの出力に出るシークレットに URL を貼り直す
4. 片付け：古いスタックの成果物のバケット（サポートスタックのレプリケーションのバケットも）と、
   通知の Lambda のロググループは、削除のときに残る（DeletionPolicy が Retain）。中身を空にして
   手で消す。別アカウントへ配るパイプラインの KMS 鍵は、CloudFormation が削除を予約する

移行のあいだに急いでデプロイしたいときは、修飾パスで手動デプロイする
（`npx cdk deploy 'KukanPipeline/<Env>/<Stack>'`、`-c env` なし）。

## トレードオフ

- **移行の手間**：既存のフォークは 1 回、古いスタックの削除と環境ごとのデプロイを手で行い、
  そのあいだ自動デプロイが止まる。固定名のリソースを新しいスタックへ取り込む（CloudFormation の
  リソースのインポート）方法もあるが、CDK Pipelines が作るリソースの数が多く、手順が長くなるので採らない
- **Stage をパイプラインのスタックの外に置く**：CDK Pipelines の例とは違う形になる。テストが、
  パイプラインが自分の Stage を組み込めることと、アプリのスタックが変わらないことを確かめる
- **`cdk.context.json` はパイプラインのアカウントごとに作る**：synth は認証情報のアカウントの Stage しか
  作らないので、パイプラインをアカウントごとに分けたら、lookup の結果を記録する synth もアカウントごとに
  行う
- **パイプラインごとのコストは変わらない**：パイプラインの数は環境の数のまま

## 関連

- ADR-030（CDK Pipelines による自動デプロイ）: `docs/adr/jp/030-cdk-pipelines-deploy.md`
- ADR-031（マルチ環境デプロイ）: `docs/adr/jp/031-multi-environment-deploy.md`
- ADR-035（リリースノート）: `docs/adr/jp/035-semver-release-notes.md`
- デプロイ仕様: `docs/specs/jp/phase4-deploy.md`
