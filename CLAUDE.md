# KUKAN — プロジェクトルール

> **Knowledge Unified Katalog And Network**
> CKANモダンクローン — 自治体・官公庁向けオープンデータカタログ基盤

## プロジェクト概要

CKANの後継として設計されたTypeScriptフルスタックのデータカタログシステム。
自治体のオープンデータ管理に特化し、日本のIT環境（閉域網 LGWAN 対応含む）で
動作するハイブリッドデプロイ設計。

設計書全文: `docs/design-v4.md`

## 技術スタック

| カテゴリ       | 技術                                                  |
| -------------- | ----------------------------------------------------- |
| 言語           | TypeScript 5.x（全レイヤー統一）                      |
| ランタイム     | Node.js 24 LTS                                        |
| モノレポ       | Turborepo + pnpm workspaces                           |
| API            | Hono 4.x（Cloudflare Workers / Node.js / Bun 対応）   |
| フロントエンド | Next.js 15 (App Router) + shadcn/ui + Tailwind CSS 4  |
| DB             | PostgreSQL 16 / Aurora Serverless v2                  |
| ORM            | Drizzle ORM（PostgreSQL ドライバ）                    |
| 検索           | OpenSearch 2.x / PostgreSQL全文検索（フォールバック） |
| ストレージ     | S3 / MinIO                                            |
| キュー         | SQS（AWS）/ InProcess（開発・オンプレ）               |
| キャッシュ     | lru-cache 11.x（インメモリ、全環境共通）              |
| 認証           | Better Auth 1.x + OIDC プラグイン                     |
| AI             | Bedrock / OpenAI / Ollama / NoOp                      |
| テスト         | Vitest + Playwright                                   |
| バリデーション | Zod                                                   |
| デプロイ       | AWS App Runner / Docker Compose                       |
| IaC            | AWS CDK (TypeScript)                                  |

## モノレポ構成

```
KUKAN/
├── CLAUDE.md               # ← このファイル
├── apps/
│   ├── api/                # Hono API サーバー + Better Auth
│   ├── worker/             # Ingest Worker（SQS consumer、AWS環境のみ）          ※ Phase 3+
│   ├── web/                # Next.js フロントエンド（カタログUI）                ※ Phase 2+
│   └── editor/             # Data Editor UI（アドオン、独立デプロイ可能）        ※ Phase 7+
├── packages/
│   ├── db/                 # Drizzle スキーマ + マイグレーション + Better Auth テーブル
│   ├── shared/             # 型定義、Zod バリデーション、lru-cache ユーティリティ
│   ├── adapters/           # 環境差吸収アダプター（4つ）
│   │   ├── search/         # @kukan/search-adapter (OpenSearch / PostgreSQL)
│   │   ├── storage/        # @kukan/storage-adapter (S3 / MinIO / Local)         ※ Phase 3+
│   │   ├── queue/          # @kukan/queue-adapter (SQS / InProcess)              ※ Phase 3+
│   │   └── ai/             # @kukan/ai-adapter (Bedrock / OpenAI / Ollama / NoOp)※ Phase 5+
│   ├── editor-core/        # Data Editor ビジネスロジック（アドオン）             ※ Phase 7+
│   ├── quality/            # Quality Monitor（リンク切れ、CSV検証、メタデータ監査、PII）※ Phase 4+
│   ├── pipeline/           # Ingest パイプライン（ステップ + processResource）   ※ Phase 3+
│   └── ui/                 # shadcn/ui 共有コンポーネント                        ※ Phase 2+
├── docs/
│   ├── design-v4.md        # 設計書（全体像、参照用）
│   ├── adr/                # Architecture Decision Records
│   └── specs/              # Phase別 実装仕様書
├── docker/                 # Docker Compose 設定（開発 / オンプレ）
├── infra/                  # AWS CDK スタック
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
| StorageAdapter | S3         | MinIO / ローカルFS     |
| SearchAdapter  | OpenSearch | PostgreSQL全文検索     |
| AIAdapter      | Bedrock    | Ollama / OpenAI / NoOp |
| QueueAdapter   | SQS        | InProcess              |

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

新しい設計判断が必要になったら、同じフォーマットでADRを追加する。
既存ADRの判断を覆す場合は、新ADRで「ADR-XXX を置換する」と明記し、
旧ADRのステータスを「置換済み」に更新する。
詳細の補足や誤記修正は既存ADRを直接編集してよい。

## 現在のフェーズ

**Phase 2: フロントエンド**（実装仕様書: `docs/specs/phase2-frontend.md`）

- Phase 1: Foundation ✅ 完了

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
