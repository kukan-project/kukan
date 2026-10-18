# ADR-068: web を Lambda Web Functions で動かす（connector と IPv6 で NAT を置かない）

## ステータス

**提案（Proposed）— 段階 2 は合格（web 全体まで）。課金の基準も請求で確かめた。CDK の L2 のリリースを待って判断する** — 2026-10-18

AWS 環境の web を、ECS Fargate + ALB に加えて **Lambda Web Functions** でも動かせるようにする。
Web Functions は、ポートで待ち受ける普通の Node の HTTP サーバーをそのまま動かすので、ADR-020 が
Lambda を退けた主な理由（OpenNext が要る、単一オリジン（ADR-012）が崩れる）は当たらなくなった。
残る壁は、web の中の DuckDB（ADR-032 のクエリ子プロセス、ADR-055 の OData フィード）と、
VPC への出口である。

VPC への出口は、egress network connector を **DualStack** にし、IPv6 で既存のインターネット
ゲートウェイから出ることで NAT を置かずに済む見込みである。IPv6 に対応しない宛先は東京の
Bedrock Runtime だけで、これはインターフェースエンドポイントで届ける。Web Functions は Arm64
のみだが、web と worker は既に arm64 の Fargate で動いており（既定）、arm64 のビルド環境もある。

**既定は ECS Fargate のままにし、環境ごとに Web Functions を選べる切り替え式にする**（§決定 1）。
Web Functions は発表されたばかりで、CDK の L2 もまだ無いため。Web Functions を選んだ環境では
ADR-020 の web の部分を置き換え、ADR-049（共有 ALB）は Fargate の環境にだけ残る。worker は
ECS Fargate のまま（§範囲外）。Docker Compose（開発・オンプレ・閉域網）には影響しない。

> **この ADR は Claude Code で設計会話をもとに起こした草案である。** Web Functions の仕様は
> 2026-10-17 時点の公式文書から、単価は AWS Price List API から、web の接触面は develop
> （`2de25638`）のソースから出した。段階 1 の実測は §コンテキスト 4 にある。

## コンテキスト

### 1. Lambda Web Functions（2026-10-12 発表）

Lambda の 3 つ目の形態で、従来の Lambda は Event Functions と呼び名が変わった。

| 項目                 | 内容                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------- |
| 動かし方             | `AWS_LAMBDA_HTTP_ENDPOINT` の番地で待ち受ける HTTP サーバー。アダプター不要                 |
| 実行環境             | 2 vCPU / 2 GB 固定、Arm64 のみ（選べない）、Node.js 24（`nodejs24.x`）                      |
| 同時実行             | 1 環境で最大 128 リクエスト（既定 64、`maxConcurrencyPerEnvironment`）                      |
| 起動                 | 10 秒以内に待ち受けを始める必要がある。最後のリクエストから約 6 分で環境は 0 になる         |
| リクエスト           | 最大 900 秒。応答のストリーミング可。HTTP/1.1 のみ、WebSocket 不可                          |
| 配布                 | zip のみ（バージョニングを有効にした S3 に置く）。コンテナイメージは不可                    |
| ランタイムのパッチ   | 自動で当たり、固定できない                                                                  |
| 入口                 | 常に公開のエンドポイント。PrivateLink 不可。CloudFront の OAC と `IamAuth` で守る           |
| 出口                 | connector なしなら Lambda 側の公開 IPv4 で直接出る。connector ありなら VPC のサブネットから |
| 課金                 | 使った CPU 時間 + 環境が使ったメモリ × 生きている時間 + リクエスト数 + データ転送           |
| リージョン（発表時） | us-east-1、us-east-2、us-west-2、ap-northeast-1、eu-west-1（大阪は無い）                    |

connector を付けると通常の出口が置き換わり、ネットワークインターフェースにはパブリック IPv4 が
付かない（付ける設定も無い）。公式文書は「IPv4 の宛先には NAT Gateway、IPv6 の宛先には
egress-only internet gateway への経路が要る」とする。IPv6 のアドレスはそれ自体がグローバルなので、
public サブネットの `::/0 → インターネットゲートウェイ` でも出られる（egress-only は着信を経路で
拒む仕組みで、セキュリティグループで拒めば必須ではない）。

### 2. ADR-020 が Lambda を退けた理由のその後

| ADR-020 の理由                                   | Web Functions で                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| OpenNext が要り、単一オリジン（ADR-012）と非互換 | **解消。** `server.js` をそのまま動かす。差は待ち受けの番地の数行         |
| Next.js standalone のコールドスタート 1〜3 秒    | 0 からの起動は残る。ただし 1 環境が多数のリクエストを受け、先回りで増える |
| INIT フェーズの課金でコスト優位が低下            | 課金の仕組みが別（使った CPU 時間）                                       |
| 常時 warm にすると Fargate と同程度              | 待機中は CPU が課金されず、メモリは確保量でなく使った量で課金される       |

### 3. web が VPC の内外で届く先

develop のソースから洗い出した。

| 宛先                                       | 用途                        | 経路（本 ADR）                           |
| ------------------------------------------ | --------------------------- | ---------------------------------------- |
| PostgreSQL（RDS / Aurora、isolated）       | 全般                        | connector                                |
| OpenSearch（isolated）                     | 検索                        | connector                                |
| worker の `/wake`（Cloud Map、ADR-058 §3） | ジョブの通知                | connector                                |
| S3                                         | storage アダプター、DuckDB  | ゲートウェイエンドポイント（既存）       |
| Bedrock Runtime（Converse、InvokeModel）   | 検索語の埋め込み、AI 提案   | **インターフェースエンドポイント**       |
| GA4 Data API（`*.googleapis.com`）         | アクセス統計（ADR-024）     | IPv6                                     |
| OpenAI 互換の API（`baseUrl`）             | AI アダプター               | IPv6（公式 API は AAAA あり）            |
| Secrets Manager                            | 起動時の秘密情報（§決定 5） | IPv6（通常のエンドポイントに AAAA あり） |

外に出ないもの: 認証（ソーシャルログイン・メール送信なし）、DuckDB の拡張機能（自動取得を
止めている）、外部 URL の取得（worker の Fetch のみ）。

東京の Bedrock Runtime は IPv6 に対応していない。公式のエンドポイント一覧にあるのは
`bedrock-runtime.ap-northeast-1.amazonaws.com` だけで AAAA が無く、dual-stack の命名
（`*.api.aws`、`*.dualstack.*`）は引けない。`bedrock-mantle.ap-northeast-1.api.aws` も A のみ。

### 4. 段階 1 の実測（2026-10-17、東京、DuckDB なし）

依存の無い Node のプローブを Web Function として置き、web のクエリ経路が前提にしていること
（検証用のコードは `spike/adr-068/`。以下の段階 2 も同じ）
（`services/child/host.ts`、`serve.ts`、`process-memory.ts`）を確かめた。

| 問い                                | 結果                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `fork` できるか                     | 可（子 1 つ約 27 ms）                                                                                                                |
| 子が `oom_score_adj` を上げられるか | 書ける。ただし下の OOM の挙動で意味を持たない                                                                                        |
| cgroup のメモリ上限                 | **無い**（`/sys/fs/cgroup` に memory のファイルが無い）。`os.totalmem()` は環境の量（約 2.4 GB）を返す                               |
| 2 GB を超えたとき                   | **環境ごと停止**（`Runtime.OutOfMemory` → `spinDownStart`）。処理中のリクエストは全部失敗し、約 0.2 秒で新しい環境が待ち受けを始めた |
| 子が確保できた量                    | 1900 MB までは問題なし                                                                                                               |
| `/tmp`                              | 525 MB、全リクエストで共有。超えると `ENOSPC`。コードの置き場は読み取り専用（`EROFS`）                                               |
| OS                                  | Amazon Linux 2023、glibc 2.34、arm64、2 vCPU                                                                                         |
| V8 のヒープ上限                     | 1408 MB（公式文書の記載は 1024 MB）                                                                                                  |
| 起動                                | 待ち受けまで 6〜8 ms（プローブのみ）                                                                                                 |
| 環境変数                            | 実行ロールの資格情報（`AWS_ACCESS_KEY_ID` など）が値そのものとして入る                                                               |

その他: エンドポイントのレート上限に指定できるのは 0 か 100 刻み。ログ群は `<name>` と
`<name>.local` の 2 つができる。

### 5. 子プロセスに切り出す意味は残る

ADR-032（残課題 2）で子プロセスにした決め手は「クエリ後に残るメモリを返す」（プロセス内で
480〜525 MB 残る → 子の終了で返る）であり、OOM 時にカーネルに子を選ばせることは監視の間隔を
埋める後ろ盾だった。Web Functions で失われるのは後ろ盾だけで、決め手はむしろ強く効く（2 GB を
最大 64 件で分け合う）。親が RSS を見て `SIGKILL` する予算、時間切れの停止、ネイティブコードの
異常終了の隔離、子の環境変数から資格情報を外すこと（§コンテキスト 4 の最終行）も効く。

### 6. CDK のサポート（2026-10-17 時点）

| 層             | 状況                                                                                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CloudFormation | `AWS::Lambda::WebFunction`、`WebFunctionRevision`、`WebFunctionEndpoint`、`NetworkConnector`、`ResourcePolicy`                                                                                                  |
| CDK の L1      | `aws-cdk-lib` 2.273.0 に `CfnWebFunction`、`CfnWebFunctionRevision`、`CfnWebFunctionEndpoint`、`CfnNetworkConnector`。revision の `EgressNetworkConnectorArn` は次の版（aws-cdk#39139、マージ済み・未リリース） |
| CDK の L2      | 未リリース。サービスチームの PR（aws-cdk#39210。安定版の `aws-lambda` に `WebFunction`、`WebFunctionCode`、`NetworkConnector`）が審査中                                                                         |
| CloudFront     | OAC の種類は `lambda`（`OriginAccessControlOriginTypes.LAMBDA`）、署名は `always-amz-auth`。オリジンの `originAccessControlId` は既存の L2 で指定できる                                                         |

L2 の PR が扱っている点のうち、KUKAN の作りに効くものが 2 つある。

- **コードは CDK の bootstrap のバケットに置けない。** バージョニング、SSE-S3、Lambda のサービス
  への読み取りの許可が要る。専用のバケットへサーバー側でコピーし、書いた版の ID を revision に
  固定するカスタムリソースが要る（`BucketDeployment` は書いた版の ID を返さない）。
- **connector はスタックをまたいで Export で渡せない。** 更新のたびに版の ARN が変わるので、
  版を固定した ARN で参照する。

## 検討した選択肢

### A) 今のまま（ECS Fargate + 共有 ALB）— 比較の基準

### B) Web Functions + connector + NAT Gateway — 不採用

最も素直だが、NAT Gateway が東京で $0.062/時（月 $45.26）+ $0.062/GB かかり、small で浮く分を
ほぼ相殺する。ADR-020 の「NAT なし」の前提も崩れる。

### C) Web Functions + connector（DualStack）+ Bedrock のインターフェースエンドポイント — 採用（提案）

IPv6 で既存のインターネットゲートウェイから出し、IPv6 に対応しない Bedrock だけを
インターフェースエンドポイント（VPC ごとに 1 つ、全サイトで共有）で届ける。

### D) connector なし（DB・OpenSearch を VPC の外から使う）— 不採用

RDS Data API は Drizzle のドライバを変えることになり、AWS と Compose で DB への接続が二系統に
なる（環境差の無いものにアダプターを作らない原則に反する）。DB をパブリックにはしない。
OpenSearch は ADR-061 で退役させる方向で、手をかける価値が低い。

### E) worker を Event Functions にして web の connector を外す — 不採用

外せるのは `/wake` の経路だけで、DB と OpenSearch のために connector は残る。worker 自身も
VPC に入れることになり、Fetch のために NAT が要る（NAT の場所が移るだけ）。

## 決定（提案）

### 1. 方式の切り替え（既定は Fargate）

- 環境の設定に `webCompute: 'fargate' | 'web-function'` を足す。既定は `fargate`。
  `cpuArchitecture`（`infra/lib/cpu-architecture.ts`）と同じく、意味を 1 か所の表にまとめ、
  各所はそれを引く。
- 単位は環境ごとにする。サイトごとに混ぜると、共有インフラに ALB と connector の両方が要り、
  組み合わせが増える。
- アプリのコードには分岐を入れない。次はどちらの方式でも害が無いので、無条件に入れる。
  - 待ち受けの番地は `AWS_LAMBDA_HTTP_ENDPOINT` があればそれにする（無ければ今と同じ）
  - cgroup が無ければ `/proc/meminfo` で環境全体を見る（§決定 4）
  - ログイン試行の回数制限の記録先を DB にする（§決定 6。タスクが複数の Fargate でも改善になる）
  - クライアントの IP は CloudFront の viewer-request 関数が付けるヘッダーから取る（どちらの方式でも CloudFront が前にある）
  - 秘密情報が環境変数に無ければ Secrets Manager から取る（§決定 5。ECS では注入されるので今と同じ）

  **補足（2026-10、v0.36.0）:** この 5 つは実装済み。待ち受けの番地は `apps/web/start.mjs` が
  読み、cgroup が無いときのメモリの上限は `AWS_LAMBDA_FUNCTION_MEMORY_SIZE` を使う。回数制限は
  `rate_limit` 表、クライアントの IP は viewer-request 関数が上書きする `x-kukan-client-ip`
  （`CLIENT_IP_HEADER`）から取る。秘密情報は `SECRET_ARNS` に並べた ARN を起動時に読む。

- CDK の分岐は 3 か所に収める。サイトの web（`WebService` か Web Function か）、共有インフラ
  （共有 ALB と VPC オリジンか、IPv6・connector・Bedrock のエンドポイントか）、CloudFront の
  オリジン（`cdn.ts` は `cloudfront.IOrigin` を受けるので差し替えるだけ）。worker・DB・
  OpenSearch・Cloud Map は共通で、セキュリティグループの許可先が web か connector かだけが変わる。
- 切り替えると web の資源は作り直されるが、CloudFront とドメインは残るので DNS は変わらない。
  戻すときは設定を `fargate` に戻してデプロイする。
- `web-function` は試験的とする。使う環境が無いと経路が古びるので、東京の検証用の環境で使い続け、
  zip のビルドは CI で確かめる。synth のスナップショットは両方式で取る。

### 2. ネットワーク

- VPC と public サブネットに IPv6 の CIDR を割り当て、`::/0 → インターネットゲートウェイ` を足す。
  RDS・OpenSearch・ECS（worker）は IPv4 のまま。
- connector は `DualStack`、public サブネット（2 AZ 以上）に置く。セキュリティグループは送信のみ。
  RDS・OpenSearch・worker のセキュリティグループで connector のセキュリティグループを許可する。
- Bedrock Runtime のインターフェースエンドポイントを共有インフラ（ADR-041）に 1 AZ で置く。
  その AZ が止まっている間は AI 提案と検索語の埋め込みが止まり、他は動く。AZ が戻れば戻る。
- connector は `HomeRegion` のエンドポイントでしか使えない（マルチリージョンにはしない）。

### 3. 入口

CloudFront → Web Function（`IamAuth` + OAC）。オリジンへのヘッダーは既に
`AllViewerExceptHostHeader`（Host を渡すと 404）。IP 制限は既に CloudFront Function で行っている
ので、ALB のセキュリティグループに代わるものは要らない。全サイトが移れば共有 ALB を外す。

`X-Forwarded-For` の最後の値は CloudFront のアドレスになる。クライアントの IP を使うところは、
viewer-request 関数が毎回 viewer のアドレスで上書きする `x-kukan-client-ip` から取る
（`CLIENT_IP_HEADER`）。`CloudFront-Viewer-Address` は送り元のポートが付き、Better Auth が
そのままでは読めないため使わない。

### 4. メモリとディスク

- 環境全体の監視（`host.ts` の container の判定）を、cgroup が無いとき `/proc/meminfo` の
  `MemTotal - MemAvailable` で行う。上限は `os.totalmem()`（2 GB の関数で約 2.4 GB）ではなく、
  関数に設定したメモリ（`AWS_LAMBDA_FUNCTION_MEMORY_SIZE`）を使う。OData の capacity も同じ値を
  引き、取得元を `web-function` と示す（`host` に落ちると、大きい値と警告のログになる）。
- 2 GB の中で、`maxConcurrencyPerEnvironment`、`QUERY_MAX_CONCURRENT`、OData の枠を配分し直す。
  OOM の後ろ盾が無い分、監視の間隔か余裕の幅を保守的にする。
- DuckDB の書き出しの上限（`max_temp_directory_size`）を、共有の `/tmp` に合わせる。

### 5. 秘密情報

revision に渡せるのは環境変数（KMS で暗号化）だけで、Secrets Manager を参照する仕組みが無い。
起動時に Secrets Manager から取る（IPv6 で届く）。値を環境変数に焼くと、秘密を変えるたびに
revision を作り直すことになる。

### 6. ログイン試行の回数制限

Better Auth の回数制限は既定でプロセスのメモリに記録する。環境が増減するたびに記録が分かれるので、
記録先を DB にする。

### 7. ビルドとデプロイ

- AWS 用に zip を作る。中身は Next.js standalone、`query-child.mjs`、**glibc の**
  `@duckdb/node-bindings-linux-arm64`（`libduckdb.so` を隣に）、`linux_arm64` 向けの DuckDB
  拡張機能、待ち受けの番地を `HOSTNAME` と `PORT` に移す入口のファイル。Docker イメージ
  （alpine、musl）とは別の配布物になる。glibc の arm64 のバイナリは、ビルドのインストールで
  `supportedArchitectures` に `libc: [glibc]`、`cpu: [arm64]` を足して入れる（段階 2c で確認）。
- zip はシンボリックリンクを保って作る（`zip -y`）。`aws lambda-web deploy` の梱包には頼らない。
- zip は、パイプラインがアセットのビルドに使っている ARM の CodeBuild
  （`LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0`、`infra/lib/cpu-architecture.ts`）で作る。
  Web Functions の実行環境と同じ Amazon Linux 2023（glibc）なので、QEMU も別の OS 向けの
  取り寄せも要らない。Docker の `deps` ステージが `supportedArchitectures` で musl だけを
  入れているのに対し、zip は glibc のバインディングを入れる。
- CDK は、L2（aws-cdk#39210）がリリースされていればそれを使い、無ければ L1 と自前の
  カスタムリソース（コードのコピーと版の ID）で組む（§コンテキスト 6）。bootstrap には手を入れない。
- connector は共有インフラに置き、版を固定した ARN を SSM のパラメータでサイトのスタックへ渡す
  （既存の共有値と同じ渡し方）。connector を更新するときは、共有インフラ → 各サイトの 2 段で
  デプロイする。
- revision の自動削除（どのエンドポイントも参照しない古い revision は上限で消える）と、置き換え
  のときの古い revision の扱いを確かめる。
- ランタイムのパッチは固定できない。web だけは digest による固定（ベースイメージ）の対象から外れる。

### 8. DB の接続数

環境ごとに接続プールができる。`maxEnvironments` で上限を決め、プールの大きさとの積を DB の
上限の内に収める。

ただし `maxEnvironments` を小さく絞ると、利用者の普通の操作で 429 が出る（段階 2c で確認）。
1 つの環境が同時に受ける本数の動的な上限は、**起動直後は 2 本から始まり、使われるにつれて
`maxConcurrencyPerEnvironment`（既定 64）へ上がっていく**。`maxEnvironments: 2` で、各リクエストを
2 秒保つ並行のまとめ送りを繰り返すと、2 環境で同時に受けられた本数は 4 → 18 → 63〜73 → 82〜100 →
115 と増えた（`spike/adr-068/concurrency.sh`）。上限に当たったリクエストは、待たされずに
`Platform.EndpointMaxEnvThrottle` の 429 で断られる。

使われない間は環境が 0 になり、再デプロイでも作り直されるので、静かなサイトほど起動直後の
低い上限で最初のまとまったリクエストを受けることになる。ダッシュボードは Next.js の先読みと
件数の取得でリクエストをまとめて送るので、上限 2 では画面の読み込みが時々失敗した。上限 10 では
同じことは起きなかった（並行 60 本で環境が 5 つ立ち上がり、すべて 200）。

そのため、`maxEnvironments` は余裕を持たせて決め（small でも 10 前後）、DB の接続の上限は
環境あたりのプールを小さくして守る（`WEB_DB_POOL_MAX`、検証では 5）。

## 段階 2（合否）

段階 1 のプローブに代えて、KUKAN のクエリの部品（`runQueryInProcess`、`@kukan/lake` の
`openDuckdb`）を束ねたサーバーを置き、§決定 2 のネットワークを専用の VPC に作って connector で
つないだ（2026-10-17、`spike/adr-068/stage2a`・`stage2b`）。最後に web 全体（Next.js の standalone）を
同じ connector で置いた（`stage2c`、エンドポイントは `IamAuth`）。

| 確かめること                              | 合格の条件                               | 結果                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| zip の大きさと配布                        | 配布でき、起動から 10 秒以内に待ち受ける | ✓ 展開後 167 MB（DuckDB のバインディング 61 MB、拡張機能 4 つで 104 MB）、zip で 59.6 MB。待ち受けまで 8 ms。読み取り専用の置き場所の拡張機能で `INSTALL` と `LOAD` が通る                                                                                                                                                                                              |
| クエリの子プロセスで DuckDB が動く        | `/query` と OData の使い方で結果を返す   | ✓ 109 MB の Parquet（120 万行）を上限 256 MB で読み込み、集計・並べ替えが 1.3〜1.7 秒。プロセス内の DuckDB（OData の使い方）は 0.84 秒                                                                                                                                                                                                                                  |
| 重いクエリ                                | 予算で子が止まり、環境は停止しない       | ✓ DuckDB の上限を 1.5 GB にしたクエリは、予算（613 MB）で子が止まって 400 を返した。環境は続いた                                                                                                                                                                                                                                                                        |
| connector 経由の RDS・OpenSearch・`/wake` | 届き、遅延が Fargate と同程度            | ✓ RDS に TLS（証明書を検証）で接続して 141 ms、`SELECT 1` の往復は中央値 0.58 ms。OpenSearch と `/wake` は同じ経路（VPC の中のプライベートな宛先）なので RDS で代えた                                                                                                                                                                                                   |
| IPv6 の出口                               | GA4・Secrets Manager に NAT なしで届く   | ✓ Secrets Manager（107 ms）、GA4 の API、OpenAI に届いた。IPv4 だけの宛先には届かない。S3 はゲートウェイ、Bedrock Runtime はインターフェースエンドポイント（VPC の中のアドレス）で届く。connector 経由の 109 MB の集計は 2.0 秒                                                                                                                                         |
| 課金                                      | メモリの課金の基準、VPC との転送の単価   | ✓ 請求で確かめた（下の「課金の実測」）。メモリは確保量（2 GB）でなく使った量で課金される。VPC との転送は Lambda 側で AZ 間の転送として計上され $0 だったが、量が小さく言い切れない                                                                                                                                                                                      |
| web 全体（Next.js）                       | 起動して SSR と API が応答する           | ✓ 展開後 330 MB、zip で 108 MB（従来の Lambda の上限 250 MB を超えても受け付けた）。SSR のページ・静的ファイル・DB を使う API・CKAN 互換の API・最初の利用者の登録（sysadmin）・データセットの作成が動いた。アップロード（署名付き URL へ直接）23 MB が 0.3 秒、web 経由のダウンロード 23 MB が 2.8 秒。新しい環境の最初のリクエストは 2.5〜2.6 秒、以降は 0.08〜0.4 秒 |

検証で分かった注意点。

- `aws lambda-web deploy` は `*.pem` を zip から外す（秘密鍵の誤配布を防ぐため）。証明書の束は
  別の拡張子で置いた。CDK で組むときも、同じ規則が無いか確かめる。
- DuckDB の HTTP クライアントのうち httplib は、Web Functions の中で応答を受け取れない（既定と
  curl は受け取れる）。KUKAN は既定のまま使っている。
- 手元の認証情報で署名した URL は、送り元の条件で拒否されることがある。web は自身のロールで
  署名するので影響しない。
- pnpm の standalone はシンボリックリンクを多く含む（今回 235 個）。zip は自分で作り
  （`zip -y` でリンクのまま）、バージョニングを有効にしたバケットに置いて revision に渡した。
- Next.js のトレースは DuckDB の `duckdb.node` を拾うが `libduckdb.so` を拾わない（イメージと同じ）。
  `duckdb.node` は自分の置き場所（`$ORIGIN`）から探すので、隣に置けば `LD_LIBRARY_PATH` は要らない。
- `IamAuth` のエンドポイントを直接呼ぶには、`X-Amz-Content-SHA256` を含めて SigV4 で署名する。
  curl 7.81 の署名では 403 になり、AWS SDK の署名ライブラリでは通った（CloudFront の OAC を
  前に置けば CloudFront が署名する）。
- `maxEnvironments: 2` では、ダッシュボードの読み込みが時々 429（`Platform.EndpointMaxEnvThrottle`）
  で失敗した。起動直後の環境は同時に 2 本しか受けないため。アプリには届かないので、アプリの
  ログには残らない（§決定 8）。
- 体感の応答は demo の Fargate（small、0.25 vCPU / 0.5 GB）より速かった。環境は 2 vCPU / 2 GB で、
  CPU は使った分だけ課金される。同じ 2 vCPU / 2 GB を Fargate（arm64）で常時確保すると月 $65 前後
  かかる。ただし検証の DB はデータが 1 件で、検索は PostgreSQL、AI は切っており、条件は揃えていない。

### 課金の実測（2026-10-17 の請求）

検証の 3 関数の 2026-10-17 の請求（Cost Explorer）を、関数を消した後も残る CloudWatch の
メトリクス（`AWS/Lambda/Web`）と突き合わせた。

| 使用タイプ（東京、arm64）  | 量             | 単価（Price List と一致） | 照合                                                                                                                                                  |
| -------------------------- | -------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Web-vCPU-Second-ARM`      | 79.879 vCPU 秒 | $0.0000322421 / vCPU 秒   | `EnvironmentCPUTime` の合計 79.879 秒と一致。使った CPU 時間そのもの                                                                                  |
| `Web-Memory-GB-Second-ARM` | 3,480 GB 秒    | $0.0000042688 / GB 秒     | 環境が生きていた時間の合計は 12,167 秒。確保量なら 24,334 GB 秒。1 分ごとの使ったメモリ × 生きていた時間は 3,420〜3,905 GB 秒（平均〜最大で重み付け） |
| `Web-Request-ARM`          | 1,737          | $0.30 / 100 万            | `ExecutedRequests` の合計と一致                                                                                                                       |
| `DataTransfer-xAZ-In/Out`  | 0.00004 GB     | 請求は $0                 | connector 経由の VPC との転送。無料とは読めない（下の注）                                                                                             |

- **メモリは使った量で課金される。** 環境が使ったメモリ（`EnvironmentMaxMemoryUsage`）× 生きて
  いた時間。web 全体の環境は 0.3 GB 前後だった（DuckDB のクエリを流した環境は最大 851 MB）。
- 環境は最後のリクエストから約 6 分生き、その間もメモリは課金される（CPU は課金されない）。
- 東京の単価は us-east-1 の約 1.16 倍（メモリ $0.0000036667、vCPU $0.0000276944）。リクエストは同じ。
- Price List（`AWSDataTransfer`）の xAZ-In/Out は量によらず $0.00 だが、EC2 の AZ 間の転送は通常
  `DataTransfer-Regional-Bytes`（$0.01/GB）に付くので、無料とは読めない。`AWSLambda` に該当の記載は
  無い。検証の量（0.00004 GB）では、$0.01/GB でも表示上 0 になり区別できない。
- 検証では CloudFront を通さずに呼んだので、インターネットへの転送（0.047 GB、$0.114/GB）が
  Lambda に計上された。CloudFront の後ろに置いたときの扱いは、CDK で組んでから確かめる。

## 費用（small、月額）

東京の単価（Price List API、Web Functions は請求で確認済み）。Web Functions の利用料は、demo の
サイト Main（small）の 2 週間の実績から見積もった。月 16 万リクエスト（ALB の `RequestCountPerTarget`、
CloudFront のキャッシュに当たらなかったもの）、Fargate の CPU 使用率は平均 1.37%（0.25 vCPU の）で、
リクエストあたり約 54 ms の CPU になる。環境はアクセスの間隔が 6 分を切る限り生き続けるので、
1 環境が 0.3 GB で月じゅう生きていると見る。

| 区分                         | 項目                                            | 月額                                                   |
| ---------------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| なくなる（サイトごと）       | web の Fargate（0.25 vCPU / 0.5 GB × 1、arm64） | $9.00                                                  |
|                              | web のタスクのパブリック IPv4                   | $3.65                                                  |
| なくなる（全サイトが移れば） | 共有 ALB（時間料金）                            | $17.74 + LCU                                           |
|                              | ALB のパブリック IPv4（2 AZ）                   | $7.30                                                  |
| 増える（共有）               | Bedrock Runtime のエンドポイント（1 AZ）        | $10.22 + $0.01/GB                                      |
| 増える（サイトごと）         | Web Functions の利用料（月 16 万リクエスト）    | 約 $3.7（メモリ $3.32 + CPU $0.29 + リクエスト $0.05） |
|                              | Web Functions と VPC の間の転送                 | 検証では $0（量が小さく言い切れない）                  |

比較の基準は arm64 の Fargate（vCPU $0.04045/時、GB $0.00442/時。web と worker は既定で arm64）。
1 サイトで月 $24 前後（なくなる $37.69 + LCU、増える約 $14）、3 サイトで月 $42 前後（なくなる
約 $63 + LCU、増える約 $21）の削減の見込み。

### medium / large の分岐点

Web Functions の利用料は「常に生きている環境の数 × 月 $3.3（0.3 GB）+ 100 万リクエストあたり
約 $2.0（CPU 54 ms で $1.74、リクエスト $0.30）」と置ける。Fargate は最小のタスク数で比べる。

| 規模   | web の Fargate（最小、IPv4 込み） | Web Functions の方が高くなる月のリクエスト数 |
| ------ | --------------------------------- | -------------------------------------------- |
| medium | 0.5 vCPU / 1 GB × 1 = $21.64      | 約 600〜900 万（常に生きている環境 3〜1）    |
| large  | 1 vCPU / 2 GB × 2 = $79.26        | 約 2,600〜3,600 万（同 8〜2）                |

- Fargate はアクセスが増えれば最小のタスク数より増えるので、この分岐点は Web Functions に不利な側の
  見積もりである。
- CPU 54 ms は demo の実績で、閲覧が主。DuckDB のクエリや検索が多いサイトでは増え、分岐点は下がる。
- 生きている環境の数は、同時のリクエストと、起動直後の環境が 2 本しか受けないこと（§決定 8）で
  決まる。段階 2c の連続の操作では、1 分に 120 リクエストで 8 環境まで増えた。

## 範囲外

- **worker。** ECS Fargate のまま。表が空になるまで処理を続ける作り（ADR-058）、重い処理の
  子プロセスの使い回し（ADR-059）、外部 URL の取得（NAT が要る）が Event Functions に合わない。
- **Docker Compose。** 開発・オンプレ・閉域網は今のまま。web のコードの差は待ち受けの番地だけ。
- **大阪リージョン。** Web Functions が無いので Fargate のまま。CDK は両方の経路を持つ。

## 残課題

1. Web Functions と VPC の間の転送の単価（検証では $0、量が小さい）。CloudFront の後ろでのインターネットへの転送の扱い。
2. 実際のサイトで、常に生きている環境の数と、リクエストあたりの CPU を確かめる（分岐点の前提）。
3. 0 からの起動の SSR（SEO）と、lru-cache が環境とともに消えることの影響。段階 2c では、新しい環境の
   最初のリクエストが 2.5〜2.6 秒だった。
4. Bedrock Runtime が dual-stack のエンドポイントを持てば、インターフェースエンドポイントは外せる。
5. CDK の L2（aws-cdk#39210）のリリース。

## 関連

- ADR-012（単一オリジン）、ADR-017（サーバー経由のダウンロード）、ADR-020（web = Fargate +
  ALB。採用すれば web の部分を置き換える）、ADR-027（CloudFront）、ADR-032（クエリの子プロセス）、
  ADR-041（共有インフラ）、ADR-049（共有 ALB。採用すれば書き換える）、ADR-055（OData）、
  ADR-058（`/wake`）、ADR-059（worker の子プロセス）、ADR-061（OpenSearch の退役）
