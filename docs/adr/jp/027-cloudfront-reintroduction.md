# ADR-027: CloudFront 再導入（ページキャッシュ + WAF 統合）

## ステータス

**承認（Accepted）**

## コンテキスト

ADR-020 で CloudFront を廃止し、ALB が前面に立つ構成を採用した。
廃止理由は「ALB で CloudFront の全機能を代替できる」ことだったが、
運用を進めるなかで **ページキャッシュ** の必要性が浮上した。

### 現状の課題

1. **公開ページの SSR が毎リクエスト DB にアクセスする**
   - データセット一覧・詳細、組織一覧・詳細、グループ一覧・詳細、トップページ
   - `serverFetch` → Hono `app.request()` → Drizzle → PostgreSQL が毎回実行される
   - ISR（Next.js の Incremental Static Regeneration）で DB 負荷は減らせるが、
     Fargate のファイルシステムは揮発性のためタスク再起動でキャッシュが消失し、
     複数タスク間でキャッシュが共有されない

2. **WAF が ALB にのみ存在する**
   - CloudFront を前段に置いた場合、キャッシュヒット時はリクエストが ALB に到達しない
   - ALB 側 WAF ではキャッシュヒットのリクエストに対して IP レピュテーション等の
     検査が効かない

### CloudFront 再導入で解決する問題

- 未ログインユーザーの公開ページをエッジキャッシュから返す → DB 負荷軽減
- キャッシュヒット時でも WAF で検査できる（CloudFront スコープ）
- 突発的アクセス集中時にオリジンを保護

### ADR-020 で挙げた CloudFront のデメリットへの対応

| ADR-020 のデメリット                          | 本 ADR での対応                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| us-east-1 の ACM 証明書でクロスリージョン依存 | CDK `crossRegionReferences` で ARN を連携。2 スタック構成を受け入れる          |
| CloudFront → ALB データ転送の二重課金         | AWS 内部転送は無料。CloudFront の転送単価は EC2→Internet より安い              |
| WAF 二重コスト                                | WAF を CloudFront 側に一本化（ALB の WAF を廃止）                              |
| リクエスト経路 3 段で障害切り分け困難         | CloudFront アクセスログ + ALB ログの 2 箇所になるが、VPC origin で経路を明確化 |

## 決定

**CloudFront を再導入し、WAF を CloudFront スコープに移行する。**

### アーキテクチャ

```
User → CloudFront (WAF + Cache) → [VPC Origin] → ALB (internal) → ECS Fargate (Next.js + Hono)
```

### キャッシュ戦略: セッション Cookie によるバイパス

Better Auth のセッション Cookie（`__Secure-better-auth.session_token`）の有無で
キャッシュとバイパスを切り替える。アプリケーションコードの変更は不要。

| 条件                   | CloudFront の挙動                                                    |
| ---------------------- | -------------------------------------------------------------------- |
| セッション Cookie なし | キャッシュから返す（ヒット時）/ オリジンへ転送しキャッシュ（ミス時） |
| セッション Cookie あり | 常にオリジンへ転送（キャッシュしない）                               |

**判定方法**: CloudFront Functions（Viewer Request）で Cookie ヘッダーを検査し、
セッション Cookie が存在する場合はキャッシュキーに一意値を追加してバイパスする。

#### 対象ページの分類

| パス                              | ログイン状態で内容が変わるか                             | キャッシュ                    |
| --------------------------------- | -------------------------------------------------------- | ----------------------------- |
| `/dataset`（一覧）                | 変わる（private データセットの可視性）                   | Cookie なし → キャッシュ      |
| `/organization`, `/group`（一覧） | 変わらない                                               | Cookie なし → キャッシュ      |
| `/dataset/[name]`（詳細）         | 変わる（`canManage` で管理 UI 表示、private の閲覧権限） | Cookie なし → キャッシュ      |
| `/dashboard/*`                    | 認証必須                                                 | 常にバイパス（Cookie あり）   |
| `/auth/*`                         | —                                                        | 常にバイパス                  |
| `/api/*`                          | 認証依存                                                 | 常にバイパス                  |
| `/_next/static/*`                 | 変わらない                                               | 長期キャッシュ（Cookie 無視） |

公開ページでログイン状態により変わる箇所:

- **ヘッダー**: ログインボタン ↔ ユーザーメニュー
- **データセット一覧**: `buildVisibilityFilters` で private データセットの可視性が変わる
- **データセット詳細**: private データセットの閲覧権限 + `canManage` で管理 UI 表示/非表示

これらはすべてログインユーザー（Cookie あり）ではバイパスされてオリジンに転送されるため、
正しい権限チェックが行われる。キャッシュされるのは未ログインユーザー向けの
公開データのみであり、private データセットがキャッシュ経由で漏洩するリスクはない。

### Cache Behavior 設計

| 優先度 | パスパターン       | Cache Policy               | Origin Request Policy           | 備考                              |
| ------ | ------------------ | -------------------------- | ------------------------------- | --------------------------------- |
| 1      | `/_next/static/*`  | 長期キャッシュ（TTL 1 年） | なし                            | コンテンツハッシュ付き、immutable |
| 2      | `/api/*`           | キャッシュ無効             | All Viewer                      | 認証・CRUD・MCP                   |
| 3      | `/auth/*`          | キャッシュ無効             | All Viewer                      | Better Auth                       |
| 4      | `/robots.txt`      | TTL 1 時間（キーは空）     | なし                            | 言語・Cookie・クエリで分けない    |
| 5      | `/sitemap*`        | TTL 1 時間（キーは空）     | なし                            | `/sitemap.xml` と `/sitemap/*`    |
| 6      | `/*`（デフォルト） | TTL 60–300 秒              | Cookie 転送（CF Function 制御） | HTML ページ                       |

### キャッシュ TTL と更新戦略

公開 HTML の TTL は **60–300 秒** とし、自然に更新される方式を採用する。
明示的な invalidation（`CreateInvalidation` API）は初期段階では導入しない。

**理由**:

- データカタログの公開ページは分〜時間単位の更新頻度
- 60–300 秒の遅延は許容範囲
- Invalidation は API 側に CloudFront 連携コードが必要になり複雑化する
- 将来必要になった場合に追加可能

### WAF 構成

WAF を ALB（REGIONAL）から CloudFront（CLOUDFRONT スコープ）に移行する。

| 項目                | 変更前（ALB）                           | 変更後（CloudFront）          |
| ------------------- | --------------------------------------- | ----------------------------- |
| スコープ            | REGIONAL                                | CLOUDFRONT                    |
| リージョン          | ap-northeast-1                          | us-east-1（KukanGlobalStack） |
| アタッチ先          | ALB                                     | CloudFront Distribution       |
| マネージドルール    | 同一（Common, BadInputs, IpReputation） | 同一                          |
| キャッシュヒット時  | WAF をスキップ                          | **WAF で検査される**          |
| IP レピュテーション | キャッシュヒット時に効かない            | 全リクエストに効く            |
| コスト              | ~$9/月                                  | ~$9/月（二重にならない）      |

ALB の WAF は廃止する。ALB は internal（VPC 内部）のため、
インターネットから直接アクセスできない。

### アクセス制限（IP 許可リスト + Basic 認証）

CloudFront が前段に立つため、ALB に到達するリクエストの送信元 IP は
すべて CloudFront の IP になる。**ALB の Security Group ではクライアント IP を
判別できない**。

アクセス制限は **CloudFront Function（Viewer Request）** で実施する。
2 種類の門番をサポートし、**OR で結合**する（どちらか一方を満たせば通過）:

- **IP 許可リスト**: `allowedIpRanges` が設定されている場合、CDK が synth 時に IP リストを
  CF Function コードに埋め込み、`event.viewer.ip` で CIDR マッチング（IPv4/IPv6 対応）を行う。
- **Basic 認証**: `basicAuth: { username, password }` が設定されている場合、CDK が synth 時に
  `base64("user:pass")` を CF Function に埋め込み、`Authorization` ヘッダーと照合する
  （CloudFront Functions に `btoa`/`Buffer` が無いため synth 時にエンコード）。

両方設定した場合、社内 IP からはパスワード不要で通過し、社外（固定 IP を持たない協力者）は
Basic 認証で通過できる。固定 IP を持たない相手に限定公開したいケースを想定。

弾く際のステータスコードは、Basic 認証が設定されていれば `401`（`WWW-Authenticate: Basic`
付きでブラウザに認証ダイアログを促す）、IP 許可リストのみなら `403`。

WAF の IP セットルールは使用しない（CF Function で実現することで、WAF なしでも
アクセス制限が可能 = `allowedIpRanges` か `basicAuth` のどちらかが設定されていれば
`enableWaf` は既定で OFF になり ~$9/月を節約可能）。

**注意**: Basic 認証の資格情報は CF Function のソース（コンソール/API から閲覧可能）に
base64 で埋め込まれるため、これは「軽い目隠し」用途（ステージング保護等）に留める。
機密データの保護にはアプリ本来の認証（Better Auth）や WAF を併用すること。
読めるのは `cloudfront:GetFunction`、CloudFormation のテンプレート、パイプラインの成果物
（`cdk.out`）を読める主体で、`environments.ts` にも平文で残る。ほかで使うパスワードを流用しない。

### ALB 直アクセス防止（VPC Origin）

CloudFront VPC Origin を使用し、CloudFront が VPC 内の internal ALB に直接接続する。

- ALB は `internetFacing: false`（パブリック IP を持たない）
- CloudFront が VPC 内に ENI を作成し、プライベートネットワーク経由で ALB にアクセス
- ALB の SG は CloudFront マネージドプレフィックスリスト（`com.amazonaws.global.cloudfront.origin-facing`）からの port 80 のみ許可
- Origin Verify ヘッダーや Secrets Manager シークレットは不要（ネットワークレベルで隔離）
- オンプレ / ローカルでは CloudFront を使わないため影響なし
- ALB のパブリック IPv4 が不要になり、**~$7.5/月のコスト削減**

### CDK スタック構成

```
KukanGlobalStack (us-east-1)          ※ crossRegionReferences で ARN を連携
├── ACM Certificate (CloudFront 用、domainName 設定時のみ)
└── WAF WebACL (CLOUDFRONT scope、enableWaf 有効時のみ)
    └── マネージドルール (Common, BadInputs, IpReputation)

KukanStack (ap-northeast-1)
├── Network (VPC, SG)
├── Database (RDS/Aurora、ジョブキューの job 表も)
├── Storage (S3)
├── Search (OpenSearch)
├── ECS Cluster
├── WebService (Fargate + internal ALB)
├── WorkerService (Fargate)
├── CDN (CloudFront Distribution)
│   ├── VPC Origin → internal ALB
│   ├── CloudFront Functions (アクセス制限: IP/Basic + Cookie bypass + ロケール/クライアント IP ヘッダー)
│   └── Cache Policy / Origin Request Policy
└── Route53 A / AAAA (Alias) → CloudFront
```

（2026-10 補足: 決定時の図にあった `Queue (SQS)` は ADR-058 で廃止した。ジョブは PostgreSQL の `job` 表に積み、web が worker を HTTP の `POST /wake` で起こす。）

### オンプレ版への影響

なし。CloudFront は AWS 固有のインフラ。
VPC Origin はインフラ層の変更のみであり、アプリケーションコードに変更はなく、
オンプレ / Docker Compose 環境に影響しない。

## コスト影響

| 項目                  | 変更前        | 変更後               | 差額                          |
| --------------------- | ------------- | -------------------- | ----------------------------- |
| ALB 固定費            | ~$18/月       | ~$18/月              | ±$0                           |
| ALB パブリック IPv4   | ~$7.5/月      | $0（internal ALB）   | **-$7.5**                     |
| WAF                   | ~$9/月（ALB） | ~$9/月（CloudFront） | ±$0                           |
| CloudFront リクエスト | —             | ~$1–3/月             | +$1–3                         |
| CloudFront データ転送 | —             | $0.085/GB            | EC2 直接 ($0.114/GB) より安い |
| Origin Verify Secret  | ~$0.4/月      | $0（不要）           | **-$0.4**                     |
| **合計**              | —             | —                    | **-$5–7/月**（小規模時）      |

VPC Origin により ALB のパブリック IPv4 が不要になり、Origin Verify Secret も廃止できる。
データ転送量が多い場合は CloudFront の方がさらに安くなる（$0.085 vs $0.114/GB）。

## 移行手順

### 実装（完了）

1. ADR 承認
2. `infra/lib/stacks/global-stack.ts` 作成（us-east-1: ACM 証明書 + WAF WebACL）
3. `infra/lib/constructs/cdn.ts` 作成（CloudFront Distribution + VPC Origin）
4. `infra/lib/cf-functions/viewer-request.js` 作成（アクセス制限: IP/Basic + Cookie bypass）
5. `infra/lib/constructs/network.ts` 更新
   - ALB SG: CloudFront マネージドプレフィックスリストから port 80 のみ許可
6. `infra/lib/stacks/kukan-stack.ts` 更新
   - 地域 ACM 証明書を廃止（CloudFront が TLS 終端）
   - CDN コンストラクト追加
   - Route53 レコードを CNAME → ALB から A (Alias) → CloudFront に変更
   - ALB の WAF Association を削除（WAF は CloudFront 側に移行済み）
7. `infra/bin/app.ts` 更新（KukanGlobalStack + crossRegionReferences）

### デプロイ

```bash
# 1. GlobalStack（us-east-1）
npx cdk deploy KukanGlobalStack

# 2. KukanStack（ap-northeast-1）
npx cdk deploy KukanStack
```

#### 既存環境からの移行時の注意

旧構成の ALB には HTTPS リスナー（port 443）と HTTP→HTTPS リダイレクトリスナー（port 80）が
存在する。新構成では ALB は HTTP リスナー（port 80）のみとなるが、CloudFormation は新リスナーを
作成してから旧リスナーを削除するため、同じ port 80 に2つのリスナーが一時的に共存しようとして
エラーになる。

**対処**: デプロイ前に旧リスナーを手動で削除する。

```bash
# ALB のリスナー一覧を確認
aws elbv2 describe-listeners --load-balancer-arn <ALB_ARN> \
  --query 'Listeners[*].[Port,Protocol,ListenerArn]' --output table

# port 80（HTTP redirect）と port 443（HTTPS）のリスナーを削除
aws elbv2 delete-listener --listener-arn <port-80-listener-arn>
aws elbv2 delete-listener --listener-arn <port-443-listener-arn>

# 再デプロイ
npx cdk deploy KukanStack
```

この手順は旧構成からの一度きりのマイグレーションでのみ必要。新規デプロイでは不要。

### 動作確認

```bash
# キャッシュヒット確認（未ログイン）
curl -sI https://<domain> | grep x-cache
# → X-Cache: Hit from cloudfront

# ALB は internal のためインターネットから直接アクセス不可
# （DNS 解決がプライベート IP を返すため、VPC 外から接続できない）

# ログイン時にバイパスされることを確認
# API エンドポイントの正常動作
# WAF ルールの動作確認（enableWaf 有効時）
```

## 補足（2026-10、v0.36.0）

viewer-request 関数は、アクセス制限と Cookie バイパスに加えて 2 つのヘッダーを毎リクエスト
上書きする（閲覧者が送った値は使わない）。

- **`x-kukan-locale`**: `NEXT_LOCALE` Cookie → `Accept-Language`（q の順）→ 既定 `en` の順で
  決めたロケール。HTML の Cache Policy はこのヘッダーをキャッシュキーに含める。
  `Accept-Language` そのものをキーにするとブラウザごとにエントリが分かれるため、ロケールごとの
  1 エントリに畳む。web はこのヘッダーがあればそれを優先する。
- **`x-kukan-client-ip`**: `event.viewer.ip`。`X-Forwarded-For` の末尾は CloudFront 自身の番地で、
  閲覧者が送る値を信じると回数制限の単位を自分で選べてしまう。web は `CLIENT_IP_HEADER`
  （CDK が設定）で指定されたこのヘッダーを、サインインの回数制限に使う（ADR-003 補足）。

Route 53 には A に並べて AAAA の Alias も作る（`enableIpv6Dns`、サイトごとに上書き可）。既定は
有効だが、`allowedIpRanges` を設定した環境では無効にする。IPv4 の番地で許可していた閲覧者が IPv6 で来ると
403 になり、ブラウザは IPv4 でやり直さないため。

## 補足（2026-11）: レートベースルールとログ

WebACL に、マネージドルールグループの後ろにレートベースルールを 2 つ足し、ルールが一致した
リクエストだけのログを取るようにした。設定は環境エントリの `waf`。WebACL は環境のサイトで
共有するので、サイト単位ではなく環境単位にする（サイトエントリに書くと synth で断る）。

| ルール（優先度）      | 数えるもの                                                                      | 既定の上限（5 分） | メトリクス            |
| --------------------- | ------------------------------------------------------------------------------- | ------------------ | --------------------- |
| `RateLimitAll`（40）  | 閲覧者 IP ごとの全リクエスト。`/_next/static/` と `/vendor/ibis-office/` を除く | 2000               | `kukan-waf-rate-all`  |
| `RateLimitAuth`（50） | `/api/auth/`（Better Auth）で始まるリクエスト                                   | 100                | `kukan-waf-rate-auth` |

- **静的アセットを数えない理由。** CLOUDFRONT スコープの WAF はキャッシュヒットも検査する。
  1 ページ表示が十数個の静的ファイルを取りに来るので、これを数えると上限がリクエスト数でなく
  ページ数の予算になる。除外は生のパスで厳密に判定する。先頭一致に加えて `..`・`%`・`\` を
  含まないこと（viewer-request の ibisOffice の判定と同じ）。パスは生のまま転送され、オリジンの
  読み方と食い違うことがあるので、曖昧なものは数える側に倒す。
  `/api/auth/` は URL デコードだけの形と、さらにバックスラッシュと `..` を解決した形の両方で数える。
  どちらか一方だと、もう一方の解釈で届く綴りが抜ける
- **マネージドグループの後ろに置く理由。** マネージドルールが止めたリクエストは、その IP に
  数えず、ログにも二重に残さない
- **CommonRuleSet の 2 つのルールは数えるだけにする**（`ruleActionOverrides` で count）。
  `SizeRestrictions_BODY` は本文が 8 KB を超えると止めるので、およそ 2,700 字を超える日本語の説明を持つ
  データセットが保存できなくなる。`GenericRFI_BODY` は IP アドレスで書いた URL を含む本文を止めるので、
  そのようなリソース URL を登録できなくなる。どちらも demo で実測した。カタログの API が普通に受ける
  要求に当たるので、止めずにログに残す。CommonRuleSet のほかのルール（`CrossSiteScripting_BODY`、
  `NoUserAgent_HEADER` など）は止めたままにする。前者は `<script>` やイベント属性には当たるが、
  `<b>` や `<a href>` には当たらない
- **検査しきれない本文は止める**（`BlockUninspectedBody`、優先度 5、413）。CLOUDFRONT スコープの WAF は
  本文の先頭 16 KB しか検査せず、`CrossSiteScripting_BODY` などはそこまでしか読まない。
  `SizeRestrictions_BODY` を count にしたままだと、16 KB を超えた後ろに置いた攻撃文字列がすり抜ける
  （API は本文を 1 MiB まで受ける）。そこで 16 KB を超える本文は丸ごと止める。保存できる説明は日本語で
  およそ 5,000 字まで。上限を 64 KB に上げる案は、検査の追加料金がかかるので採らなかった。
  サーバー経由のアップロード（`POST /api/v1/resources/<UUID>/upload`）だけは除く。ファイルを
  自前の上限まで受ける経路で、生のパスを UUID の形で厳密に照合するので、オリジンが別の経路と読む綴りは
  当たらない。WAF を有効にしたサイトでは、ほかの API の本文は 16 KB までになる（API 自体は 1 MiB まで
  受けるが、WAF が検査できるのは最大 64 KB で、どこかで線を引くしかない）。リソースを多数含む
  データセットの一括作成は、分けて送るか、リソースを後から足す
- **既定は `count`。** 上限を超えた IP をメトリクスとログに残すだけで、止めない。自治体の NAT や
  分離ブラウザのゲートウェイのように 1 つの出口の後ろに多くの人がいる所では、1 人分の上限が
  組織全体の上限になる。まず数えて、誰が超えているかを見てから `mode: 'block'` にする
- **`exemptIpRanges`**: 数えない CIDR（庁内の出口など）。AWS の IP セットはアドレスの版を 1 つしか
  持てないので、IPv4 と IPv6 に分けて作る（その版の範囲があるときだけ）。両ルールの絞り込みに
  `NOT IPSet` として AND される
- **`block` の応答は 429**、プレーンテキストの本文（WebACL の `customResponseBodies`、
  キー `rate-limited`）と `Retry-After` ヘッダー付き。オリジンの 403 と見分けられ、クライアントに
  待って再試行するよう伝える
- **ログ**（`AWS::WAFv2::LoggingConfiguration`）: 既定 DROP、動作が COUNT か BLOCK の一致だけ
  KEEP。資格情報を運ぶヘッダー（`cookie`、`authorization`、API トークンを受け付ける
  `x-kukan-api-key` と `x-ckan-api-key`）は伏せる。ログの記録はロギング設定の `RedactedFields` で
  伏せる。それはサンプリングした要求（コンソール）と、全ヘッダーを照合するルールの一致の詳細には
  効かないので、WebACL の `DataProtectionConfig`（`SUBSTITUTION`）でも同じヘッダーを伏せる。
  全リクエストのアクセスログは CloudFront のほう（配信無料）に既にあり、WAF のログは GB 単位で
  課金されるので、ここには「どのルールが何に当たったか」だけを置く。保持は `waf.logging.retentionDays`、省略時は `cdnLogRetentionDays`。
  `logging: false` で切る
- **バケットは WebACL と同じ us-east-1 のスタックに置く。** 名前は `aws-waf-logs-kukan-<env>-<account>`
  （AWS が `aws-waf-logs-` の接頭辞を要求する。アカウントを含めて一意にする）。CLOUDFRONT
  スコープのログ設定は us-east-1 で構成するもので、作る前にバケットとその配信用ポリシー
  （`delivery.logs.amazonaws.com` への PutObject / GetBucketAcl）が存在しなければならない —
  ログ設定はポリシーに依存させてある。アクセスログのバケットと同じく RETAIN
- **IP セットも WebACL と一緒に残す（RETAIN）。** ARN を貼る運用へ切り替えて WebACL だけが残ると、
  参照されている IP セットを消せずデプロイが止まるため。`exemptIpRanges` からその版の範囲をなくすと
  IP セットが参照されないまま残るので、気になれば手で消す
- **残ったバケットがログの再開を阻む。** 名前が固定で RETAIN なので、`logging: false` を
  デプロイしたあと（global スタックを消したあとも）バケットはスタックの外に残り、次にそれを
  作るデプロイは名前の衝突で失敗する。ログを戻す前、スタックを作り直す前に、残ったバケットを
  消すか名前を変える
- **表のプレビューは小さなリクエストの束。** 表のプレビューは Parquet を Range で読み、
  対話的なプレビューの裏の DuckDB-WASM は操作のたびに小さな GET を多数出す。どれもオリジンに
  届くので全部を数えるルールが数える。count の期間に、1 人の重いプレビュー利用が上限に
  近づいていないかを見る。近いなら除外を広げるのでなく `limit` を上げる（除外はオリジンに
  届かないパスのためのもの）
- 費用: レートルール 2 本と本文サイズのルール 1 本で +$3、WebACL あたり約 $12/月。ログは S3 の料金と配信量（GB 単位）

**数えた IP を見て block に切り替える手順:**

1. CloudWatch（us-east-1、名前空間 `AWS/WAFV2`）で `CountedRequests` を `Rule` =
   `kukan-waf-rate-all` / `kukan-waf-rate-auth` ごとに見る。0 でなければ次へ
2. 今まさに超えている IP を引く:
   ```bash
   aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1
   aws wafv2 get-rate-based-statement-managed-keys --scope CLOUDFRONT --region us-east-1 \
     --web-acl-name <Name> --web-acl-id <Id> --rule-name RateLimitAll
   ```
3. S3 のログ（スタック出力 `WafLogBucketName`、`AWSLogs/<account>/WAFLogs/` 以下）で、いつ・
   どの IP・どの URI が当たったかを読む
4. CloudFront のアクセスログ（`c_ip`・User-Agent・URI。システム管理ガイドの Athena の例）と、
   `session` 表の `ipAddress`（その IP からサインインしている利用者がいるか）で照らす。共有の
   出口なら `exemptIpRanges` に足し、そうでなければ `mode: 'block'`
5. `waf` の変更は global スタックの standalone デプロイで反映する（pipeline は us-east-1 を
   持たない、ADR-030）。ARN を貼った環境では、一時的に `webAclArn` を外して
   `npx cdk deploy -c env=<env> <Env>/KukanGlobalStack` を流し、戻す。WebACL は同じ論理 ID で
   更新されるので ARN は変わらない

## 関連

- ADR-020（CloudFront 廃止の経緯）: `docs/adr/jp/020-ecs-fargate-alb-migration.md`
- ADR-012（単一オリジン設計）: `docs/adr/jp/012-api-as-library-single-origin.md`
- 過去の CloudFront 実装: git commit `9adc82c`
