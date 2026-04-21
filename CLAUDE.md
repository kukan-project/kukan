# KUKAN — プロジェクトルール

> **Knowledge Unified Katalog And Network**
> みんなが使えるデータカタログ — CKANモダンクローン

## プロジェクト概要

CKANの後継として設計されたTypeScriptフルスタックのデータカタログシステム。
クラウド（AWS）からオンプレミス・閉域網（LGWAN等）まで対応するハイブリッドデプロイ設計。

設計書全文: `docs/design-v4.md`

## 技術スタック

| カテゴリ       | 技術                                                  |
| -------------- | ----------------------------------------------------- |
| 言語           | TypeScript 5.x（全レイヤー統一）                      |
| ランタイム     | Node.js 24 LTS                                        |
| モノレポ       | Turborepo + pnpm workspaces                           |
| API            | Hono 4.x（Cloudflare Workers / Node.js / Bun 対応）   |
| フロントエンド | Next.js 16 (App Router) + shadcn/ui + Tailwind CSS 4  |
| DB             | PostgreSQL 16 / Aurora Serverless v2                  |
| ORM            | Drizzle ORM（PostgreSQL ドライバ）                    |
| 検索           | OpenSearch 3.x / PostgreSQL全文検索（フォールバック） |
| ストレージ     | S3互換（AWS S3 / MinIO 統合アダプター）               |
| キュー         | SQS互換（AWS SQS / ElasticMQ）                        |
| キャッシュ     | lru-cache 11.x（インメモリ、全環境共通）              |
| 認証           | Better Auth 1.x + OIDC プラグイン                     |
| AI             | Bedrock / OpenAI / Ollama / NoOp                      |
| テスト         | Vitest + Playwright                                   |
| バリデーション | Zod                                                   |
| デプロイ       | ECS Fargate + ALB / Docker Compose                    |
| IaC            | AWS CDK (TypeScript)                                  |

## モノレポ構成

```
KUKAN/
├── CLAUDE.md               # ← このファイル
├── apps/
│   ├── worker/             # Pipeline Worker（SQS consumer、ECS Fargate）          ※ Phase 3+
│   ├── web/                # Next.js フロントエンド + Hono API（単一オリジン）    ※ Phase 2+
│   └── editor/             # Data Editor UI（アドオン、独立デプロイ可能）        ※ Phase 7+
├── packages/
│   ├── api/                # Hono API サーバー + Better Auth（ライブラリ）
│   ├── db/                 # Drizzle スキーマ + マイグレーション + Better Auth テーブル
│   ├── shared/             # 型定義、Zod バリデーション、lru-cache ユーティリティ
│   ├── adapters/           # 環境差吸収アダプター（4つ）
│   │   ├── search/         # @kukan/search-adapter (OpenSearch / PostgreSQL)
│   │   ├── storage/        # @kukan/storage-adapter (S3互換: AWS S3 / MinIO)     ※ Phase 3+
│   │   ├── queue/          # @kukan/queue-adapter (SQS互換: AWS SQS / ElasticMQ) ※ Phase 3+
│   │   └── ai/             # @kukan/ai-adapter (Bedrock / OpenAI / Ollama / NoOp)※ Phase 5+
│   ├── editor-core/        # Data Editor ビジネスロジック（アドオン）             ※ Phase 7+
│   ├── quality/            # Quality Monitor（リンク切れ、CSV検証、メタデータ監査、PII）※ Phase 4+
│   └── ui/                 # shadcn/ui 共有コンポーネント                        ※ Phase 2+
├── site/                   # ドキュメントサイト（Astro + Starlight、日英対応）
├── docs/
│   ├── design-v4.md        # 設計書（全体像、参照用）
│   ├── adr/                # Architecture Decision Records
│   └── specs/              # Phase別 実装仕様書
├── Dockerfile              # マルチターゲット Docker ビルド（web / worker）
├── .dockerignore
├── compose.yml             # Docker Compose（開発 / オンプレ本番）
├── docker/                 # Caddyfile, ElasticMQ, OpenSearch 設定
├── infra/                  # AWS CDK スタック（KukanStack）
├── turbo.json
├── pnpm-workspace.yaml
├── package.json
└── tsconfig.base.json
```

## コーディング規約

### 命名規則

- ファイル名: `kebab-case`（例: `storage-adapter.ts`）
- クラス・インターフェース: `PascalCase`（例: `StorageAdapter`）
- 関数・変数: `camelCase`（例: `processResource`）
- 定数: `UPPER_SNAKE_CASE`（例: `DEFAULT_PAGE_SIZE`）
- DBカラム: `snake_case`（例: `created_at`）
- テーブル名: `snake_case` 単数形（例: `package`, `resource`）

### Git コミットメッセージ

- **All commit messages must be in English** (subject and body)
- Follow Conventional Commits format: `feat:`, `fix:`, `chore:`, `docs:`, etc.

### コミット前チェック

コミット前に以下を必ず実行し、すべてパスしてからコミットする:

```bash
pnpm lint          # ESLint
pnpm typecheck     # TypeScript 型チェック
pnpm format        # Prettier フォーマット
```

フォーマットで変更が発生した場合は、本体のコミットに含める。

### インポート規則

- パッケージ間は `@kukan/パッケージ名` でインポート
  ```typescript
  import { StorageAdapter } from '@kukan/storage-adapter'
  import { db } from '@kukan/db'
  ```
- 相対パスインポートはパッケージ内部のみ

### フロントエンド SSR / CSR 使い分け

| 領域                                               | レンダリング | API クライアント                    | 理由                                   |
| -------------------------------------------------- | ------------ | ----------------------------------- | -------------------------------------- |
| 公開ページ（dataset, organization, group, search） | SSR          | `serverFetch`（`server-api.ts`）    | SEO・初回表示速度                      |
| Dashboard layout（認証ガード）                     | SSR          | `getCurrentUser`（`server-api.ts`） | 未認証フラッシュ防止                   |
| Dashboard 各ページ                                 | CSR          | `clientFetch`（`client-api.ts`）    | インタラクティブ性・ページ遷移の軽量化 |
| ヘッダー                                           | SSR          | `getCurrentUser`（`server-api.ts`） | ユーザーメニュー表示                   |

- `server-api.ts` は `import 'server-only'` でクライアントバンドルへの混入を防止
- Dashboard のユーザー情報は `UserProvider`（layout SSR → 子 CSR）で伝播、`useUser()` で参照

### エラーハンドリング

- カスタムエラークラスを使う（`KukanError` を基底クラス）
- エラーは発生箇所に最も近い場所でキャッチ
- APIレスポンスは RFC 7807 Problem Details 形式
  ```typescript
  { type: 'about:blank', title: 'Not Found', status: 404, detail: '...' }
  ```

### データベース

- すべてのテーブルに `id` (UUID), `created` (TIMESTAMPTZ), `updated` (TIMESTAMPTZ)
- 論理削除は使わない（`state` カラムで `active` / `deleted` を管理）
- マイグレーションは Drizzle Kit で管理

### テスト

- ユニットテスト: Vitest（`*.test.ts`）
- 統合テスト: Vitest + テスト用DB（`*.integration.test.ts`）
- E2Eテスト: Playwright（`*.e2e.ts`）
- テストファイルは `__tests__/` サブディレクトリに配置（例: `src/__tests__/errors.test.ts`）

### 環境変数

- `packages/shared/env.ts` で Zod バリデーション付きの環境変数定義
- `.env` ファイルはリポジトリに含めない（`.env.example` を用意）

## インフラ抽象化の原則

環境差がある4つだけアダプターを作る。それ以外は抽象化しない:

| アダプター     | AWS        | 開発/オンプレ          |
| -------------- | ---------- | ---------------------- |
| StorageAdapter | S3         | MinIO (S3互換)         |
| SearchAdapter  | OpenSearch | PostgreSQL全文検索     |
| AIAdapter      | Bedrock    | Ollama / OpenAI / NoOp |
| QueueAdapter   | SQS        | ElasticMQ (SQS互換)    |

キャッシュは lru-cache ユーティリティ（全環境共通、アダプター不要）。

## 設計判断

実装中に「なぜこの技術を選んだのか」迷ったら `docs/adr/` を参照:

- ORM選定 → `docs/adr/001-drizzle-orm.md`
- キュー方式 → `docs/adr/002-sqs-over-bullmq.md`
- 認証方式 → `docs/adr/003-better-auth.md`
- キャッシュ方式 → `docs/adr/004-lru-cache-no-adapter.md`
- アダプター設計 → `docs/adr/005-four-adapters-only.md`
- 品質監視 → `docs/adr/006-quality-monitor-core.md`
- Data Editor → `docs/adr/007-data-editor-addon.md`
- モノレポ → `docs/adr/008-turborepo-monorepo.md`
- 日本語全文検索 → `docs/adr/009-opensearch-ilike-fallback.md`
- テーマ戦略 → `docs/adr/010-shadcn-ui-theming-strategy.md`
- バリデーション統一 → `docs/adr/011-unified-validation-system.md`
- API ライブラリ化・単一オリジン → `docs/adr/012-api-as-library-single-origin.md`
- 検索と DB フィルタリングの分離 → `docs/adr/013-search-vs-db-filtering.md`
- プレビュー Parquet 形式 → `docs/adr/014-parquet-preview-format.md`
- DuckDB-WASM データエクスプローラー → `docs/adr/016-duckdb-wasm-data-explorer.md`
- 統一 preview-url エンドポイント → `docs/adr/015-unified-preview-url.md`（置換済み → ADR-017）
- サーバー経由ダウンロード・プレビュー URL → `docs/adr/017-server-proxied-download.md`
- Web=App Runner, Worker=Fargate → `docs/adr/018-app-runner-plus-fargate.md`（置換済み → ADR-020）
- Web=ECS Fargate+ALB, Worker=Fargate → `docs/adr/020-ecs-fargate-alb-migration.md`
- ロギング戦略 → `docs/adr/019-logging-strategy.md`
- リソースコンテンツ全文検索 → `docs/adr/021-resource-content-indexing.md`
- DB ポーリングによる SQS 代替（提案） → `docs/adr/022-db-polling-queue.md`

新しい設計判断が必要になったら、同じフォーマットでADRを追加する。
既存ADRの判断を覆す場合は、新ADRで「ADR-XXX を置換する」と明記し、
旧ADRのステータスを「置換済み」に更新する。
詳細の補足や誤記修正は既存ADRを直接編集してよい。

## 現在のフェーズ

**Phase 4: AWS デプロイ & CDK 基盤**（実装仕様書: `docs/specs/phase4-deploy.md`）

- Phase 1: Foundation ✅ 完了
- Phase 2: フロントエンド ✅ 完了（実装仕様書: `docs/specs/phase2-frontend.md`）
- Phase 3: リソース処理 & ファイルストレージ ✅ 完了（実装仕様書: `docs/specs/phase3-pipeline.md`）

## パイプライン フォーマット別処理マトリクス

パイプラインは Fetch → Extract → Index の3ステップ。
Index ステップでリソースコンテンツのテキスト抽出・OpenSearch 投入を行う（ADR-021）。
メタデータの検索インデックス更新は API ルートハンドラーで CUD 操作時に実行。
Extract のみフォーマット別処理を行う。

| フォーマット | isTextFormat | エンコーディング検出                         | Parquet 生成 |    プレビュー表示     |
| ------------ | :----------: | -------------------------------------------- | :----------: | :-------------------: |
| CSV          |     Yes      | `Encoding.detect()`                          |     Yes      | テーブル+テキスト切替 |
| TSV          |     Yes      | `Encoding.detect()`                          |     Yes      | テーブル+テキスト切替 |
| TXT          |     Yes      | `Encoding.detect()`                          |      -       |       テキスト        |
| HTML/HTM     |     Yes      | `Encoding.detect()`                          |      -       |       テキスト        |
| XML          |     Yes      | `<?xml encoding>` 宣言パース、fallback UTF-8 |      -       |       テキスト        |
| JSON         |     Yes      | UTF-8 固定（RFC 8259）                       |      -       |       テキスト        |
| GeoJSON      |     Yes      | UTF-8 固定（RFC 7946）                       |      -       |   地図+テキスト切替   |
| MD           |     Yes      | UTF-8 固定                                   |      -       |       テキスト        |
| RDF          |      No      | スキップ                                     |      -       |        非対応         |
| PDF          |      No      | スキップ                                     |      -       |    iframe（本体）     |
| XLSX/XLS     |      No      | スキップ                                     |      -       | Office Online Viewer  |
| DOC/DOCX     |      No      | スキップ                                     |      -       | Office Online Viewer  |
| PPT/PPTX     |      No      | スキップ                                     |      -       | Office Online Viewer  |
| ZIP          |      No      | JSONマニフェスト生成（yauzl）                |      -       |     ファイル一覧      |

**サイズ制限:**

| 項目                     | 制限値 | 設定ファイル                |
| ------------------------ | ------ | --------------------------- |
| ブラウザアップロード     | 100 MB | `apps/web/src/config.ts`    |
| 外部 URL 取得（Fetch）   | 100 MB | `apps/worker/src/config.ts` |
| CSV/TSV Parquet 生成対象 | 50 MB  | `apps/worker/src/config.ts` |

**関連ファイル:**

- フォーマット判定: `packages/shared/src/formats.ts`（`isTextFormat`, `isCsvFormat`, `isZipFormat`, `isOfficeFormat`）
- エンコーディング検出: `apps/worker/src/pipeline/node-utils.ts`（`detectEncoding`）
- Extract ステップ: `apps/worker/src/pipeline/steps/extract.ts`
- フロントエンド プレビュー: `apps/web/src/components/resource-preview.tsx`
- GeoJSON 地図プレビュー: `apps/web/src/components/geojson-preview.tsx`, `geojson-map.tsx`（Leaflet + OSM/国土地理院切替）

## よく使うコマンド（セットアップ後）

```bash
pnpm install                    # 依存関係インストール
pnpm dev                        # 全apps/packages の開発サーバー起動
pnpm build                      # 全パッケージビルド
pnpm test                       # 全テスト実行
pnpm db:generate                # Drizzle マイグレーション生成
pnpm db:migrate                 # マイグレーション実行
pnpm lint                       # ESLint
pnpm typecheck                  # TypeScript 型チェック
```

### AWS デプロイ

```bash
cd infra
npx cdk deploy                  # KukanStack デプロイ
npx cdk diff                    # デプロイ前の差分確認
```
