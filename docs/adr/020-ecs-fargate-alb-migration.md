# ADR-020: Web = ECS Fargate + ALB, Worker = ECS Fargate（ADR-018 を置換）

## ステータス

**承認済み（Accepted）** — 2026-04-03 改訂: Express Mode → Standard Fargate + ALB

## コンテキスト

ADR-018 で Web のデプロイ先として AWS App Runner を採用したが、
AWS は 2026 年 4 月に App Runner のメンテナンスモード移行を発表した。

- 2026 年 4 月 30 日以降、新規顧客は App Runner を利用不可
- 既存顧客はセキュリティ/可用性サポート継続（新機能なし）
- AWS 推奨の移行先: Amazon ECS Express Mode

### 検討した選択肢

| 方式 | Web                            | 移行コスト | 待機コスト（small） | 備考                                                        |
| ---- | ------------------------------ | ---------- | ------------------- | ----------------------------------------------------------- |
| A    | ECS Express Mode               | 小         | ~$29/月             | Express Mode で ALB 自動管理                                |
| B    | 標準 ECS Fargate + ALB         | 中         | ~$29/月             | ★ 採用。ALB, TG, Listener を自前管理                        |
| C    | Lambda + CloudFront (OpenNext) | 大         | ~$0/月              | アーキテクチャ根本変更。単一オリジン設計（ADR-012）と非互換 |
| D    | App Runner 継続                | なし       | ~$3/月              | 新機能なし、将来的な廃止リスク                              |

### Express Mode を採用後、Standard に再変更した理由

初回改訂で Express Mode（方式 A）を採用しデプロイしたが、
運用中に以下の制約が判明し Standard Fargate + ALB（方式 B）に再変更した。

| 制約                                                     | 影響                                               | 備考                                                          |
| -------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------- |
| ALB のデフォルト証明書を Express Mode が管理             | `modifyListener` で証明書を変更しても上書きされる  | SNI 追加証明書でワークアラウンド可能だが煩雑                  |
| ALB の SG を Express Mode が管理                         | IP 制限に SG を使えず WAF が必須                   | WAF 月額 ~$9 が常に発生                                       |
| デフォルトエンドポイント (`*.ecs.*.on.aws`) を無効化不可 | カスタムドメイン設定時もデフォルトが残る           | `modifyRule` でホストヘッダーを制限するワークアラウンドが必要 |
| L1 コンストラクトのみ (CfnExpressGatewayService)         | CDK の L2 ヘルパー・型安全性が使えない             | —                                                             |
| マネージドリソースの reconciliation                      | SDK で変更した設定が予告なく巻き戻される場合がある | 証明書で発生を確認                                            |

**結論**: Express Mode の「簡易デプロイ」メリットが、カスタムドメイン + IP 制限の
ワークアラウンドのコストを上回らない。Standard Fargate + ALB の方が
制御性・透明性・コストすべてで優位。

## 決定

**Web = ECS Fargate + ALB、Worker = ECS Fargate Service（変更なし）** を採用する。

### Web → ECS Fargate + ALB

- ALB, Target Group, Listener を自前で構成（CDK L2 コンストラクト）
- カスタムドメイン: ACM 証明書 + Route53 で直接設定（ワークアラウンド不要）
- IP 制限: ALB の SG で直接制御（WAF 不要）
- WAF: マネージドルールが必要な場合のみオプションで有効化
- Auto Scaling: `autoScaleTaskCount` でリクエスト数ベース

### ネットワーク構成

- ECS タスク（Web / Worker）は Public サブネットに配置（`assignPublicIp: true`）
- NAT Instance / NAT Gateway は不要（コスト削減）
- RDS / OpenSearch は Isolated サブネット（インターネットアクセスなし）
- S3 Gateway VPC Endpoint（無料）で S3 トラフィックを最適化

### Worker → ECS Fargate Service（変更なし）

ADR-018 の決定をそのまま維持する。

### Lambda より適切な理由

- KUKAN は Hono + Next.js 単一オリジン設計（ADR-012）。Lambda 化にはアーキテクチャの根本変更が必要
- Lambda コンテナイメージのコールドスタート 1〜3 秒（Next.js standalone の場合）
- 2025 年 8 月からの INIT フェーズ課金により、Lambda のコスト優位性が低下
- Provisioned Concurrency で常時 warm にすると Fargate と同程度のコスト

## コスト影響

| スケール                    | App Runner | Fargate + ALB | Fargate + ALB + WAF |
| --------------------------- | ---------- | ------------- | ------------------- |
| small（0.25 vCPU / 0.5 GB） | ~$3/月     | ~$27/月       | ~$36/月             |
| medium（0.5 vCPU / 1 GB）   | ~$7/月     | ~$38/月       | ~$47/月             |
| large（1 vCPU / 2 GB × 2）  | ~$145/月   | ~$108/月      | ~$117/月            |

※ 東京リージョン、最小インスタンス数での概算。NAT 不要（Public サブネット構成）。
IP 制限のみの場合は ALB SG で対応でき WAF 不要（中央列）。
マネージドルール（SQLi/XSS 保護）が必要な場合は WAF を追加（右列）。

### CloudFront を廃止

App Runner 時代は CloudFront が事実上必須だった（WAF アタッチ不可、カスタムドメイン制約）。
Fargate + ALB では ALB が前面に立つため、CloudFront が担っていた全機能を ALB で代替できる。

| 機能                       | App Runner 時代               | Fargate + ALB                           |
| -------------------------- | ----------------------------- | --------------------------------------- |
| SSL/TLS + カスタムドメイン | CloudFront 経由が必要         | ALB + ACM + Route53 で直接対応          |
| WAF                        | App Runner に直接アタッチ不可 | ALB に直接 WAF アタッチ可（オプション） |
| IP 制限                    | CloudFront Function で実装    | ALB の SG で対応（無料）                |
| DDoS (Shield Standard)     | CloudFront に自動適用         | ALB にも自動適用                        |
| 静的アセットキャッシュ     | CDN エッジキャッシュ          | ブラウザキャッシュのみ（後述）          |

**静的アセットのキャッシュ**: ALB 自体にはキャッシュ機能がないが、問題にならない。
Next.js の静的アセット (`/_next/static/*`) はコンテンツハッシュ付きファイル名で
`Cache-Control: public, max-age=31536000, immutable` が自動付与される。
ブラウザキャッシュにより 2 回目以降はサーバーにリクエストが飛ばないため、
国内ユーザー中心の KUKAN では CDN エッジキャッシュの恩恵は限定的。

**CloudFront を残すデメリット**:

- **構成の複雑さ**: CloudFront WAF・ACM 証明書は us-east-1 必須のため
  KukanGlobalStack とのクロスリージョン依存が発生し、2 スタック構成が必要
- **コスト増**: CloudFront → ALB のデータ転送が二重課金、WAF も二重になりうる
- **運用負荷**: リクエスト経路が 3 段（CloudFront → ALB → Fargate）になり障害切り分けが困難、
  ログも 2 箇所に分散

これに伴い以下も廃止する:

- **CloudFront ディストリビューション**: `infra/lib/constructs/cdn.ts`
- **Origin Verify Secret**: CloudFront → オリジン間のヘッダー検証
- **KukanGlobalStack** (us-east-1): CloudFront 用 ACM 証明書・WAF WebACL の管理スタック
- **CloudFront Function** (IP allowlist): ALB の SG で代替

将来グローバル配信が必要になった場合は、その時点で CloudFront を再導入する。

## 影響

- CDK: `web-service.ts` を ECS Fargate + ALB (L2) で構成
- CDK: `cdn.ts` を削除、`KukanGlobalStack` を削除（単一スタック構成）
- CDK: カスタムドメインは ALB の Listener + ACM + Route53 で直接設定
- CDK: IP 制限は ALB の SG で実装（WAF はオプション）
- CDK: AwsCustomResource（modifyListener/modifyRule）は不要
- CDK: NAT Instance / NAT Gateway を廃止（Public サブネット + `assignPublicIp: true`）
- CDK: Private サブネットを `PRIVATE_ISOLATED` に変更（DB / OpenSearch 専用）
- VPC Connector: 不要になる（Fargate は直接 VPC 内で動作）
- Origin Verify Secret: 廃止
- Docker: 変更なし（既存の `web` ターゲットをそのまま使用）

## 関連

- ADR-018（置換元）: `docs/adr/018-app-runner-plus-fargate.md`
- ADR-012（単一オリジン設計）: `docs/adr/012-api-as-library-single-origin.md`
- CDK 実装: `infra/lib/constructs/web-service.ts`
- AWS 公式: [App Runner availability change](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html)
