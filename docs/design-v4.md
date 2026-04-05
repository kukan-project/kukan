# KUKAN（空間）— 設計方針書 v4

> **Knowledge Unified Katalog And Network**
> みんなが使えるデータカタログ — A modern alternative to CKAN
>
> ⚠️ 本文書は設計議論の経緯を保存するため、本文中に「CKANモダンクローン」「新システム」等の表現が残っています。すべて正式名称 **KUKAN** に読み替えてください。

## 1. プロジェクト概要

### 1.1 背景と動機

CKANは世界中の政府・自治体で利用されるデータカタログの事実上の標準であるが、
以下の構造的課題を抱えている:

- **技術スタックの老朽化**: Python/Flask + SQLAlchemy + Solr + Jinja2
- **パフォーマンス問題**: アーキテクチャに起因する応答速度の遅さ
- **DataStoreの実用性**: 日本語CSV等との親和性が低く、利用実績が乏しい
- **検索の限界**: メタデータのみの検索で、PDF等のデータ本体は検索不可
- **DBスキーマの肥大化**: \*\_revisionテーブル群、EAVパターンの非効率性
- **プラグイン互換性**: バージョン間で頻繁に破壊される

### 1.2 基本方針

- CKAN Action API の実用的互換性を維持し、既存データの移行を可能にする
- DataStoreを廃止し、OpenSearch統合インデックスで全リソース横断検索を実現する
- プレビュー機能はパイプライン処理時の事前生成+S3キャッシュで高品質に提供する
- AI活用により、メタデータ自動生成・PII検出・セマンティック検索を実現する
- Node.js + TypeScript によるモダンアーキテクチャで高速・軽量を実現する
- **サーバーレス（AWS）とオンプレ閉域網の両方に対応するハイブリッド設計**

### 1.3 ハイブリッド対応の設計原則

アプリケーションコードは一つ。インフラ層のみアダプターパターンで差し替える。

```
同一のアプリケーションコード + Dockerイメージ
       │
       ├─► AWS ECS Fargate + ALB (Web) + ECS Fargate (Worker) → クラウド（標準）
       ├─► Docker Compose          → オンプレ / 閉域網
       ├─► EKS                     → 大規模クラウド（将来）
       └─► ローカル (node server)   → 開発環境
```

---

## 2. 現行CKANの分析

### 2.1 技術スタック

| レイヤー         | 現行技術            | 課題                                          |
| ---------------- | ------------------- | --------------------------------------------- |
| バックエンド     | Python (Flask)      | プロセスモデルの非効率（ワーカー×メモリ消費） |
| ORM              | SQLAlchemy          | 非効率なクエリ生成、N+1問題                   |
| DB               | PostgreSQL          | ✅ 継続利用（スキーマは再設計）               |
| 検索エンジン     | Apache Solr         | Node.js親和性低、設定煩雑、ベクトル検索弱い   |
| DataStore        | PostgreSQL (別DB)   | CSV前提、日本語ヘッダー問題、利用率低         |
| キャッシュ/Queue | Redis + RabbitMQ    | 二重構成の複雑さ                              |
| テンプレート     | Jinja2              | サーバーサイドレンダリングの限界              |
| フロントエンド   | jQuery + レガシーJS | モダンUI構築が困難                            |
| プラグイン       | Python (IPlugin)    | 密結合、バージョン間互換性問題                |

### 2.2 DBスキーマの課題

**EAV（Entity-Attribute-Value）の多用**

- `package_extra` / `group_extra` はKey-Value行を大量生成
- 「特定のextra値でフィルタ」するクエリが非常に遅い（JOINの連鎖）
- PostgreSQL JSONBカラムへの統合で解決可能

**group/organizationの同居**

- `group`テーブルが`is_organization`フラグでグループと組織を兼用
- 権限モデルが異なるエンティティを1テーブルに混在
- `member`テーブルが多態的（`table_name`で'package'/'user'/'group'を判別）
- FK制約が効かず、整合性をアプリ側で保証する必要がある

**\_revisionテーブルの肥大化**

- 全主要テーブルに完全カラムコピーのrevisionテーブルが存在
- 更新のたびに全カラムの値が丸ごと複製（差分ではなくスナップショット）
- DB容量の肥大化とクエリ性能劣化の主因

**DataStore DBの分離**

- メタデータDBとDataStore DBが別PostgreSQLインスタンス
- メタデータとデータ本体のJOINが原理的に不可能

**ID体系の曖昧さ**

- UUIDとname（slug）の二重識別子体系
- APIによってどちらでも指定可能で混乱の元

### 2.3 DataStoreの実務上の問題

現行DataStoreは「CSVをPostgreSQLテーブルに変換する仕組み」だが、
日本の自治体データとの親和性が極めて低い:

**ヘッダーの問題**

- マルチラインヘッダー（結合セル前提の構造）
- 日本語カラム名（「施設名称」「所在地（住所）」等）
- 括弧・空白・特殊文字を含むヘッダー（「面積（㎡）」）
- 重複ヘッダー（「金額」列が複数存在）
- 極端に長いヘッダー（PostgreSQLカラム名として切り詰められる）

**データ構造の問題**

- ヘッダー前のタイトル行・説明行
- 末尾の合計行・注釈行
- 途中の空行・区切り行
- 数値の「,」「▲」等の日本固有表記
- 同一列でのデータ型混在

**結果**

- DataPusher/XLoaderのテーブル化が頻繁に失敗
- できあがったテーブルが元データとの対応関係不明
- データAPIの利用実績が乏しい

**根本原因**

- 自治体データはCSV/Excel以外にPDF・画像・テキスト等が多い
- DataStoreの「構造化データをRDBテーブル化する」というアプローチ自体が
  利用者のニーズ（検索・発見・プレビュー・ダウンロード）と乖離

### 2.4 API体系 — Action API

CKANのAPIは `/api/3/action/{action_name}` 形式のRPCスタイル。

**GET系（主要）**

```
package_list, package_show, package_search
resource_show, resource_search
group_list, group_show
organization_list, organization_show
tag_list, tag_show
user_show, user_list
package_autocomplete
current_package_list_with_resources
```

**CREATE/UPDATE/DELETE系（主要）**

```
package_create / update / patch / delete
resource_create / update / patch / delete
group_create / update / patch / delete / purge
organization_create / update / patch / delete / purge
user_create / update
tag_create / delete
member_create / delete
```

**レスポンス形式（互換性必須）**

```json
{
  "help": "...",
  "success": true,
  "result": { ... },
  "error": { "__type": "...", "message": "..." }
}
```

**DataStore API（廃止 → OpenSearchベースAPIに代替）**

```
datastore_create, datastore_upsert, datastore_delete
datastore_search, datastore_search_sql
datastore_info
```

### 2.5 主要Extension分析

| Extension               | 機能                       | 新版方針                     |
| ----------------------- | -------------------------- | ---------------------------- |
| ckanext-harvest         | 他CKANからのメタデータ収集 | コア機能として組み込み       |
| ckanext-spatial         | 地理空間検索・PostGIS      | コア（OpenSearch geo_shape） |
| ckanext-scheming        | カスタムメタデータスキーマ | コア機能として組み込み       |
| ckanext-dcat            | DCAT/RDFメタデータ連携     | コア機能として組み込み       |
| XLoader/DataPusher+     | 自動DataStore投入          | 廃止 → Pipeline Workerに統合 |
| ckanext-pages           | 静的ページCMS              | プラグイン                   |
| ckanext-geoview         | 地理データビューア         | プレビュー機能に統合         |
| ckanext-ldap/shibboleth | SSO認証                    | OpenID Connect で汎用化      |
| ckanext-qa              | 品質管理                   | AI品質チェックに発展         |

---

## 3. 新アーキテクチャ

### 3.1 技術スタック

| レイヤー               | 技術                        | 選定理由                                             |
| ---------------------- | --------------------------- | ---------------------------------------------------- |
| ランタイム             | Node.js v24 LTS "Krypton"   | 非同期I/O、高い並行処理性能                          |
| 言語                   | TypeScript 5.9              | 型安全、開発体験（6.0-beta→7.0 Go native移行準備中） |
| APIフレームワーク      | Hono 4.12                   | 軽量・高速・マルチランタイム                         |
| DB                     | PostgreSQL 18               | メタデータ専用（スキーマ簡素化）                     |
| ORM                    | Drizzle ORM 0.45 / 1.0-beta | 型安全・軽量・SQL近接・Aurora Data API公式対応       |
| 検索エンジン           | OpenSearch 3.x (OSS)        | 統合検索インデックス（Lucene 10、9.5x性能向上）      |
| キュー                 | SQS (AWS / ElasticMQ)       | イベント駆動パイプライン。Redis不要                  |
| キャッシュ             | lru-cache (インメモリ)      | 全環境共通。Redis不要                                |
| オブジェクトストレージ | S3互換 (AWS S3 / MinIO)     | 原本保管 + プレビューキャッシュ                      |
| フロントエンド         | React 19 + Next.js 16       | SSR/SSG・モダンUI                                    |
| UI                     | shadcn/ui + Tailwind CSS    | 柔軟・カスタマイズ性                                 |
| 認証                   | Better Auth + OIDC          | フレームワーク非依存・Drizzle ORM統合・SSO対応       |
| コンテナ               | Docker                      | 全環境共通のデプロイ単位                             |
| API仕様                | OpenAPI 3.1                 | 自動生成・互換性                                     |
| テスト                 | Vitest + Playwright         | モダンテスティング                                   |

#### バージョン詳細（2026年3月時点）

| モジュール                     | バージョン                  | 備考                                                          |
| ------------------------------ | --------------------------- | ------------------------------------------------------------- |
| Node.js                        | **v24 LTS "Krypton"**       | Active LTS（2028/4まで）。v22は Maintenance LTS               |
| TypeScript                     | **5.9.3**（安定版）         | 6.0-beta公開中（JS最終版）。7.0はGo native移行（10x高速化）   |
| Hono                           | **4.12.3**                  | Express比3.5x高速。Web Standards準拠マルチランタイム          |
| PostgreSQL                     | **18.3**                    | 最新安定版（Aurora Serverless v2はPG 16互換）                 |
| Drizzle ORM                    | **0.45.1** / **1.0.0-beta** | v1.0 RC段階。スキーマ定義+マイグレーション統合管理            |
| OpenSearch                     | **3.3.1** (OSS)             | Apache 2.0。Lucene 10ベース。v1.3比9.5x性能向上               |
| Better Auth                    | **1.x**                     | フレームワーク非依存（Hono/Next.js対応）。Drizzle ORM直接統合 |
| lru-cache                      | **11.x**                    | Node.js標準インメモリキャッシュ。Redis不要                    |
| React                          | **19.2.4**                  | Activity API、Server Components安定                           |
| Next.js                        | **16.1.6**                  | Turbopack FSキャッシュ安定化、App Router                      |
| @opensearch-project/opensearch | **3.5.1**                   | Node.js用OpenSearchクライアント                               |

> **注記**: Drizzle ORMとKyselyは両方とも0.x台だが、Drizzleはv1.0-betaに到達。
> TypeScript 7.0（Go native）リリース後はビルド速度が劇的に改善される見込み。
> OpenSearch 3.xはAWS Managed OpenSearchでもサポート開始済み。
> v3で使用していたRedis/BullMQはv4でSQS（開発環境はElasticMQ）に移行し、Redis依存を完全に排除。

### 3.2 全体構成

```
┌─────────────────────────────────────────────────────────────┐
│                     クライアント層                              │
│   Next.js (SSR/SSG) ─── React SPA ─── Mobile App            │
└───────────┬──────────────────────────────────┬──────────────┘
            │                                  │
┌───────────▼──────────┐    ┌─────────────────▼──────────────┐
│ CKAN互換 API Gateway  │    │ ネイティブ REST / GraphQL API    │
│ /api/3/action/*      │    │ /api/v1/*                      │
└───────────┬──────────┘    └─────────────────┬──────────────┘
            │                                  │
┌───────────▼──────────────────────────────────▼──────────────┐
│                    ビジネスロジック層                           │
│                                                             │
│  PackageService   ResourceService   OrganizationService     │
│  SearchService    PipelineService   HarvestService          │
│  PreviewService   AIService         AuthService             │
│  MCPService       PluginManager                             │
└──┬──────────────┬──────────────┬──────────────┬────────────┘
   │              │              │              │
┌──▼──────┐  ┌───▼──────┐  ┌───▼──────┐  ┌───▼──────────────┐
│PostgreSQL│  │OpenSearch │  │ SQS /    │  │ S3互換ストレージ   │
│          │  │ (OSS)    │  │ElasticMQ │  │                  │
│メタデータ │  │統合検索   │  │キュー    │  │原本ファイル       │
│専用      │  │インデックス│  │(Pipeline)│  │プレビューJSON    │
│          │  │全リソース │  │          │  │ページ画像        │
│          │  │横断      │  │          │  │                  │
└─────────┘  └──────────┘  └──────────┘  └──────────────────┘
```

### 3.3 3層ストレージモデル

DataStoreを廃止し、以下の3層構成とする。

**第1層: PostgreSQL — メタデータ専用**

- データセット、リソース、組織、ユーザー等のメタデータ管理
- ACID トランザクション、リレーション整合性
- 監査ログ
- DataStore用テーブルは作成しない
- TSVECTOR による全文検索フォールバック（OpenSearchなし構成用）

**第2層: OpenSearch — 統合検索インデックス**

- メタデータ + 全リソースの抽出コンテンツ
- CSV/Excelの行データ（JSON形式）
- PDFの抽出テキスト
- 画像のOCRテキスト（オプション）
- AIメタデータ（要約・自動タグ・Embedding）
- 地理空間データ（geo_shape）
- ※OpenSearch OSSはApache 2.0ライセンス、Docker環境でセルフホスト可

**第3層: S3互換ストレージ — 原本 + キャッシュ**

- 全ファイルの原本保管
- プレビューJSON（テーブルデータ用）
- PDF→ページ画像（ドキュメントプレビュー用）
- AWS S3 / MinIO / Cloudflare R2 等、S3互換APIで統一

### 3.4 Turborepoモノレポ構成

pnpm workspaces + Turborepo でモノレポ管理する。
Turborepo（Vercel開発、Rustコア）は2026年現在のJavaScript/TypeScriptモノレポのデファクトスタンダード。

**解決する問題:**

1. **ビルドの無駄排除** — 変更パッケージのみビルド。コンテンツハッシュベースキャッシュでCI高速化
2. **タスク依存関係自動整理** — `turbo.json` で依存グラフ定義。共有パッケージ → API → フロントの順に自動ビルド
3. **開発体験統一** — `turbo run dev` 一発で全サービス起動

```
ckan-modern/
├── apps/
│   ├── worker/       # Pipeline Worker (SQS consumer, ECS Fargate)
│   ├── web/          # Next.js フロントエンド + Hono API（単一オリジン）
│   └── editor/       # Data Editor UI（Next.js、独立デプロイ可能）※アドオン
├── packages/
│   ├── api/          # Hono API サーバー + Better Auth（ライブラリ）
│   ├── db/           # Drizzle スキーマ + マイグレーション + Better Auth テーブル
│   ├── shared/       # 型定義、バリデーション (Zod)、lru-cache ユーティリティ
│   ├── editor-core/  # Data Editor ビジネスロジック（スキーマ定義、正規化、参照、バージョン管理）
│   ├── search/       # SearchAdapter (OpenSearch / PostgreSQL)
│   ├── storage/      # StorageAdapter (S3 / MinIO)
│   ├── queue/        # QueueAdapter (SQS / ElasticMQ)
│   ├── ai/           # AIAdapter (Bedrock / OpenAI / Ollama / NoOp)
│   ├── quality/      # Quality Monitor（リンク切れ検出、CSV検証、メタデータ監査、PII）
│   ├── pipeline/     # パイプライン（ステップ + processResource）
│   └── ui/           # shadcn/ui コンポーネント
├── turbo.json
├── pnpm-workspace.yaml
├── compose.yml
├── Dockerfile
└── CLAUDE.md         # 開発エージェント設定
```

インフラ抽象化レイヤー（StorageAdapter、SearchAdapter、QueueAdapter、AIAdapter）が
`packages/` 配下の独立パッケージとなり、Turborepoとの相性が非常に良い。
各パッケージが独立してテスト・ビルド可能。

### 3.5 認証基盤: Better Auth + OIDC

**Better Authを選定した理由:**

| 要件                                         |   Better Auth    |      Auth.js v5       |       Keycloak       |
| -------------------------------------------- | :--------------: | :-------------------: | :------------------: |
| フレームワーク非依存（Hono + Next.js両対応） |        ✅        |   △（Next.js中心）    |          ✅          |
| Drizzle ORM直接統合（DB接続共有）            |        ✅        | △（テーブル構造固定） |          ❌          |
| OIDCクライアント（外部IdP連携）              | ✅（プラグイン） |          ✅           |          ✅          |
| 外部サービス不要（閉域網対応）               |        ✅        |          ✅           |          ✅          |
| 軽量（JVM不要）                              |        ✅        |          ✅           | ❌（512MB〜1GB RAM） |
| MITライセンス                                |        ✅        |          ✅           |      Apache 2.0      |

**Drizzle ORM統合の意味:**

認証ライブラリとアプリケーション本体が同じDBクライアントインスタンスを使い回せる。

```typescript
// packages/db/client.ts
export const db = drizzle({ connection: process.env.DATABASE_URL, schema })

// packages/api/auth.ts
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { db } from '@kukan/db' // ← 同じインスタンス

export const auth = betterAuth({
  database: drizzleAdapter(db), // アプリと同じ接続をそのまま渡す
  plugins: [oidcClient()], // OIDC外部IdP連携
})
```

メリット:

1. **スキーマ一元管理** — `packages/db/schema.ts` にusersテーブルもdatasetsテーブルも一緒に定義。`drizzle-kit generate` 一発で全テーブルマイグレーション生成
2. **コネクションプール1つ** — ECS Fargateスケールアウト時の接続数爆発を防ぐ
3. **トランザクション跨ぎ可能** — ユーザー作成と組織作成を1トランザクションで実行可能

**環境別認証構成:**

| プロファイル        | 認証方式                         | IdP                                             |
| ------------------- | -------------------------------- | ----------------------------------------------- |
| development         | Better Auth（メール/パスワード） | 不要（ローカル認証）                            |
| small               | Better Auth + OIDCプラグイン     | 任意の外部IdP                                   |
| aws-standard        | Better Auth + OIDC               | Cognito or 外部IdP                              |
| on-premise (閉域網) | Better Auth + OIDC               | **Keycloak**（LGWAN既存認証基盤統合、SAML対応） |

アプリケーション層はBetter AuthでOIDCクライアント統一実装。
IdP側だけ環境に応じて差し替える**二層構成**。

---

## 4. ハイブリッドデプロイ設計

### 4.1 デプロイプロファイル

```typescript
export const profiles = {
  // 開発環境
  development: {
    runtime: 'node', // ローカル node server
    database: 'postgres', // Docker Compose
    search: 'postgres', // OpenSearch 不要で開発可
    storage: 'minio', // ローカル MinIO
    queue: 'sqs', // SQS互換（ローカルは ElasticMQ via Docker Compose）
    ai: 'none',
    auth: 'better-auth', // メール/パスワード（外部IdP不要）
    scheduler: 'node-cron', // 品質チェック定期実行（プロセス内）
  },

  // 小規模（最小コスト）
  small: {
    runtime: 'node', // ECS Fargate + ALB or Docker Compose
    database: 'aurora-serverless', // or postgres
    search: 'postgres', // OpenSearch なし
    storage: 's3', // or minio
    queue: 'sqs', // SQS → Worker（小規模でもイベント駆動）
    ai: 'none', // or bedrock
    auth: 'better-auth', // + OIDC プラグイン（外部IdP連携時）
    scheduler: 'node-cron', // 品質チェック定期実行（プロセス内）
  },

  // 中規模（AWS ECS Fargate + ALB — 標準推奨）
  'aws-standard': {
    runtime: 'node', // ECS Fargate + ALB (web) + ECS Fargate (worker)
    database: 'aurora-serverless',
    search: 'opensearch', // OpenSearch Managed
    storage: 's3',
    queue: 'sqs', // API → SQS → Worker（イベント駆動分離）
    ai: 'bedrock',
    auth: 'better-auth', // + OIDC（Cognito or 外部IdP連携）
    scheduler: 'eventbridge', // EventBridge Scheduler → SQS → Worker
  },

  // 大規模（ECS/EKS — 将来のスケールアップ先）
  'aws-large': {
    runtime: 'node', // ECS Fargate or EKS
    database: 'aurora-serverless',
    search: 'opensearch',
    storage: 's3',
    queue: 'sqs', // SQS + 複数Worker
    ai: 'bedrock',
    auth: 'better-auth', // + OIDC
    scheduler: 'eventbridge', // EventBridge Scheduler → SQS → Worker
  },

  // オンプレ閉域網
  'on-premise': {
    runtime: 'node', // Docker Compose
    database: 'postgres',
    search: 'opensearch', // OpenSearch OSS (Docker) or 'postgres'
    storage: 'minio',
    queue: 'sqs', // SQS互換（オンプレは ElasticMQ via Docker Compose）
    ai: 'ollama', // or 'none'
    auth: 'better-auth', // + OIDC（Keycloak IdP連携）
    scheduler: 'node-cron', // 品質チェック定期実行（プロセス内）
  },
}
```

**キャッシュ戦略**: 全環境共通で `lru-cache`（Node.jsインメモリLRUキャッシュ）を使用。
Redis不要。将来Redisが必要になった時点でCacheAdapter抽象化に昇格。

### 4.2 AWS 構成（標準推奨）

Web / Worker ともに ECS Fargate で運用する。Web は ALB 経由でリクエストを受ける。

```
┌───────────────────────────────────────────────────────────┐
│ AWS                                                        │
│                                                            │
│  Route53 → ALB (ACM証明書)                                  │
│               │                                            │
│  ┌────────────▼──────────────────────────────────────┐    │
│  │ VPC                                                │    │
│  │                                                    │    │
│  │  ┌──────────────────────┐                          │    │
│  │  │ ECS Fargate "web"    │                          │    │
│  │  │                      │                          │    │
│  │  │ Hono API Server      │                          │    │
│  │  │ + Next.js SSR        │                          │    │
│  │  │ + CKAN互換APIレイヤー  │                          │    │
│  │  │ + Better Auth (認証)  │                          │    │
│  │  │                      │                          │    │
│  │  │ 0.25vCPU / 0.5GB     │                          │    │
│  │  │ min:1 max:10         │                          │    │
│  │  │ Auto Scaling          │                          │    │
│  │  └────┬─────────────────┘                          │    │
│  │       │                                            │    │
│  │       │ SQS.sendMessage({ resourceId })            │    │
│  │       ▼                                            │    │
│  │  ┌─────────────────┐                               │    │
│  │  │ SQS キュー       │  ← メッセージ保持最大14日       │    │
│  │  │ + DLQ (Dead      │  ← 失敗時自動リトライ          │    │
│  │  │   Letter Queue)  │  ← 月100万リクエスト無料       │    │
│  │  └────┬────────────┘                               │    │
│  │       │ ロングポーリング                              │    │
│  │       ▼                                            │    │
│  │  ┌──────────────────┐  ┌────────────────────────┐ │    │
│  │  │ ECS Fargate      │  │ Aurora Serverless v2   │ │    │
│  │  │ "worker"         │  │ (PostgreSQL)           │ │    │
│  │  │                  │  │                        │ │    │
│  │  │ Pipeline Worker  │  │ 0.5〜N ACU             │ │    │
│  │  │ (SQSポーリング)   │  └────────────────────────┘ │    │
│  │  │                  │                              │    │
│  │  │ 1vCPU / 2GB      │                              │    │
│  │  │ desiredCount: 1  │                              │    │
│  │  └──────────────────┘                              │    │
│  │                                                    │    │
│  │  ┌────────────────────────────────────────────┐   │    │
│  │  │ OpenSearch Managed                          │   │    │
│  │  │ ※小規模ならPostgreSQLフォールバックで省略可  │   │    │
│  │  └────────────────────────────────────────────┘   │    │
│  └────────────────────────────────────────────────────┘    │
│                                                            │
│  ┌──────────┐                                              │
│  │ S3       │ ← 原本ファイル + プレビューParquet            │
│  └──────────┘   S3 Gateway VPC Endpoint経由                 │
└───────────────────────────────────────────────────────────┘
```

**Web に ECS Fargate + ALB を選定した理由**

- Honoの同一Dockerイメージがオンプレ/Docker Composeとそのまま共通
- ALB でカスタムドメイン + ACM 証明書を直接設定（CloudFront 不要）
- ALB の SG で IP 制限を直接制御（WAF はオプション）
- CDK L2 コンストラクトで型安全に構成可能
- `autoScaleTaskCount` でリクエスト数ベースの Auto Scaling
- 元は App Runner を採用していたが、AWS のメンテナンスモード移行に伴い ECS Fargate + ALB に移行（ADR-020 参照）

**Worker に ECS Fargate を選定した理由**

- Worker は純粋な SQS コンシューマー（HTTP エンドポイント不要）
- ECS Fargate はコマンドベースのヘルスチェックが可能（ポート公開不要）
- SQS メッセージ数に応じた ECS Service Auto Scaling が自然にフィット

**APIとWorkerを分離する理由**

スケール特性が根本的に異なる:

|                | API                             | Worker                         |
| -------------- | ------------------------------- | ------------------------------ |
| トリガー       | ユーザーHTTPリクエスト          | ファイルアップロードイベント   |
| 頻度           | 常時（検索、閲覧、API呼び出し） | 散発的（日に数回〜数十回）     |
| レイテンシ要件 | 低レイテンシ必須（100ms以内）   | 数秒〜数十秒かかっても問題ない |
| CPU特性        | 軽い（DB/検索プロキシ）         | 重い（CSV解析、AI呼び出し）    |
| スペック       | 0.25vCPU/0.5GBで十分            | 1vCPU/2GB欲しい                |

SQSによるイベント駆動分離で、重いCSV処理がAPI側レスポンスに影響しない。
Workerが落ちていてもメッセージはキューに残り、復帰後に自動処理再開。

### 4.3 オンプレ / 閉域網構成

```
┌──────────────────────────────────────────────────────┐
│ Docker Compose                                        │
│                                                       │
│  ┌────────────┐  ┌────────────┐                      │
│  │ Nginx      │  │ App        │                      │
│  │ (リバプロ)  │  │ (Hono on   │                      │
│  │            │  │  Node.js)  │                      │
│  └─────┬──────┘  └─────┬──────┘                      │
│        │               │                              │
│  ┌─────▼──────────────▼─────────────────────────────┐│
│  │  内部ネットワーク                                   ││
│  └──┬──────────┬──────────┬─────────────────────────┘│
│     │          │          │                           │
│  ┌──▼───┐  ┌──▼──────┐ ┌▼─────────────┐            │
│  │Postgre│  │OpenSearch│ │MinIO         │            │
│  │SQL    │  │ OSS     │ │(S3互換)       │            │
│  └───────┘  └─────────┘ └──────────────┘            │
└──────────────────────────────────────────────────────┘

特徴:
  - Redis不要 → ElasticMQ（SQS互換キュー、Docker Compose）
  - コンテナレジストリ: 内部 Harbor 等
  - 外部アクセスなし: 事前ビルド済みイメージ使用
  - TLS証明書: 自己署名 or 内部CA
  - AI機能: ローカル LLM (Ollama) or 無効化
  - 認証: Better Auth + OIDC（Keycloak IdP連携）
  - キャッシュ: lru-cache（インメモリ、全環境共通）
```

### 4.4 コスト概算

**AWS ECS Fargate + ALB 構成（中規模・OpenSearchあり）**

| 構成要素                                 | 月額概算                     |
| ---------------------------------------- | ---------------------------- |
| ECS Fargate "web" (0.25vCPU/0.5GB)       | ~$12                         |
| ALB                                      | ~$18                         |
| ECS Fargate "worker" (1vCPU/2GB)         | ~$38                         |
| Aurora Serverless v2 (0.5 ACU min)       | ~$73                         |
| SQS                                      | ~$0（月100万リクエスト無料） |
| S3                                       | ~$3                          |
| OpenSearch Managed (t3.small)            | ~$26                         |
| **合計**                                 | **~$170/月**                 |

**小規模構成（OpenSearchなし）**

| 構成要素                                 | 月額概算     |
| ---------------------------------------- | ------------ |
| ECS Fargate "web" (0.25vCPU/0.5GB)       | ~$12         |
| ALB                                      | ~$18         |
| ECS Fargate "worker" (1vCPU/2GB)         | ~$38         |
| Aurora Serverless v2 (0.5 ACU min)       | ~$73         |
| SQS                                      | ~$0          |
| S3                                       | ~$3          |
| **合計**                                 | **~$144/月** |

※v3（Redis/ElastiCache込み ~$160/月）と同等水準
※ECS Fargate はタスク常時課金（App Runner のような pause-on-idle はなし）
※NAT Gateway 不要（Public サブネット構成）、CloudFront 不要（ALB が前面）でコスト抑制
※コスト詳細は ADR-020 参照

**オンプレ構成**

サーバー1台（4〜8GBメモリ）で全コンポーネント稼働可能。
Redis不要のため、Docker Composeのコンテナ数が減り運用がさらに簡素化。
クラウドランニングコストなし。

---

## 5. インフラ抽象化レイヤー

### 5.1 アダプターインターフェース

環境によって実装が変わるものだけを抽象化する。全4アダプター:

```typescript
// ============================================================
// ストレージ（S3互換APIで統一）
// ============================================================
interface StorageAdapter {
  put(key: string, data: Buffer | Readable, options?: PutOptions): Promise<void>
  get(key: string): Promise<{ data: Readable; metadata: ObjectMetadata }>
  delete(key: string): Promise<void>
  exists(key: string): Promise<boolean>
  head(key: string): Promise<ObjectMetadata>
  list(prefix: string, options?: ListOptions): AsyncIterable<StorageObject>
  copy(sourceKey: string, destKey: string): Promise<void>
  getDownloadUrl(key: string, options?: UrlOptions): Promise<string>
  getUploadUrl(key: string, options?: UploadUrlOptions): Promise<UploadInstruction>
}

interface UploadInstruction {
  method: 'presigned-put' | 'presigned-post' | 'server-proxy'
  url: string
  headers?: Record<string, string>
  fields?: Record<string, string>
  expiresAt: Date
  maxSize?: number
}

// ============================================================
// 検索エンジン（ADR-009, ADR-013 参照）
// ============================================================
interface SearchAdapter {
  search(query: SearchQuery): Promise<SearchResult>
  index(doc: DatasetDoc): Promise<void>
  delete(id: string): Promise<void>
  bulkIndex(docs: DatasetDoc[]): Promise<void>
  deleteAll(): Promise<void>
}

// AppContext には search（設定に従う）と dbSearch（常に PostgreSQL）の
// 2つの SearchAdapter を注入。ダッシュボード（my_org=true）は dbSearch を使用し
// DB との一貫性を保証する。詳細は ADR-013 参照。

// ============================================================
// AI / Embedding
// ============================================================
interface AIAdapter {
  generateEmbedding(text: string): Promise<number[]>
  detectPII(text: string): Promise<PIIDetection[]>
  inferSchema(headers: string[], sampleRows: any[][]): Promise<SchemaInference>
  summarize(text: string): Promise<string>
}

// ============================================================
// キュー（パイプラインジョブのイベント駆動）
// ============================================================
interface QueueAdapter {
  send(job: { type: string; payload: unknown }): Promise<void>
  consume(handler: (job: { type: string; payload: unknown }) => Promise<void>): void
  close(): Promise<void>
}
```

**キュー実装一覧**

| 環境         | QueueAdapter    | Worker分離                   |
| ------------ | --------------- | ---------------------------- |
| development  | SqsQueueAdapter | Worker プロセス（ElasticMQ） |
| small        | SqsQueueAdapter | Worker プロセス（SQS）       |
| aws-standard | SqsQueueAdapter | **ECS Fargate Worker**       |
| aws-large    | SqsQueueAdapter | **ECS/EKS Worker**           |
| on-premise   | SqsQueueAdapter | Worker プロセス（ElasticMQ） |

```typescript
// --- SQS実装 (AWS) ---
class SqsQueueAdapter implements QueueAdapter {
  async send(job) {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(job),
      })
    )
  }
  consume(handler) {
    // SQSロングポーリングループ（Worker側で呼び出し）
    this.poll(handler)
  }
}

// 開発・オンプレ環境では ElasticMQ (SQS互換) を使用。
// SqsQueueAdapter がそのまま動作するため、環境変数 SQS_QUEUE_URL のみ変更。
// 例: SQS_QUEUE_URL=http://localhost:9324/queue/kukan-pipeline

// --- BullMQ実装 (大規模オンプレ・将来) ---
class BullMQQueueAdapter implements QueueAdapter {
  /* Redis + BullMQ */
}
```

**キャッシュ**: 抽象化不要（全環境共通で `lru-cache` を使用）

```typescript
// packages/shared/cache.ts
import { LRUCache } from 'lru-cache'

const cache = new LRUCache<string, unknown>({
  max: 1000,
  ttl: 1000 * 60 * 5, // 5分
})

export const appCache = {
  get: <T>(key: string) => cache.get(key) as T | undefined,
  set: (key: string, value: unknown) => cache.set(key, value),
  del: (key: string) => cache.delete(key),
}
```

将来Redisキャッシュが本当に必要になった時点で `CacheAdapter` に昇格させる。

### 5.2 ストレージ統一実装

S3 APIが業界標準であるため、**1クラスで全環境対応**できる。

```typescript
class S3CompatStorageAdapter implements StorageAdapter {
  private client: S3Client
  private bucket: string
  private publicBaseUrl?: string

  constructor(config: StorageConfig) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint, // ← 環境差はここだけ
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      forcePathStyle: config.forcePathStyle,
    })
    this.bucket = config.bucket
    this.publicBaseUrl = config.publicBaseUrl
  }

  // put, get, delete, getDownloadUrl, getUploadUrl ...
  // 全メソッドが AWS SDK S3 Client 経由 → S3/MinIO/R2 全対応
}
```

各環境の設定値:

```typescript
// AWS S3
{ endpoint: undefined, region: 'ap-northeast-1', forcePathStyle: false }

// MinIO (オンプレ / Docker)
{ endpoint: 'http://minio:9000', region: 'us-east-1', forcePathStyle: true }

// Cloudflare R2
{ endpoint: 'https://{account}.r2.cloudflarestorage.com', forcePathStyle: false }
```

**MinIO** はS3互換のオブジェクトストレージOSS（Go製、Apache 2.0ライセンス）。
Docker Composeで `minio/minio` イメージを起動するだけで、
AWS S3と全く同じAPIがオンプレ上で利用可能。管理UIも付属。

### 5.3 検索フォールバック

PostgreSQLのみで最低限の検索を動作させる:

```typescript
class PostgresSearchAdapter implements SearchAdapter {
  // メタデータ全文検索 → TSVECTOR
  // ファセット → GROUP BY + COUNT
  // リソース内検索 → metadata JSONB
  // ベクトル検索 → pgvector 拡張（オプション）
}
```

| 機能                  | PG検索 (最小) | OpenSearch (フル) |
| --------------------- | :-----------: | :---------------: |
| メタデータ全文検索    |      ✅       |        ✅         |
| ファセット検索        | ✅ (GROUP BY) | ✅ (Aggregations) |
| CSV/Excelヘッダー検索 |  ✅ (JSONB)   |        ✅         |
| CSV行データ検索       |  △ (制限的)   |        ✅         |
| PDF本文検索           |      ❌       |        ✅         |
| セマンティック検索    | △ (pgvector)  |     ✅ (kNN)      |
| 地理空間検索          | ✅ (PostGIS)  |  ✅ (geo_shape)   |
| 日本語形態素解析      |  △ (pg_trgm)  |   ✅ (kuromoji)   |

小規模自治体はPostgreSQLのみで開始し、必要に応じてOpenSearchを追加する
**段階的スケールアップ**が可能。

### 5.4 AI アダプター

```typescript
class OpenAIAdapter implements AIAdapter {
  /* OpenAI API / Azure OpenAI */
}
class BedrockAdapter implements AIAdapter {
  /* AWS Bedrock */
}
class OllamaAdapter implements AIAdapter {
  /* ローカル LLM (閉域網用) */
}
class NoOpAIAdapter implements AIAdapter {
  // AI機能無効 — 全メソッドがスキップ or デフォルト値返却
  // 最小構成・閉域網で外部API不可の場合
}
```

### 5.5 バケット構造

```
bucket/
  ├── resources/                    # 原本ファイル（アップロード or 外部 URL から取得）
  │   └── {packageId}/{resourceId}
  ├── previews/                     # プレビュー Parquet（ADR-014）
  │   └── {packageId}/{resourceId}.parquet
  ├── thumbnails/                   # サムネイル・ページ画像（Phase 5+）
  │   └── {resourceId}/
  │       ├── thumb.webp
  │       ├── page-001.webp
  │       └── page-002.webp
  └── exports/                      # エクスポートファイル（一時）
      └── {job_id}/{filename}
```

---

## 6. DBスキーマ設計

### 6.1 設計方針

- コアテーブル名は維持（package, resource, group 等）→ 移行容易性
- `*_revision` テーブル群を全廃 → `audit_log` に統合
- `package_extra` / `group_extra` を廃止 → JSONB `extras` カラムに統合
- `member` テーブルの多態性を解消 → 用途別テーブルに分離
- DataStore関連テーブルを全廃

### 6.2 コアスキーマ

```sql
-- ============================================================
-- 組織
-- ============================================================
CREATE TABLE organization (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(100) UNIQUE NOT NULL,  -- slug
  title         TEXT,
  description   TEXT,
  image_url     TEXT,
  state         VARCHAR(20) DEFAULT 'active',
  extras        JSONB DEFAULT '{}',
  created       TIMESTAMPTZ DEFAULT NOW(),
  updated       TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- グループ（組織と分離）
-- ============================================================
CREATE TABLE "group" (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(100) UNIQUE NOT NULL,
  title         TEXT,
  description   TEXT,
  image_url     TEXT,
  state         VARCHAR(20) DEFAULT 'active',
  extras        JSONB DEFAULT '{}',
  created       TIMESTAMPTZ DEFAULT NOW(),
  updated       TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ユーザー
-- ============================================================
CREATE TABLE "user" (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(100) UNIQUE NOT NULL,
  email         VARCHAR(200) UNIQUE,
  display_name  TEXT,
  password_hash TEXT,
  state         VARCHAR(20) DEFAULT 'active',
  sysadmin      BOOLEAN DEFAULT FALSE,
  created       TIMESTAMPTZ DEFAULT NOW(),
  updated       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE api_token (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name          VARCHAR(200),
  token_hash    TEXT NOT NULL,
  last_used     TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  created       TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- データセット（= CKAN package）
-- ============================================================
CREATE TABLE package (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(100) UNIQUE NOT NULL,
  title            TEXT,
  notes            TEXT,
  url              TEXT,
  version          VARCHAR(100),
  license_id       VARCHAR(100),
  author           TEXT,
  author_email     TEXT,
  maintainer       TEXT,
  maintainer_email TEXT,
  state            VARCHAR(20) DEFAULT 'active',
  type             VARCHAR(100) DEFAULT 'dataset',
  owner_org        UUID REFERENCES organization(id),
  private          BOOLEAN DEFAULT FALSE,
  creator_user_id  UUID REFERENCES "user"(id),
  extras           JSONB DEFAULT '{}',

  -- 新機能拡張フィールド
  spatial_coverage   GEOMETRY(Geometry, 4326),
  temporal_start     TIMESTAMPTZ,
  temporal_end       TIMESTAMPTZ,
  quality_score      FLOAT,
  ai_summary         TEXT,
  ai_tags            TEXT[],

  created            TIMESTAMPTZ DEFAULT NOW(),
  updated            TIMESTAMPTZ DEFAULT NOW(),

  -- PostgreSQL全文検索（フォールバック用）
  search_vector      TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(notes, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(extras::text, '')), 'C')
  ) STORED
);
CREATE INDEX idx_package_search ON package USING GIN(search_vector);
CREATE INDEX idx_package_owner_org ON package(owner_org);
CREATE INDEX idx_package_state ON package(state);
CREATE INDEX idx_package_extras ON package USING GIN(extras);

-- ============================================================
-- リソース
-- ============================================================
CREATE TABLE resource (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id      UUID NOT NULL REFERENCES package(id) ON DELETE CASCADE,
  url             TEXT,
  name            TEXT,
  description     TEXT,
  format          VARCHAR(100),
  mimetype        VARCHAR(200),
  size            BIGINT,
  hash            TEXT,
  position        INTEGER DEFAULT 0,
  state           VARCHAR(20) DEFAULT 'active',
  resource_type   VARCHAR(50),
  extras          JSONB DEFAULT '{}',

  -- 処理状態は resource_pipeline テーブルに分離（Phase 3 で移行済み）
  -- AI 分析結果は Phase 5 で resource_pipeline.metadata に格納予定

  -- Quality Monitor（品質監視）
  health_status      VARCHAR(20) DEFAULT 'unknown',  -- 'ok' | 'warning' | 'error' | 'unknown'
  health_checked_at  TIMESTAMPTZ,
  quality_issues     JSONB DEFAULT '[]',              -- 最新の品質問題リスト

  created         TIMESTAMPTZ DEFAULT NOW(),
  updated         TIMESTAMPTZ DEFAULT NOW(),
  last_modified   TIMESTAMPTZ
);
CREATE INDEX idx_resource_package ON resource(package_id);
CREATE INDEX idx_resource_format ON resource(format);

-- ============================================================
-- タグ
-- ============================================================
CREATE TABLE vocabulary (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(200) UNIQUE NOT NULL
);

CREATE TABLE tag (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(200) NOT NULL,
  vocabulary_id   UUID REFERENCES vocabulary(id),
  UNIQUE(name, vocabulary_id)
);

CREATE TABLE package_tag (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id      UUID NOT NULL REFERENCES package(id) ON DELETE CASCADE,
  tag_id          UUID NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  UNIQUE(package_id, tag_id)
);

-- ============================================================
-- メンバーシップ（多態性を解消し用途別に分離）
-- ============================================================
CREATE TABLE user_org_membership (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  role            VARCHAR(50) NOT NULL DEFAULT 'member',
  created         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, organization_id)
);

CREATE TABLE user_group_membership (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  group_id        UUID NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
  role            VARCHAR(50) NOT NULL DEFAULT 'member',
  created         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, group_id)
);

CREATE TABLE package_group (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id      UUID NOT NULL REFERENCES package(id) ON DELETE CASCADE,
  group_id        UUID NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
  UNIQUE(package_id, group_id)
);

-- ============================================================
-- 監査ログ（*_revision テーブル群の代替）
-- ============================================================
CREATE TABLE audit_log (
  id              BIGSERIAL PRIMARY KEY,
  entity_type     VARCHAR(50) NOT NULL,
  entity_id       UUID NOT NULL,
  action          VARCHAR(20) NOT NULL,
  user_id         UUID REFERENCES "user"(id),
  changes         JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_audit_entity
  ON audit_log(entity_type, entity_id, created_at DESC);

-- ============================================================
-- アクティビティストリーム
-- ============================================================
CREATE TABLE activity (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES "user"(id),
  object_id       UUID NOT NULL,
  object_type     VARCHAR(50) NOT NULL,
  activity_type   VARCHAR(100) NOT NULL,
  data            JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_activity_object
  ON activity(object_type, object_id, created_at DESC);

-- ============================================================
-- Harvest
-- ============================================================
CREATE TABLE harvest_source (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url             TEXT NOT NULL,
  title           TEXT,
  type            VARCHAR(50) NOT NULL,
  config          JSONB DEFAULT '{}',
  active          BOOLEAN DEFAULT TRUE,
  organization_id UUID REFERENCES organization(id),
  created         TIMESTAMPTZ DEFAULT NOW(),
  updated         TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE harvest_job (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       UUID NOT NULL REFERENCES harvest_source(id),
  status          VARCHAR(20) DEFAULT 'pending',
  gather_started  TIMESTAMPTZ,
  gather_finished TIMESTAMPTZ,
  import_started  TIMESTAMPTZ,
  import_finished TIMESTAMPTZ,
  stats           JSONB,
  created         TIMESTAMPTZ DEFAULT NOW()
);
```

### 6.3 Quality Monitor テーブル

```sql
-- ============================================================
-- 品質チェック結果
-- ============================================================
CREATE TABLE quality_check (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  check_type      VARCHAR(50) NOT NULL,  -- 'health_check' | 'csv_validation' | 'metadata_audit' | 'pii_scan'
  resource_id     UUID REFERENCES resource(id) ON DELETE CASCADE,
  dataset_id      UUID REFERENCES package(id) ON DELETE CASCADE,
  organization_id UUID REFERENCES organization(id),
  status          VARCHAR(20) NOT NULL,  -- 'ok' | 'warning' | 'error'
  details         JSONB NOT NULL,        -- チェック種別ごとの詳細結果
  checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,           -- 問題解決日時
  resolved_by     UUID REFERENCES "user"(id)
);

CREATE INDEX idx_quality_check_resource ON quality_check(resource_id, check_type);
CREATE INDEX idx_quality_check_org ON quality_check(organization_id, status);
CREATE INDEX idx_quality_check_date ON quality_check(checked_at DESC);

-- ============================================================
-- 品質スコア履歴（日次集計）
-- ============================================================
CREATE TABLE quality_score_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organization(id),
  date            DATE NOT NULL,
  total_resources INTEGER NOT NULL,
  healthy_count   INTEGER NOT NULL,
  broken_links    INTEGER NOT NULL,
  csv_errors      INTEGER NOT NULL,
  metadata_completeness NUMERIC(5,2),  -- 0.00〜100.00
  pii_warnings    INTEGER NOT NULL,
  overall_score   NUMERIC(5,2),        -- 0.00〜100.00
  UNIQUE(organization_id, date)
);
```

---

## 7. パイプライン

### 7.1 設計方針

パイプライン処理は**ステップ分割**で設計する。
各ステップは独立したビジネスロジック（全環境共通）で、
キューイング（QueueAdapter）だけが環境によって異なる。

```
pipeline/
  ├── steps/                          # ビジネスロジック（全環境共通）
  │   ├── analyze.ts                  # ファイル種別判定、処理プラン決定
  │   ├── extract.ts                  # コンテンツ抽出
  │   │   ├── tabular.ts              #   CSV/Excel処理
  │   │   ├── document.ts             #   PDF処理
  │   │   ├── geospatial.ts           #   GeoJSON処理
  │   │   └── image.ts                #   画像処理
  │   ├── preview.ts                  # プレビューJSON生成 → S3保存
  │   ├── ai.ts                       # スキーマ推定、PII検出、要約、Embedding
  │   └── index.ts                    # OpenSearchインデックス、PostgreSQL更新
  │
  └── process-resource.ts             # 全ステップを順次実行する統合関数
```

### 7.2 ステップ定義

```typescript
interface PipelineStep<TInput, TOutput> {
  name: string
  execute(input: TInput, ctx: ServiceContext): Promise<TOutput>
}

// Analyze → Extract → Preview → AI → Index
const PIPELINE_STEPS = [analyzeStep, extractStep, previewStep, aiStep, indexStep]

// 全ステップを順次実行する統合関数
async function processResource(resourceId: string, ctx: ServiceContext) {
  await db
    .update(schema.resources)
    .set({ status: 'processing' })
    .where(eq(schema.resources.id, resourceId))

  try {
    const analyzed = await analyzeStep.execute({ resourceId }, ctx)
    const extracted = await extractStep.execute(analyzed, ctx)
    const previewed = await previewStep.execute(extracted, ctx)
    const aiResult = await aiStep.execute(previewed, ctx)
    await indexStep.execute(aiResult, ctx)

    await db
      .update(schema.resources)
      .set({ status: 'complete' })
      .where(eq(schema.resources.id, resourceId))
  } catch (err) {
    await db
      .update(schema.resources)
      .set({ status: 'error', error: String(err) })
      .where(eq(schema.resources.id, resourceId))
    throw err // QueueAdapter側でリトライ判断
  }
}
```

### 7.3 全体フロー

```
ユーザーがファイルをアップロード
       │
       ▼
  API Server (ECS Fargate "web")
  「resourceレコード作成、S3にPresigned URL発行、即座にレスポンス返却」
  → ユーザーには「アップロード完了、処理中」と表示
       │
  クライアントがPresigned URLにファイルをPUT
       │
  アップロード完了通知
       │
       ▼
  QueueAdapter.send({ type: 'resource-pipeline', payload: { resourceId } })
       │
       ├─ [AWS] SQS キュー → ECS Fargate "worker" がロングポーリングで受信
       │                     → processResource(resourceId) 実行
       │
       └─ [開発/オンプレ] ElasticMQ → Worker プロセスがロングポーリングで受信
       │
       ├── Step 1: Analyze（軽量）
       │   ファイル種別判定、サイズ確認、処理プラン決定
       │
       ├── Step 2: Extract（中〜重量）
       │   コンテンツ抽出（CSV→JSON、PDF→テキスト等）
       │
       ├── Step 3: Preview（中量）
       │   プレビューJSON生成、サムネイル生成 → S3保存
       │
       ├── Step 4: AI（中量、オプション）
       │   スキーマ推定、PII検出、要約、Embedding生成
       │   ※NoOpAIAdapterならスキップ
       │
       └── Step 5: Index（軽量）
           OpenSearchインデックス投入、PostgreSQL resource更新
           status = 'complete'
       │
       ▼
  ユーザーの画面が自動更新（SSE or ポーリング）
  → プレビューが表示される
```

### 7.4 API → キュー → Worker 実装

**API側（ジョブ投入）:**

```typescript
// packages/api/routes/resources.ts
app.post('/datasets/:id/resources', async (c) => {
  const file = await c.req.file('file')
  const s3Key = await storage.upload(file)
  const resource = await db
    .insert(schema.resources)
    .values({
      datasetId,
      s3Key,
      status: 'pending',
    })
    .returning()

  // QueueAdapter経由でイベントキック
  await queue.send({
    type: 'resource-pipeline',
    payload: { resourceId: resource.id },
  })

  return c.json(resource, 202) // Accepted
})
```

**Worker側（SQS版 — AWS環境）:**

```typescript
// apps/worker/main.ts
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { SqsQueueAdapter } from '@ckan-modern/queue'
import { processResource } from '@ckan-modern/pipeline'

// Honoサーバー（ECS Fargateヘルスチェック用）
const app = new Hono()
app.get('/health', (c) => c.json({ status: 'ok' }))
serve(app, { port: 8080 })

// SQSコンシューマー起動
const queue = new SqsQueueAdapter({
  queueUrl: process.env.PIPELINE_QUEUE_URL!,
})

queue.consume(async (job) => {
  if (job.type === 'resource-pipeline') {
    const { resourceId } = job.payload as { resourceId: string }
    await processResource(resourceId, serviceContext)
  }
})
```

**SQSが「ちょうどいい」理由:**

- Workerが落ちていてもメッセージはキューに残る（最大14日保持）
- 処理失敗時、可視性タイムアウト後に自動再配信（リトライ）
- 何度も失敗したらDLQ（Dead Letter Queue）に退避
- **コスト: 月100万リクエストまで無料** → 自治体ポータル規模なら永久に$0
- Redis/ElastiCache不要 → インフラ大幅簡素化

**開発・オンプレ環境:**

開発環境では Docker Compose で ElasticMQ（SQS互換）を起動。
`SqsQueueAdapter` がそのまま動作し、Worker プロセスが独立してロングポーリングする。

```yaml
# compose.yml
elasticmq:
  image: softwaremill/elasticmq-native
  ports:
    - '9324:9324'
```

Redis不要、Worker分離不要。APIプロセス内で直接処理。

### 7.5 ファイル種別ごとの処理

| 種別              | 抽出処理                 | プレビュー               | OpenSearch格納               |
| ----------------- | ------------------------ | ------------------------ | ---------------------------- |
| CSV/TSV           | スマートパース           | テーブルJSON             | ヘッダー + 全行データ + 全文 |
| Excel             | シート別パース           | テーブルJSON（シート別） | 同上                         |
| PDF               | テキスト抽出             | ページ画像化             | 抽出テキスト全文             |
| 画像              | EXIF + OCR（オプション） | サムネイル生成           | OCRテキスト + EXIF           |
| GeoJSON/Shapefile | GeoJSON正規化            | 地図プレビュー           | geo_shape + 属性             |
| XML/JSON          | 構造解析                 | ツリービュー             | テキスト化                   |
| テキスト/HTML     | そのまま                 | テキスト/HTMLビュー      | 全文                         |
| その他            | なし                     | ダウンロードのみ         | ファイル名・メタのみ         |

### 7.6 スマートパーサー（日本の自治体CSV対応）

```typescript
interface StructureAnalysis {
  detected_header_row: number
  multi_line_header: boolean
  header_rows: number[]

  skipped_prefix_rows: number[] // タイトル・説明行
  skipped_suffix_rows: number[] // 合計・注釈行

  headers: {
    original: string // "施設名称（通称含む）"
    display: string // 表示用（原本まま）
    normalized: string // "facility_name"（AI推定）
    inferred_type: ColumnType // "text" | "number" | "date"
    duplicate_index?: number // 重複時の連番
    width_hint: number
  }[]

  value_transforms: {
    column_index: number
    patterns: {
      pattern: string // "▲{n}" → negative number
      transform: string
    }[]
  }[]
}
```

パース戦略:

1. ヘッダー行検出（マルチライン対応）
2. データ開始行検出（タイトル・説明行スキップ）
3. フッター検出（「合計」「注」「※」「出典」等）
4. 重複ヘッダー解決
5. 型推定（"1,234"→number、"▲500"→number、"R5.4.1"→date、"-"→null）

### 7.7 プレビューデータ

```typescript
interface PreviewData {
  resource_id: string
  format: string
  generated_at: string

  table?: {
    sheets: {
      name: string
      structure: StructureAnalysis
      rows: any[][] // 先頭200行
      total_rows: number
      column_stats?: ColumnStat[]
    }[]
  }

  document?: {
    page_count: number
    page_image_keys: string[]
    extracted_text_preview: string // 先頭2000文字
  }

  image?: {
    thumbnail_key: string
    width: number
    height: number
    exif?: Record<string, any>
  }

  geospatial?: {
    type: string
    feature_count: number
    bbox: [number, number, number, number]
    sample_features: any[] // 先頭20フィーチャー
  }

  ai_notes?: string[] // AIが検出した注意点
}
```

プレビューJSONはS3に保存し、CDN経由で配信。
表示時にDBアクセスもOpenSearchアクセスも不要。
フィルタ・ソートは200行に対しクライアントサイドJSで実行。

---

## 8. OpenSearch 統合検索

### 8.1 インデックス設計

```typescript
// パッケージインデックス
interface PackageDocument {
  id: string
  name: string
  title: string
  notes: string
  tags: string[]
  organization_name: string
  organization_title: string
  groups: string[]
  license_id: string
  state: string
  type: string
  private: boolean
  extras: Record<string, any>
  created: string
  updated: string
  res_formats: string[]
  resource_count: number
  spatial_coverage?: GeoJSON
  temporal_start?: string
  temporal_end?: string
  ai_summary?: string
  ai_tags?: string[]
  embedding?: number[]
  quality_score?: number
}

// リソースインデックス（全リソース横断検索）
interface ResourceDocument {
  resource_id: string
  dataset_id: string
  dataset_title: string
  organization: string
  resource_name: string
  format: string
  content_type: 'tabular' | 'document' | 'geospatial' | 'image' | 'text' | 'other'
  extracted_text: string
  original_headers?: string[]
  normalized_headers?: string[]
  row_count?: number
  sample_rows?: Record<string, any>[]
  summary?: string
  semantic_tags?: string[]
  embedding?: number[]
  pii_detected?: boolean
  geo_shape?: GeoJSON
  temporal_range?: { start: string; end: string }
}
```

### 8.2 検索API

```
# メタデータ検索（CKAN package_search 互換）
GET /api/3/action/package_search?q=横浜市+公園&facet.field=["tags","organization"]

# 統合検索（新機能: メタデータ + データ本体 + ファイル内容を横断）
GET /api/v1/search?q=横浜市+人口&scope=all
GET /api/v1/search?q=横浜市+人口&scope=metadata
GET /api/v1/search?q=横浜市+人口&scope=content
GET /api/v1/search?q=横浜市+人口&scope=semantic

# リソース内検索・データアクセス
GET /api/v1/resources/{id}/search?q=中区
GET /api/v1/resources/{id}/rows?limit=100&offset=0
GET /api/v1/resources/{id}/preview
GET /api/v1/resources/{id}/download
GET /api/v1/resources/{id}/schema
```

### 8.3 Solr → OpenSearch 移行のポイント

| 項目         | Solr (CKAN)          | OpenSearch (新版)                   |
| ------------ | -------------------- | ----------------------------------- |
| 全文検索     | text フィールド      | multi_match query                   |
| ファセット   | facet.field          | aggregations                        |
| 地理空間     | 要PostGIS + 追加設定 | geo_shape ネイティブ                |
| 日本語       | kuromoji 追加必要    | kuromoji 標準バンドル               |
| ベクトル検索 | Solr 9.x から限定的  | kNN + dense_vector                  |
| Node.js      | 非公式ライブラリ     | 公式 @opensearch-project/opensearch |
| ライセンス   | Apache 2.0           | Apache 2.0                          |
| デプロイ     | ZooKeeper必要        | Docker単体で動作                    |

---

## 9. AI機能

### 9.1 スキーマ自動推定・意味付け

CSVアップロード時にAIがカラムの意味を推定:

- 「施設名称」→ semantic: "facility_name", type: "text"
- 「緯度」→ semantic: "latitude", type: "float", geo_role: "lat"
- 「住所」→ semantic: "address", type: "text", pii_risk: "medium"

### 9.2 PII（個人情報）検出・公開前チェック

```
アップロード → PII自動検出
  ├─ 検出なし → 公開可能
  ├─ 低リスク → 警告表示、管理者判断
  └─ 高リスク → 公開ブロック、管理者レビュー必須

匿名化オプション提案:
  マスキング / ハッシュ化 / 一般化 / 列削除 / k-匿名化
```

### 9.3 メタデータ自動生成・セマンティック検索

- 説明文自動生成、タグ・カテゴリ自動付与
- 類似データセット自動リンク
- データ品質スコア算出
- Embedding生成 + OpenSearch kNN ベクトル検索
- ハイブリッド検索（キーワード + セマンティック）

---

## 10. Quality Monitor（データ品質監視）

### 10.1 設計方針

データカタログの品質劣化は、公開後に時間とともに進行する。
リンク切れ、CSV形式崩れ、メタデータ不備、秘匿情報混入などの問題を、
**毎日の自動チェック**で検出し、管理者にレポートする。

従来この種の監視は外部ツールに頼る必要があった（例: Datashelf データカタログ管理）が、
モダンクローンではコア機能として内蔵する。データとアクションが同一システム内で完結するため、
検出 → 通知 → 修正 → 再チェックのサイクルを迅速に回せる。

```
packages/
  └── quality/                        # Quality Monitor パッケージ
      ├── checks/
      │   ├── health-check.ts         # リンク切れ検出（HTTP HEAD/GET）
      │   ├── csv-validator.ts        # CSV形式エラーチェック
      │   ├── metadata-audit.ts       # メタデータ完全性チェック
      │   └── pii-scanner.ts          # 秘匿情報検出（AIAdapter連携）
      ├── scheduler.ts                # 定期実行スケジューラー
      ├── report.ts                   # 品質レポート生成
      └── index.ts
```

### 10.2 品質チェック項目

#### リンク切れ検出

外部URLリソース（`resource.url_type = 'link'`）に対して定期的にHTTP HEADリクエストを送信し、
到達可能性を検証する。

```typescript
interface HealthCheckResult {
  resourceId: string
  url: string
  statusCode: number | null // HTTP ステータスコード（タイムアウト時はnull）
  responseTimeMs: number | null
  error?: string // "TIMEOUT" | "DNS_RESOLUTION" | "SSL_ERROR" | ...
  checkedAt: Date
  previousStatus: 'ok' | 'warning' | 'error' | null
}

async function checkResourceHealth(resource: Resource): Promise<HealthCheckResult> {
  // HEAD リクエスト（5秒タイムアウト）
  // 4xx/5xx → error
  // リダイレクト3回以上 → warning
  // SSL証明書期限切れ → warning
  // タイムアウト → 3回リトライ後 error
}
```

**外部ツールとの決定的な違い:**

- リンク切れ検出と同時に `resource.health_status` をDB更新
- OpenSearchインデックスにフラグ反映 → 検索結果でリンク切れリソースを非表示/警告表示可能
- 管理者通知（メール / Webhook）を即座に送信
- ダッシュボードにリアルタイム集計表示

#### CSV形式エラーチェック

アップロード済みCSVファイルをS3から取得し、構造的な問題を検出する。
パイプライン処理時のスマートパーサー（7.6節）と同じロジックを再利用。

```typescript
interface CsvValidationResult {
  resourceId: string
  issues: CsvIssue[]
  checkedAt: Date
}

interface CsvIssue {
  type:
    | 'column_mismatch' // 行ごとの列数不一致
    | 'encoding_error' // 文字化け検出
    | 'empty_header' // 空ヘッダー
    | 'duplicate_header' // 重複ヘッダー
    | 'mixed_line_endings' // 改行コード混在
    | 'trailing_whitespace' // 不要な空白
    | 'inconsistent_quoting' // クォーティング不整合
  severity: 'error' | 'warning'
  rowNumber?: number
  columnIndex?: number
  message: string
}
```

#### メタデータ完全性チェック

データセット・リソースのメタデータが十分に記入されているかを検査する。

```typescript
interface MetadataAuditResult {
  datasetId: string
  completenessScore: number // 0〜100（必須項目の充足率）
  issues: MetadataIssue[]
}

interface MetadataIssue {
  type:
    | 'missing_required' // 必須項目未記入
    | 'missing_recommended' // 推奨項目未記入
    | 'outdated_temporal' // 時間範囲が古い
    | 'missing_license' // ライセンス未設定
    | 'missing_description' // 説明文なし
    | 'short_title' // タイトルが短すぎる
    | 'no_tags' // タグ未設定
    | 'stale_data' // 長期間更新なし
  field?: string
  message: string
}
```

チェック基準はDCAT-AP準拠をデフォルトとし、組織ごとにカスタマイズ可能:

```typescript
// packages/quality/metadata-audit.ts
const DEFAULT_RULES: MetadataRule[] = [
  { field: 'title', required: true, minLength: 5 },
  { field: 'notes', required: true, minLength: 20 },
  { field: 'license_id', required: true },
  { field: 'tags', required: true, minCount: 1 },
  { field: 'author', recommended: true },
  { field: 'maintainer', recommended: true },
  // 組織ごとの追加ルール: organization.extras.metadata_rules でオーバーライド
]
```

#### 秘匿情報検出

AIAdapter を使ったPII（個人情報）スキャン。パイプライン処理時（9.2節）に加え、
定期的な再スキャンで見逃しを防ぐ。

```typescript
interface PiiScanResult {
  resourceId: string
  findings: PiiFinding[]
  scanType: 'pipeline' | 'periodic'
  checkedAt: Date
}

interface PiiFinding {
  type: 'name' | 'address' | 'phone' | 'email' | 'id_number' | 'other'
  confidence: number // 0.0〜1.0
  location: {
    row?: number
    column?: string
    sample?: string // マスク済みサンプル: "田中 ＊＊"
  }
}
```

### 10.3 スケジューリング

品質チェックは環境に応じた方式で定期実行する。

| 環境         | スケジューリング方式                     | 実行先              |
| ------------ | ---------------------------------------- | ------------------- |
| aws-standard | **EventBridge Scheduler** → SQS → Worker | ECS Fargate "worker" |
| development  | **node-cron**（プロセス内）              | APIプロセス         |
| on-premise   | **node-cron**（プロセス内）              | Docker Compose app  |

```typescript
// packages/quality/scheduler.ts
interface QualityScheduler {
  schedule(check: QualityCheckType, cron: string): void
  runNow(check: QualityCheckType, scope?: { orgId?: string }): Promise<void>
}

// デフォルトスケジュール
const DEFAULT_SCHEDULE = {
  'health-check': '0 3 * * *', // 毎日 AM 3:00
  'csv-validation': '0 4 * * 0', // 毎週日曜 AM 4:00
  'metadata-audit': '0 5 * * 1', // 毎週月曜 AM 5:00
  'pii-scan': '0 2 * * 0', // 毎週日曜 AM 2:00（AI使用、コスト考慮）
}
```

AWS環境では EventBridge Scheduler がcron式で SQS にメッセージを送り、
既存の Worker が処理する。追加インフラ不要。

```
EventBridge Scheduler (cron: 0 3 * * *)
    │
    ▼
SQS キュー
    │ { type: 'quality-check', payload: { check: 'health-check', scope: 'all' } }
    │
    ▼
ECS Fargate "worker" → QueueAdapter.consume() で受信
    │
    ▼
health-check.ts → 全リソースURL巡回 → DB更新 → レポート生成
```

### 10.4 品質ダッシュボード

管理画面のトップに品質サマリーを表示する。

```typescript
interface QualityDashboard {
  overview: {
    totalDatasets: number
    totalResources: number
    healthyResources: number // リンク正常
    brokenLinks: number // リンク切れ
    csvErrors: number // CSV形式エラー
    metadataCompleteness: number // 平均メタデータ充足率(%)
    piiWarnings: number // PII検出数
    lastCheckedAt: Date
  }
  trends: {
    // 過去30日の推移
    date: string
    brokenLinks: number
    csvErrors: number
    completeness: number
  }[]
  topIssues: QualityIssue[] // 優先度順の問題リスト
}
```

品質スコアの推移を可視化し、「先月のリンク切れ率: 14.8% → 今月: 2.1%」のような
改善の定量化ができる。これにより品質維持のモチベーションと説明責任を支える。

### 10.5 品質レポート

定期チェック結果を組織管理者に自動送信する。

```typescript
interface QualityReport {
  organizationId: string
  period: { from: Date; to: Date }
  summary: {
    newIssues: number
    resolvedIssues: number
    totalOpenIssues: number
    overallScore: number // 0〜100
    scoreDelta: number // 前期比
  }
  sections: {
    healthCheck: HealthCheckSummary
    csvValidation: CsvValidationSummary
    metadataAudit: MetadataAuditSummary
    piiScan: PiiScanSummary
  }
  recommendations: string[] // AI生成の改善提案（オプション）
}
```

配信方式:

- メール通知（組織管理者宛）
- Webhook（Slack / Teams連携）
- ダッシュボード内レポートビュー
- CSVエクスポート（メタデータ一覧 + 品質ステータス付き）

### 10.6 DBスキーマ

Quality Monitor関連テーブル（`quality_check`、`quality_score_history`）および
`resource` テーブルへの品質カラム追加は **6.3節** に定義。

---

## 11. Data Editor（データ入力・整備）— アドオンモジュール

### 11.1 設計方針

CKANには「データを作る・整える」機能が完全に欠落している。
CKANは「完成したファイルをアップロードする場所」でしかなく、
各部署がExcelで独自にデータを作成するため、列名不統一・表記揺れ・形式不整合が日常的に発生する。

Data Editorは、この問題を「入力時点で防ぐ」ためのアドオンモジュールである。
Quality Monitor（10節）が品質の「検出・修正」なら、Data Editorは品質の「予防」。
両方揃って初めてデータ品質のライフサイクルが完成する。

```
Data Editor（予防）              Quality Monitor（検出）
  入力時バリデーション              リンク切れ検出
  表記揺れ正規化                   CSV形式チェック
  参照整合性チェック                メタデータ完全性
  スキーマ定義・制約                PII検出
       │                            │
       ▼                            ▼
   "綺麗に作る"                  "汚れを見つける"
```

**アドオンとする理由:**

1. **全自治体に必須ではない** — 既にデータ作成フローが確立している組織もある
2. **独立した価値がある** — カタログなしでも庁内データ管理ツールとして単体運用可能
3. **段階的導入が可能** — カタログ導入 → 品質問題が可視化 → Data Editor追加、という自然なストーリー

ただし「深く統合されたアドオン」であり、同じDB・認証基盤・ストレージを共有し、
カタログとシームレスにつながる。追加インフラコストはほぼゼロ。

```
ckan-modern/
├── apps/
│   ├── worker/         # Pipeline Worker
│   ├── web/            # カタログUI + Hono API（単一オリジン）
│   └── editor/         # ← Data Editor UI（独立デプロイ可能）
├── packages/
│   ├── editor-core/    # ← Data Editor ビジネスロジック
│   │   ├── schema-definition.ts   # スキーマ定義・カラム制約
│   │   ├── validation.ts          # 入力バリデーション
│   │   ├── normalization.ts       # 表記揺れ正規化
│   │   ├── reference.ts           # データ間参照関係
│   │   ├── versioning.ts          # バージョン管理
│   │   └── export.ts              # カタログへの公開エクスポート
│   └── ...
```

### 11.2 スキーマ定義・入力制約

Data Editorのテーブルは「スキーマ定義」を持ち、列ごとに型・制約・正規化ルールを設定できる。
これにより入力時点でデータ品質を担保する。

```typescript
interface EditorTable {
  id: string
  name: string // "佐賀市公共施設一覧"
  organizationId: string
  columns: EditorColumnSchema[]
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

interface EditorColumnSchema {
  name: string // "施設名称"
  normalizedName: string // "facility_name"（AI推定 or 手動設定）
  type: 'text' | 'number' | 'date' | 'select' | 'boolean' | 'reference'
  required: boolean
  description?: string // カラム説明（ツールチップ表示）
  position: number // 表示順

  constraints: {
    pattern?: string // 正規表現（例: 郵便番号 "^\d{3}-\d{4}$"）
    min?: number // 数値最小値
    max?: number // 数値最大値
    minLength?: number // 文字列最小長
    maxLength?: number // 文字列最大長
    allowedValues?: string[] // プルダウン選択肢
    dateFormat?: string // "YYYY-MM-DD" | "YYYY/MM/DD"
    numberFormat?: {
      decimal: boolean // 小数許可
      negative: boolean // 負数許可
      separator: boolean // 桁区切りカンマ表示
    }
    unique?: boolean // ユニーク制約
    referenceTable?: string // 参照先テーブルID
    referenceColumn?: string // 参照先カラム名
  }

  normalization?: ColumnNormalization
}
```

**自治体でよく使う制約パターン（プリセット）:**

```typescript
const PRESETS = {
  郵便番号: { type: 'text', constraints: { pattern: '^\\d{3}-\\d{4}$' } },
  電話番号: { type: 'text', constraints: { pattern: '^0\\d{1,4}-\\d{1,4}-\\d{4}$' } },
  緯度: { type: 'number', constraints: { min: 20, max: 46, decimal: true } },
  経度: { type: 'number', constraints: { min: 122, max: 154, decimal: true } },
  日付: { type: 'date', constraints: { dateFormat: 'YYYY-MM-DD' } },
  メールアドレス: { type: 'text', constraints: { pattern: '^[^@]+@[^@]+$' } },
  URL: { type: 'text', constraints: { pattern: '^https?://' } },
}
```

### 11.3 表記揺れ正規化

データ入力時に自動的に表記を正規化する。
このロジックは `packages/editor-core/normalization.ts` に実装し、
パイプラインのスマートパーサー（7.6節）とも共有する。

```typescript
interface ColumnNormalization {
  trim: boolean // 前後空白除去
  fullWidthToHalf: boolean // 全角英数字→半角 "１２３" → "123"
  halfWidthKanaToFull: boolean // 半角カタカナ→全角 "ｱｲｳ" → "アイウ"
  companyNormalize: boolean // "㈱" → "株式会社"、"(有)" → "有限会社"
  addressNormalize: boolean // 住所の正規化（全角数字→半角、丁目・番地）
  customRules: NormalizationRule[]
}

interface NormalizationRule {
  pattern: string // 正規表現 or リテラル
  replacement: string
  description: string // "全角ハイフン類を統一"
}
```

**自治体データの典型的な正規化ルール:**

| カテゴリ | 元データ             | 正規化後                   |
| -------- | -------------------- | -------------------------- |
| 法人名   | ㈱インフォ・ラウンジ | 株式会社インフォ・ラウンジ |
| 法人名   | (有)サンプル商事     | 有限会社サンプル商事       |
| 日付     | ２０２５年４月１日   | 2025-04-01                 |
| 日付     | R7.4.1               | 2025-04-01                 |
| 数値     | 1,234,567            | 1234567                    |
| 数値     | ▲500                 | -500                       |
| 住所     | 佐賀市　栄町１−１    | 佐賀市栄町1-1              |
| 電話番号 | ０９５２−２４−XXXX   | 0952-24-XXXX               |
| ハイフン | −／‐／ー／—          | -（半角ハイフン統一）      |

正規化は入力時にリアルタイム適用し、元の入力値も保持する（復元可能）。

### 11.4 データ間参照関係

Data Editorのテーブル間に参照関係を設定できる。
これにより「施設名を毎回手入力」ではなく「マスターデータから選択」となり、
表記揺れの大半を構造的に防ぐ。

```typescript
// 施設マスターテーブル
const facilityTable = defineTable({
  name: '佐賀市公共施設',
  columns: [
    { name: '施設コード', type: 'text', constraints: { unique: true } },
    { name: '施設名称', type: 'text', required: true },
    { name: '住所', type: 'text' },
    { name: '緯度', type: 'number', presetType: '緯度' },
    { name: '経度', type: 'number', presetType: '経度' },
  ],
})

// イベントテーブル → 施設を参照
const eventTable = defineTable({
  name: 'イベント情報',
  columns: [
    { name: 'イベント名', type: 'text', required: true },
    {
      name: '開催施設',
      type: 'reference',
      constraints: {
        referenceTable: '佐賀市公共施設',
        referenceColumn: '施設名称', // ← プルダウンで施設を選択
      },
    },
    { name: '開催日', type: 'date', presetType: '日付' },
  ],
})
```

UIでは参照カラムがプルダウン（オートコンプリート付き）として表示される。
参照先マスターの更新は、参照元テーブルにも自動反映。

```
editor_table_reference テーブル:
  source_table_id → target_table_id
  source_column   → target_column
```

### 11.5 バージョン管理・承認フロー

Data Editor上のデータ変更はすべてバージョン管理される。
庁内の承認フロー（担当者が編集 → 上長が承認 → 公開）にも対応。

```typescript
interface DataVersion {
  id: string
  tableId: string
  versionNumber: number
  createdBy: string
  createdAt: Date
  changeType: 'create' | 'update' | 'delete' | 'schema_change'
  changeSummary: string // "3行追加、2行更新"
  rowsAdded: number
  rowsUpdated: number
  rowsDeleted: number
  snapshotKey: string // S3上のスナップショットファイル

  // 承認フロー
  approvalStatus: 'draft' | 'pending_review' | 'approved' | 'rejected' | 'published'
  reviewedBy?: string
  reviewedAt?: Date
  reviewComment?: string
  publishedAt?: Date
}
```

**承認フロー:**

```
担当者が編集 → "レビュー依頼" → 上長に通知
                                    │
                              ┌─────┴─────┐
                              ▼           ▼
                          "承認"        "差し戻し"
                              │           │
                              ▼           ▼
                        "公開" ボタン   担当者に通知
                              │         再編集
                              ▼
                    カタログに自動エクスポート
```

バージョン間の差分表示（どのセルが変更されたか）も提供。
任意のバージョンへのロールバックが可能。

### 11.6 カタログ連携（エクスポート・自動公開）

Data Editorとカタログの統合ポイント。承認済みデータをワンクリックで公開:

```
Data Editor上のテーブル（承認済み）
    │
    │ "カタログに公開" ボタン
    ▼
  ① CSV/JSON生成 → S3保存（StorageAdapter）
  ② package/resource レコード作成 or 更新（Drizzle ORM）
  ③ メタデータ自動付与（テーブル名→タイトル、カラム説明→スキーマ情報）
  ④ QueueAdapter.send({ type: 'resource-pipeline' })
  ⑤ パイプライン実行（ただし既にバリデーション済みなので高速）
  ⑥ OpenSearchインデックス更新
    │
    ▼
カタログ上にデータセットとして公開
```

**連携オプション:**

```typescript
interface CatalogPublishOptions {
  datasetId?: string // 既存データセットを更新（nullなら新規作成）
  organizationId: string
  format: 'csv' | 'json' | 'xlsx'
  license: string
  visibility: 'public' | 'private'
  autoUpdate: boolean // テーブル更新時に自動再公開
  autoUpdateSchedule?: string // cron式（例: 毎月1日に公開更新）
}
```

`autoUpdate: true` にすると、Data Editor上でデータが承認されるたびに
カタログ側のリソースが自動更新される。手動エクスポート不要。

**Quality Monitorとの連携:**

Data Editor経由で作成されたリソースは `resource.source = 'editor'` フラグが付く。
Quality Monitorはこのフラグを見て、CSV形式チェックをスキップできる
（Editor経由なら既にバリデーション済みのため）。

### 11.7 API連携（外部システムへのデータ提供）

Data Editor上のテーブルデータを外部システムにAPIで提供する。
佐賀市DMSでは「スーパーアプリへのイベントデータ提供」に使われている機能。

```typescript
// Data Editor テーブルのAPI自動公開
app.get('/api/v1/editor/tables/:tableId/rows', async (c) => {
  // 認証チェック（APIキー or Better Auth セッション）
  // クエリパラメータ: limit, offset, sort, filter
  // レスポンス: JSON配列
})

app.get('/api/v1/editor/tables/:tableId/rows/:rowId', async (c) => {
  // 特定行の取得
})

// Webhook: テーブル更新時に外部システムに通知
app.post('/api/v1/editor/tables/:tableId/webhooks', async (c) => {
  // { url: 'https://saga-app.example.com/webhook', events: ['row.created', 'row.updated'] }
})
```

カタログ経由のAPI（`/api/v1/resources/{id}/rows`）との違い:

- カタログAPI: 公開済みリソースの読み取り専用。エンドユーザー向け
- Editor API: 編集中テーブルのリアルタイムデータ。システム連携向け

### 11.8 DBスキーマ

```sql
-- ============================================================
-- Data Editor テーブル定義
-- ============================================================
CREATE TABLE editor_table (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  description     TEXT,
  organization_id UUID NOT NULL REFERENCES organization(id),
  schema          JSONB NOT NULL,        -- EditorColumnSchema[] の配列
  row_count       INTEGER DEFAULT 0,
  created_by      UUID NOT NULL REFERENCES "user"(id),
  created         TIMESTAMPTZ DEFAULT NOW(),
  updated         TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Data Editor 行データ（JSONB格納）
-- ============================================================
CREATE TABLE editor_row (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id        UUID NOT NULL REFERENCES editor_table(id) ON DELETE CASCADE,
  row_number      INTEGER NOT NULL,
  data            JSONB NOT NULL,        -- { "施設名称": "...", "住所": "..." }
  raw_data        JSONB,                 -- 正規化前の元データ（復元用）
  validation_errors JSONB DEFAULT '[]',  -- バリデーションエラー
  created_by      UUID REFERENCES "user"(id),
  created         TIMESTAMPTZ DEFAULT NOW(),
  updated         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_editor_row_table ON editor_row(table_id, row_number);

-- ============================================================
-- Data Editor テーブル間参照関係
-- ============================================================
CREATE TABLE editor_table_reference (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_table_id UUID NOT NULL REFERENCES editor_table(id) ON DELETE CASCADE,
  source_column   TEXT NOT NULL,
  target_table_id UUID NOT NULL REFERENCES editor_table(id) ON DELETE CASCADE,
  target_column   TEXT NOT NULL
);

-- ============================================================
-- Data Editor バージョン管理
-- ============================================================
CREATE TABLE editor_version (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id        UUID NOT NULL REFERENCES editor_table(id) ON DELETE CASCADE,
  version_number  INTEGER NOT NULL,
  change_type     VARCHAR(20) NOT NULL,  -- 'create' | 'update' | 'delete' | 'schema_change'
  change_summary  TEXT,
  rows_added      INTEGER DEFAULT 0,
  rows_updated    INTEGER DEFAULT 0,
  rows_deleted    INTEGER DEFAULT 0,
  snapshot_key    TEXT,                   -- S3上のスナップショット
  created_by      UUID NOT NULL REFERENCES "user"(id),
  created         TIMESTAMPTZ DEFAULT NOW(),

  -- 承認フロー
  approval_status VARCHAR(20) DEFAULT 'draft',
  reviewed_by     UUID REFERENCES "user"(id),
  reviewed_at     TIMESTAMPTZ,
  review_comment  TEXT,
  published_at    TIMESTAMPTZ,
  UNIQUE(table_id, version_number)
);

-- ============================================================
-- Data Editor → カタログ連携
-- ============================================================
CREATE TABLE editor_catalog_link (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id        UUID NOT NULL REFERENCES editor_table(id) ON DELETE CASCADE,
  dataset_id      UUID NOT NULL REFERENCES package(id),
  resource_id     UUID NOT NULL REFERENCES resource(id),
  auto_update     BOOLEAN DEFAULT FALSE,
  auto_schedule   TEXT,                  -- cron式（自動公開スケジュール）
  last_published  TIMESTAMPTZ,
  publish_format  VARCHAR(10) DEFAULT 'csv',
  created         TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 12. MCP サーバー

```typescript
const mcpServer = new MCPServer({
  tools: [
    { name: 'search_datasets', description: 'データセットを検索' },
    { name: 'get_resource_data', description: 'リソースデータを取得' },
    { name: 'get_dataset_summary', description: 'AI要約と統計を取得' },
    { name: 'search_across_data', description: '横断検索' },
    { name: 'get_quality_report', description: '品質レポートを取得' },
    { name: 'check_broken_links', description: 'リンク切れ状況を確認' },
    { name: 'list_editor_tables', description: 'Data Editorテーブル一覧を取得' },
    { name: 'get_editor_table_data', description: 'Data Editorテーブルのデータを取得' },
  ],
  resources: [
    { uri: 'dataset://{id}', description: 'データセットメタデータ' },
    { uri: 'resource://{id}/data', description: 'リソースデータ内容' },
    { uri: 'editor://{tableId}', description: 'Data Editorテーブルデータ' },
  ],
})
```

---

## 13. プラグインアーキテクチャ

```typescript
interface CatalogPlugin {
  name: string
  version: string

  hooks?: {
    'dataset:beforeCreate'?: (data: DatasetInput) => DatasetInput | void
    'dataset:afterCreate'?: (dataset: Dataset) => void
    'resource:afterUpload'?: (resource: Resource) => void
    'resource:afterPipeline'?: (resource: Resource, result: PipelineResult) => void
    'search:modifyQuery'?: (query: SearchQuery) => SearchQuery
    'preview:render'?: (resource: Resource) => PreviewComponent | null
    'quality:afterCheck'?: (result: QualityCheckResult) => void
    'quality:customCheck'?: (resource: Resource) => QualityIssue[]
    'editor:beforePublish'?: (table: EditorTable, data: any[]) => any[] | void
    'editor:afterPublish'?: (table: EditorTable, resource: Resource) => void
    'editor:customValidation'?: (row: any, schema: EditorColumnSchema[]) => ValidationError[]
  }

  components?: {
    'dataset-detail-sidebar'?: React.ComponentType
    'resource-preview'?: React.ComponentType<{ resource: Resource }>
    'admin-panel-tab'?: React.ComponentType
    'editor-toolbar'?: React.ComponentType
  }

  routes?: RouteDefinition[]
  schemaExtensions?: Record<string, FieldDefinition>
}
```

主要extension機能はコアに取り込み済み（harvest, spatial, scheming, dcat）。
新規プラグインはTypeScript/JavaScript + npmパッケージとして配布。

---

## 14. CKAN API互換レイヤー

### 14.1 互換対象（優先度順）

**P1: 必須（データ移行・ハーベスト互換）**

- package_list, package_show, package_search
- resource_show, organization_list, organization_show
- group_list, group_show, tag_list, tag_show

**P2: 高優先（既存クライアント互換）**

- package_create / update / patch / delete
- resource_create / update / delete
- organization_create / update
- user_show, user_list, package_autocomplete

**P3: 中優先**

- member_create / delete, user_create / update
- current_package_list_with_resources
- package_search の全ファセットオプション

**廃止**: datastore\_\* 系 → 代替: /api/v1/resources/{id}/rows, /search 等

### 14.2 実装

```typescript
const ckanCompat = new Hono()

ckanCompat.all('/api/3/action/:action', async (c) => {
  const action = c.req.param('action')
  const handler = ckanActionRegistry.get(action)
  if (!handler) {
    return c.json({ success: false, error: { __type: 'Not Found' } }, 404)
  }
  const params = c.req.method === 'GET' ? c.req.query() : await c.req.json()
  const result = await handler(params, await buildContext(c))
  return c.json({ help: handler.helpText, success: true, result })
})
```

---

## 15. データ移行

```
既存CKAN                                新システム
┌──────────┐                           ┌─────────┐
│PostgreSQL │─── ckanapi dump ─────────►│Migration │
│(メタデータ)│     (JSONL)              │CLI Tool  │
└──────────┘                           │          │
┌──────────┐                           │  ① JSONL解析        │
│FileStore │─── rsync / S3 sync ──────►│  ② スキーマ変換       │
│          │                           │    extras → JSONB   │
└──────────┘                           │    revision除外     │
                                       │    member分離       │
                                       │  ③ PostgreSQL投入   │
                                       │  ④ S3ファイルコピー  │
                                       │  ⑤ パイプライン実行 │
                                       │  ⑥ OpenSearchインデ │
                                       │    ックス構築       │
                                       └─────────┘
```

---

## 16. 取捨選択サマリー

### 取り入れるもの

| 要素                     | 理由             |
| ------------------------ | ---------------- |
| Action API (RPC形式)     | 互換性の生命線   |
| コアデータモデル         | 移行基盤         |
| DCAT/DCAT-AP 標準        | 国際相互運用性   |
| ファセット検索           | 必須UX           |
| 組織/グループ管理        | 運用必須         |
| Harvest                  | エコシステム連携 |
| 空間検索                 | GISニーズ        |
| アクティビティストリーム | 監査・通知       |
| プレビュー機能           | ユーザー要望大   |

### CKANにない新規機能

| 要素                                | 理由                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------- |
| **Quality Monitor（品質監視）**     | リンク切れ・CSV形式・メタデータ不備の自動検出。Datashelf機能のコア統合    |
| **Data Editor（データ入力・整備）** | 表記揺れ防止・入力制約・参照関係・承認フロー。佐賀市DMS機能のアドオン統合 |
| 品質ダッシュボード                  | 品質スコア推移の可視化、組織別レポート自動送信                            |
| PII検出・公開前チェック             | 秘匿情報の自動検出、公開ブロックワークフロー                              |
| AI メタデータ自動生成               | スキーマ推定、要約、タグ付与、品質スコア算出                              |
| セマンティック検索                  | Embedding + kNN によるベクトル検索                                        |
| 全リソース横断検索                  | CSV行データ・PDF本文・画像OCRを含む統合検索                               |
| MCPサーバー                         | AIエージェント連携                                                        |

### 廃止・再設計するもの

| 要素                      | 代替                                           |
| ------------------------- | ---------------------------------------------- |
| DataStore (RDBテーブル化) | OpenSearch + プレビューJSON                    |
| DataStore API             | リソース検索/行取得API                         |
| XLoader / DataPusher+     | Pipeline Worker（QueueAdapter + ステップ分割） |
| \*\_revision テーブル群   | audit_log                                      |
| Solr                      | OpenSearch (OSS)                               |
| package_extra (EAV)       | JSONB extras                                   |
| member (多態テーブル)     | 用途別テーブル                                 |
| Pythonプラグイン          | TypeScriptプラグイン                           |
| Jinja2テンプレート        | React + Next.js                                |
| Redis / BullMQ（v3）      | SQS / ElasticMQ + lru-cache                    |
| Auth.js（v3）             | Better Auth + OIDC                             |

---

## 17. 実装ロードマップ

### Phase 1: Foundation ✅

- プロジェクトセットアップ（Turborepoモノレポ + pnpm workspaces）
- DBスキーマ設計・マイグレーション（Drizzle ORM — `packages/db`）
- インフラ抽象化レイヤー（StorageAdapter, SearchAdapter, AIAdapter, QueueAdapter）
- コアCRUD API（package, resource, organization, group, tag, user）
- CKAN互換APIレイヤー（P1エンドポイント10個）
- 認証基盤（Better Auth — メール/パスワード + API Key + sysadminロール）
- Docker Compose 開発環境
- PostgreSQL ILIKE 検索（フォールバック）
- lru-cacheユーティリティ（`packages/shared`）
- テスト基盤（Vitest — ユニット + 統合、194テスト）

### Phase 2: フロントエンド

- Next.js 15 (App Router) + shadcn/ui + Tailwind CSS 4（`apps/web`）
- データセット一覧・詳細・検索UI
- 組織・グループ一覧・詳細UI
- 管理画面（パッケージ/組織/グループ CRUD）
- 認証UI（ログイン/登録 — Better Auth クライアント連携）
- i18n 基盤（日本語/英語 — 構造のみ、翻訳は段階的追加）

### Phase 3: Pipeline & ファイルストレージ

- Pipeline Worker（QueueAdapter — SQS/ElasticMQ + ステップ分割パイプライン）
- スマートパーサー（日本語CSV対応）
- プレビューJSON生成・S3保存
- ファイルアップロードUI + Presigned URL対応
- PDF/Excel/画像のコンテンツ抽出
- OpenSearch統合インデックス（リソース横断検索）
- プレビューUI（テーブル・PDF・地図・画像）

### Phase 4: Quality Monitor

- **Quality Monitor 基盤**（`packages/quality`）
  - リンク切れ検出（HTTP HEAD巡回）
  - CSV形式エラーチェック（スマートパーサー再利用）
  - メタデータ完全性チェック
  - スケジューラー（node-cron / EventBridge）
  - quality_check / quality_score_history テーブル
- **品質ダッシュボード**（品質スコア推移、問題一覧、組織別レポート）

### Phase 5: AI & 高度機能

- AIスキーマ推定・メタデータ自動生成
- PII検出・公開前チェックフロー
- **PII定期再スキャン**（Quality Monitor + AIAdapter連携）
- **品質レポート自動送信**（メール / Webhook / CSVエクスポート）
- セマンティック検索（Embedding + kNN）
- Harvest機能（CKAN互換プロトコル）
- 空間検索（geo_shape）
- データ移行CLIツール

### Phase 6: デプロイ & エコシステム

- AWS ECS Fargate + ALB デプロイ（CDK — Web + Worker + SQS）
- オンプレ Docker Compose 本番構成（Redis不要）
- プラグインシステム
- MCPサーバー
- DCAT/DCAT-AP エクスポート
- OpenAPI仕様自動生成

### Phase 7: Data Editor — アドオン

- **`packages/editor-core`** ビジネスロジック
  - スキーマ定義・入力制約エンジン
  - 表記揺れ正規化（スマートパーサーとロジック共有）
  - データ間参照関係
  - バージョン管理・承認フロー
- **`apps/editor`** フロントエンドUI
  - スプレッドシートライク編集UI（AG Grid or 類似OSSベース）
  - スキーマ定義管理画面
  - 差分表示・ロールバック画面
  - 承認フローUI
- **カタログ連携**
  - ワンクリック公開（Editor → S3 → Pipeline → カタログ）
  - 自動公開スケジュール（`editor_catalog_link`）
- **API連携**
  - Editor テーブルデータのREST API自動公開
  - Webhook通知（外部システム連携）
- **DBスキーマ**（`editor_table`, `editor_row`, `editor_version`, `editor_catalog_link`）

---

## 18. リスクと対策

| リスク                                | 対策                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| CKAN API完全互換の困難さ              | 主要エンドポイントの「実用的互換」に絞る                                     |
| OpenSearchの運用コスト                | PostgreSQLフォールバックで省略可能                                           |
| 日本語CSVの多様性                     | スマートパーサーの段階的改善 + AI活用                                        |
| 既存CKANエクステンション非互換        | コア取り込み + プロトコルレベル互換                                          |
| 自治体のIT環境制約（閉域網等）        | Docker Compose一括デプロイ、AI無効化可、Redis不要                            |
| ECS Fargate タスク数上限              | デフォルトクォータ申請で拡張可、国レベルは EKS 検討                           |
| Embedding生成コスト                   | バッチ処理 + オプション化 + NoOpAdapter                                      |
| Better Authの成熟度（まだ若い）       | OIDC標準準拠のため、将来IdP差し替え容易                                      |
| Data Editorのスコープ肥大化           | アドオン設計で分離。コアカタログ機能と独立してリリース可                     |
| スプレッドシートUI の大規模データ性能 | 仮想スクロール + サーバーサイドページネーション。1万行超はバッチ編集UIに切替 |

---

_v4 — Turborepoモノレポ構成、Better Auth認証基盤、Redis排除（SQS/ElasticMQ + lru-cache）、
QueueAdapter抽象化、API/Worker SQSイベント駆動分離、
Quality Monitor（Datashelf機能のコア統合: リンク切れ・CSV検証・メタデータ監査・PII検出）、
Data Editor（佐賀市DMS機能のアドオン統合: スキーマ定義・表記揺れ正規化・参照関係・承認フロー・カタログ連携）、
コスト最適化（~$144〜170/月、ECS Fargate + ALB 構成）を反映_
