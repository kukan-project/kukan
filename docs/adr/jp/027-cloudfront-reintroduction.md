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
| 4      | `/*`（デフォルト） | TTL 60–300 秒              | Cookie 転送（CF Function 制御） | HTML ページ                       |

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

### IP 制限

CloudFront が前段に立つため、ALB に到達するリクエストの送信元 IP は
すべて CloudFront の IP になる。**ALB の Security Group ではクライアント IP を
判別できない**。

IP 制限は **CloudFront Function（Viewer Request）** で実施する。
`allowedIpRanges` が設定されている場合、CDK が synth 時に IP リストを
CF Function コードに埋め込み、`event.viewer.ip` で CIDR マッチング（IPv4/IPv6 対応）を行う。
許可リスト外の IP からのリクエストには 403 を返す。
WAF の IP セットルールは使用しない（CF Function で実現することで、WAF なしでも
IP 制限が可能 = `enableWaf: false` で ~$9/月を節約可能）。

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
├── Database (RDS/Aurora)
├── Storage (S3)
├── Queue (SQS)
├── Search (OpenSearch)
├── ECS Cluster
├── WebService (Fargate + internal ALB)
├── WorkerService (Fargate)
├── CDN (CloudFront Distribution)
│   ├── VPC Origin → internal ALB
│   ├── CloudFront Functions (IP 制限 + Cookie bypass)
│   └── Cache Policy / Origin Request Policy
└── Route53 A (Alias) → CloudFront
```

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
2. `infra/lib/global-stack.ts` 作成（us-east-1: ACM 証明書 + WAF WebACL）
3. `infra/lib/constructs/cdn.ts` 作成（CloudFront Distribution + VPC Origin）
4. `infra/lib/cf-functions/viewer-request.js` 作成（IP 制限 + Cookie bypass）
5. `infra/lib/constructs/network.ts` 更新
   - ALB SG: CloudFront マネージドプレフィックスリストから port 80 のみ許可
6. `infra/lib/kukan-stack.ts` 更新
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

## 関連

- ADR-020（CloudFront 廃止の経緯）: `docs/adr/jp/020-ecs-fargate-alb-migration.md`
- ADR-012（単一オリジン設計）: `docs/adr/jp/012-api-as-library-single-origin.md`
- 過去の CloudFront 実装: git commit `9adc82c`
