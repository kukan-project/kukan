# ADR-020: Web = ECS Express Mode, Worker = ECS Fargate（ADR-018 を置換）

## ステータス

**承認済み（Accepted）**

## コンテキスト

ADR-018 で Web のデプロイ先として AWS App Runner を採用したが、
AWS は 2026 年 4 月に App Runner のメンテナンスモード移行を発表した。

- 2026 年 4 月 30 日以降、新規顧客は App Runner を利用不可
- 既存顧客はセキュリティ/可用性サポート継続（新機能なし）
- AWS 推奨の移行先: **Amazon ECS Express Mode**

Worker（SQS consumer）は既に ECS Fargate で動作しており変更不要。

### 検討した選択肢

| 方式 | Web | 移行コスト | 待機コスト（small） | 備考 |
| --- | --- | --- | --- | --- |
| A | ECS Express Mode | 小 | ~$29/月 | ★ 採用。App Runner と同等の簡易デプロイ抽象化 |
| B | 標準 ECS Fargate + ALB | 中 | ~$29/月 | CDK コード量が大幅増（ALB, TG, Listener 手動構成） |
| C | Lambda + CloudFront (OpenNext) | 大 | ~$0/月 | アーキテクチャ根本変更。単一オリジン設計（ADR-012）と非互換 |
| D | App Runner 継続 | なし | ~$3/月 | 新機能なし、将来的な廃止リスク |

## 決定

**Web = ECS Express Mode、Worker = ECS Fargate Service（変更なし）** を採用する。

### Web → ECS Express Mode

ECS Express Mode は Fargate 上の簡易デプロイ抽象化レイヤーで、
App Runner と同じポジションを担う後継サービスである。

- コンテナイメージ + IAM ロール 2 つのみで ALB / SSL / Auto Scaling / ネットワークが自動構成
- CDK / CloudFormation から利用可能
- ALB 共有機能により、同一ネットワーク構成の複数サービス間でコスト分散
- 裏のリソース（ALB, ECS Service 等）に直接アクセス可能で、必要時にカスタマイズ可

### Worker → ECS Fargate Service（変更なし）

ADR-018 の決定をそのまま維持する。Express Mode は HTTP サービス向けの抽象化であり、
SQS consumer には不適:

- 不要な ALB が自動構成されコスト増（~$18/月）
- Auto Scaling が HTTP トラフィックベースで SQS キュー深度に非対応
- パブリックエンドポイントが露出しセキュリティリスク

### Express Mode が Lambda より適切な理由

- KUKAN は Hono + Next.js 単一オリジン設計（ADR-012）。Lambda 化にはアーキテクチャの根本変更が必要
- Lambda コンテナイメージのコールドスタート 1〜3 秒（Next.js standalone の場合）
- 2025 年 8 月からの INIT フェーズ課金により、Lambda のコスト優位性が低下
- Provisioned Concurrency で常時 warm にすると Fargate と同程度のコスト

## コスト影響

App Runner → ECS Express Mode への移行で、低トラフィック環境のコストが増加する。

| スケール | App Runner | Express Mode | 差額 |
| --- | --- | --- | --- |
| small（0.25 vCPU / 0.5 GB） | ~$3/月 | ~$29/月 | +$26/月 |
| medium（0.5 vCPU / 1 GB） | ~$7/月 | ~$40/月 | +$33/月 |
| large（1 vCPU / 2 GB × 2） | ~$145/月 | ~$108/月 | -$37/月 |

※ 東京リージョン、最小インスタンス数での概算。
App Runner は一時停止時の vCPU 無課金が効いていたが、Fargate には同等機能がない。
large では Fargate の vCPU 単価の安さが ALB コストを上回り逆転する。

### CloudFront を廃止

App Runner 時代は CloudFront が事実上必須だった（WAF アタッチ不可、カスタムドメイン制約）。
ECS Express Mode では ALB が前面に立つため、CloudFront が担っていた全機能を ALB で代替できる。

| 機能 | App Runner 時代 | ECS Express Mode (ALB) |
| --- | --- | --- |
| SSL/TLS + カスタムドメイン | CloudFront 経由が必要 | ALB + ACM + Route53 で直接対応 |
| WAF | App Runner に直接アタッチ不可 | ALB に直接 WAF アタッチ可 |
| IP 制限 | CloudFront Function で実装 | ALB の SG or WAF で対応 |
| DDoS (Shield Standard) | CloudFront に自動適用 | ALB にも自動適用 |
| 静的アセットキャッシュ | CDN エッジキャッシュ | ブラウザキャッシュのみ（後述） |

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
- **CloudFront Function** (IP allowlist): ALB の SG or WAF で代替

将来グローバル配信が必要になった場合は、その時点で CloudFront を再導入する。

## 影響

- CDK: `web-service.ts` を App Runner (L2 alpha) から ECS Express Mode に書き換え
- CDK: `cdn.ts` を削除、`KukanGlobalStack` を削除
- CDK: WAF・カスタムドメイン・ACM 証明書は ALB 側（`KukanStack` 内）で管理
- VPC Connector: 不要になる（Fargate は直接 VPC 内で動作）
- Origin Verify Secret: 廃止
- Docker: 変更なし（既存の `web` ターゲットをそのまま使用）

## 関連

- ADR-018（置換元）: `docs/adr/018-app-runner-plus-fargate.md`
- ADR-012（単一オリジン設計）: `docs/adr/012-api-as-library-single-origin.md`
- CDK 実装: `infra/lib/constructs/web-service.ts`（要更新）
- AWS 公式: [App Runner availability change](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html)
- AWS 公式: [ECS Express Mode overview](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-overview.html)
