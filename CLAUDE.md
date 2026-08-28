# KUKAN — プロジェクトルール

> **Knowledge Unified Katalog And Network**
> みんなが使えるデータカタログ — CKANモダンクローン

## プロジェクト概要

CKANの後継として設計されたTypeScriptフルスタックのデータカタログシステム。
クラウド（AWS）からオンプレミス・閉域網（LGWAN等）まで対応するハイブリッドデプロイ設計。

設計書全文: `docs/design-v4.md`
パイプラインの実行時挙動（書き込みと条件の対応、オブジェクトの一生）: `docs/pipeline.md`

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
| デプロイ       | CloudFront + ALB + ECS Fargate / Docker Compose       |
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
│   ├── pipeline.md         # パイプライン実行時リファレンス（書き込みと条件の対応）
│   ├── adr/                # Architecture Decision Records
│   │   ├── jp/             # 日本語（正本）
│   │   └── en/             # English（機械翻訳・参考）
│   └── specs/              # Phase別 実装仕様書
│       ├── jp/             # 日本語（正本）
│       └── en/             # English（機械翻訳・参考）
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

- **PR titles must be in English and follow [Conventional Commits](https://www.conventionalcommits.org/)**
  — enforced by the `pr-guard` workflow (the PR title becomes the squash commit
  subject). Allowed types (`@commitlint/config-conventional`): `feat`, `fix`,
  `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- Commit messages: follow Conventional Commits format where practical.

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

| 領域                                              | レンダリング | API クライアント                    | 理由                                          |
| ------------------------------------------------- | ------------ | ----------------------------------- | --------------------------------------------- |
| 公開一覧（dataset, organization, group）          | SSR          | `serverFetch`（`server-api.ts`）    | SEO・初回表示速度                             |
| データセット詳細（dataset/[nameOrId]）            | SSR          | `serverFetch`（`server-api.ts`）    | SEO・OGP 対応                                 |
| リソース詳細（dataset/.../resource/[resourceId]） | SSR          | `serverFetch`（`server-api.ts`）    | SEO・ダウンロードリンク                       |
| データセット検索結果（dataset?q=...）             | CSR          | `clientFetch`（`client-api.ts`）    | OpenSearch 待ちを避け体感向上・クローラー制御 |
| Dashboard layout（認証ガード）                    | SSR          | `getCurrentUser`（`server-api.ts`） | 未認証フラッシュ防止                          |
| Dashboard 各ページ                                | CSR          | `clientFetch`（`client-api.ts`）    | インタラクティブ性・ページ遷移の軽量化        |
| ヘッダー                                          | SSR          | `getCurrentUser`（`server-api.ts`） | ユーザーメニュー表示                          |

- `server-api.ts` は `import 'server-only'` でクライアントバンドルへの混入を防止
- Dashboard のユーザー情報は `UserProvider`（layout SSR → 子 CSR）で伝播、`useUser()` で参照

### サービスとルートの責務分担

- **サービス（`services/`）**: データ操作とビジネスロジック。トランザクション、整合性チェック、CASCADE 処理を含む
- **ルート（`routes/`）**: 認証・権限チェック、リクエスト/レスポンスの変換、HTTP ステータスコードの決定

ルートは「認証 → 権限確認 → サービス呼び出し → レスポンス」に徹する。
ビジネスロジック（リンクチェック、FK の SET NULL、監査ログ記録等）はサービスに置く。

### エラーハンドリング

- カスタムエラークラスを使う（`KukanError` を基底クラス）
- エラーは発生箇所に最も近い場所でキャッチ
- APIレスポンスは RFC 7807 Problem Details 形式
  ```typescript
  { type: 'about:blank', title: 'Not Found', status: 404, detail: '...' }
  ```

### データベース

- すべてのテーブルに `id` (UUID), `created` (TIMESTAMPTZ), `updated` (TIMESTAMPTZ)
- 論理削除は使わない（`state` カラムで管理: package は `draft` / `active` / `deleted`、organization / group は `active` / `deleted`。
  package と organization は purge 遷移中に一時値 `purging` を取る — ADR-028 / ADR-039）
- マイグレーションは Drizzle Kit で管理
- **投影内の相関サブクエリを生 SQL で書かない。** `exists()` / `db.$count()` を使い、
  相関は WHERE 側に置く。FROM が単一テーブルのとき、Drizzle は投影に置かれた裸のカラム
  参照からテーブル修飾を落とす。`WHERE rv.resource_id = ${resource.id}` は
  `WHERE rv.resource_id = "id"` になり、内側スコープに解決されて**エラーを出さず常に
  false / 0 を返す**。型検査も、期待値が 0 のアサーションも素通りする。
  WHERE 句と JOIN のある select では修飾は保たれるので、危険なのは投影だけ。
  この種のクエリは `packages/api/src/__tests__/services/sql-shape.integration.test.ts`
  で発行 SQL を pin してから書き換える。ESLint の
  `kukan/no-raw-subquery-in-projection` が機械的に落とす。
  上流未修正（drizzle-team/drizzle-orm#5734、修正 PR #5795 も取りこぼしあり）
- `exists()` / `notExists()` の副問い合わせは `db.select({})` と書く。空の投影は
  `SELECT FROM t` を生み、PostgreSQL で有効。`select 1` は select リストが評価された
  時代の名残で、`select()`（引数なし）は全カラムを列挙するため、無関係なカラム追加で
  スナップショットが動く

### テスト

- ユニットテスト: Vitest（`*.test.ts`）
- 統合テスト: Vitest + テスト用DB（`*.integration.test.ts`）
- E2Eテスト: Playwright（`*.e2e.ts`、`apps/web/src/__tests__/e2e/`）
- テストファイルは `__tests__/` サブディレクトリに配置（例: `src/__tests__/errors.test.ts`）
- E2Eテストは dev サーバー + Docker Compose サービス起動中に実行
- **テストも型検査する。** `dist` へ emit するパッケージはビルド設定から `src/__tests__` を
  除外する必要があるため、`src/__tests__/tsconfig.json`（`noEmit`）を置き、`typecheck`
  スクリプトの追加パスとして実行する。型検査していないテストは、本番の型が変わっても
  黙って古いまま通る

### 環境変数

- `packages/shared/src/env.ts` で Zod バリデーション付きの環境変数定義
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

実装中に「なぜこの技術を選んだのか」迷ったら `docs/adr/jp/` を参照（英語版: `docs/adr/en/`）:

- ORM選定 → `docs/adr/jp/001-drizzle-orm.md`
- キュー方式 → `docs/adr/jp/002-sqs-over-bullmq.md`
- 認証方式 → `docs/adr/jp/003-better-auth.md`
- キャッシュ方式 → `docs/adr/jp/004-lru-cache-no-adapter.md`
- アダプター設計 → `docs/adr/jp/005-four-adapters-only.md`
- 品質監視 → `docs/adr/jp/006-quality-monitor-core.md`
- Data Editor → `docs/adr/jp/007-data-editor-addon.md`
- モノレポ → `docs/adr/jp/008-turborepo-monorepo.md`
- 日本語全文検索 → `docs/adr/jp/009-opensearch-ilike-fallback.md`
- テーマ戦略 → `docs/adr/jp/010-shadcn-ui-theming-strategy.md`
- バリデーション統一 → `docs/adr/jp/011-unified-validation-system.md`
- API ライブラリ化・単一オリジン → `docs/adr/jp/012-api-as-library-single-origin.md`
- 検索と DB フィルタリングの分離 → `docs/adr/jp/013-search-vs-db-filtering.md`
- プレビュー Parquet 形式 → `docs/adr/jp/014-parquet-preview-format.md`
- DuckDB-WASM データエクスプローラー → `docs/adr/jp/016-duckdb-wasm-data-explorer.md`
- 統一 preview-url エンドポイント → `docs/adr/jp/015-unified-preview-url.md`（置換済み → ADR-017）
- サーバー経由ダウンロード・プレビュー URL → `docs/adr/jp/017-server-proxied-download.md`
- Web=App Runner, Worker=Fargate → `docs/adr/jp/018-app-runner-plus-fargate.md`（置換済み → ADR-020）
- Web=ECS Fargate+ALB, Worker=Fargate → `docs/adr/jp/020-ecs-fargate-alb-migration.md`
- ロギング戦略 → `docs/adr/jp/019-logging-strategy.md`
- リソースコンテンツ全文検索 → `docs/adr/jp/021-resource-content-indexing.md`
- DB ポーリングによる SQS 代替（取り下げ） → `docs/adr/jp/022-db-polling-queue.md`
- ブランドオーバーライドレイヤー → `docs/adr/jp/023-brand-override-layer.md`
- GA4 アクセス統計 → `docs/adr/jp/024-ga4-access-analytics.md`
- OpenSearch parent-child 統合 → `docs/adr/jp/025-opensearch-parent-child-index.md`
- API Cache-Control 戦略 → `docs/adr/jp/026-api-cache-control.md`
- CloudFront 再導入 → `docs/adr/jp/027-cloudfront-reintroduction.md`
- 組織パージの非同期化と durable claim → `docs/adr/jp/028-org-purge-async-claim.md`
- CSV/TSV プレビュー Parquet の列型自動推定 → `docs/adr/jp/029-csv-type-inference.md`（ADR-014/016 拡張）
- CDK Pipelines + CodeConnections による自動デプロイ → `docs/adr/jp/030-cdk-pipelines-deploy.md`
- マルチ環境（dev/prd）デプロイ設計（CDK Stage） → `docs/adr/jp/031-multi-environment-deploy.md`
- MCP データクエリ基盤（スキーマ永続化 + サーバーサイド DuckDB） → `docs/adr/jp/032-mcp-data-query.md`
- 外部 SQL データソース（スナップショット/ライブ proxy 両論 + connector 拡張、提案） → `docs/adr/jp/033-external-sql-data-source.md`
- メタデータのベクトル検索（セマンティック検索・AI 向け発見） → `docs/adr/jp/034-metadata-vector-search.md`
- セマンティックバージョニングとリリースノート → `docs/adr/jp/035-semver-release-notes.md`
- DB バックエンドのランタイムシステム設定（初適用: ベクトルしきい値の目盛り調整） → `docs/adr/jp/036-runtime-system-settings.md`
- スケール連動バックアップ戦略（S3 バージョニング + AWS Backup + DB 保持期間） → `docs/adr/jp/037-backup-strategy.md`
- 初回ユーザーブートストラップとランタイム登録制御（初回登録者=sysadmin、`REGISTRATION_ENABLED` 廃止） → `docs/adr/jp/038-first-user-bootstrap.md`
- データセット下書き状態（draft、作成と公開の分離） → `docs/adr/jp/039-package-draft-state.md`
- AI メタデータ提案（提案型・オンデマンド生成） → `docs/adr/jp/040-ai-metadata-suggest.md`
- マルチサイトデプロイ（共用インフラ + サイト単位の論理分離、ADR-031 拡張） → `docs/adr/jp/041-multi-site-deploy.md`
- マルチブランドビルド（`KUKAN_BRAND` によるブランド選択、ADR-023 拡張） → `docs/adr/jp/042-multi-brand-build.md`
- リソースバージョニングと行レベル差分（DuckLake、層 1・ii-a 実装済み） → `docs/adr/jp/043-resource-versioning-ducklake.md`
- リソース単位の実行 claim（同時実行の排他） → `docs/adr/jp/044-resource-execution-claim.md`
- ストレージオブジェクトの先行記録（クラッシュ由来のリーク） → `docs/adr/jp/045-object-write-ahead.md`
- 正本の確定と、その解釈の分離（Version 先行 + DuckDB の Interpret ステージ） → `docs/adr/jp/046-interpret-stage.md`
- 取得内容が宣言と食い違うとき正本を差し替えない（サイト閉鎖時の一括転送、提案） → `docs/adr/jp/047-fetched-content-mismatch.md`

新しい設計判断が必要になったら、同じフォーマットで `jp/` と `en/` の両方にADRを追加する。
既存ADRの判断を覆す場合は、新ADRで「ADR-XXX を置換する」と明記し、
旧ADRのステータスを「置換済み」に更新する。
詳細の補足や誤記修正は既存ADRを直接編集してよい。

## 現在のフェーズ

**Versioning ii-b まで実装済み。** 層 1（正本バージョン保持・パージ）は v0.11.x、
層 2（DuckLake 行レベル差分、主キーなし）は v0.12.0、ii-b（主キー指定による変更行追跡。
巻き戻しの版発行化・`superseded` 廃止を含む）は v0.15.0 で入っている。
バージョン番号を書くのは「どこで入ったか」だけにする —
「最新リリースは」はリリースごとに古くなるので書かない。

**次: Phase Versioning-ii-c — 型の確定と降格の選択肢提示**
（実装仕様書: `docs/specs/jp/phase-versioning-2-ducklake.md` §8・§6.3・§6.5）。
着手前に §6.5 を読むこと — 確定型は版のゲートの 4 つ目の入力になる。主キー/型の AI 提案
（ADR-040 拡張）も ii-c の枠（同 §14.1 項目 4）。

- Phase 1: Foundation ✅ 完了
- Phase 2: フロントエンド ✅ 完了（実装仕様書: `docs/specs/jp/phase2-frontend.md`）
- Phase 3: リソース処理 & ファイルストレージ ✅ 完了（実装仕様書: `docs/specs/jp/phase3-pipeline.md`）
- Phase 4: AWS デプロイ & CDK 基盤 ✅ 完了（`docs/specs/jp/phase4-deploy.md`、ADR-030 / ADR-031）
- Phase 5a: メタデータベクトル検索 ✅ 完了（`docs/specs/jp/phase5-vector-search.md`、ADR-034）
- Phase Versioning-i: 正本バージョン保持 & パージ ✅ 完了
  （`docs/specs/jp/phase-versioning-1-file-retention.md`、ADR-043 層 1）
- Phase Versioning-ii-a: DuckLake 行レベル差分（主キーなし）✅ 完了
  （`docs/specs/jp/phase-versioning-2-ducklake.md`、ADR-043 層 2）
- Phase Versioning-ii-b: 主キー指定による変更行追跡 ✅ 完了
  （`docs/specs/jp/phase-versioning-2-ducklake.md` §6、ADR-043 層 2 / ADR-044 改訂）

実装仕様書も ADR と同様に日本語を正本とし、`docs/specs/jp/` と `docs/specs/en/` の
両方に置く（英語版は機械翻訳・参考）。仕様書を追加・更新したら両方を更新する。

## パイプライン フォーマット別処理マトリクス

パイプラインは Fetch → Version → Interpret → Lake → Index の5ステップ。
Index ステップでリソースコンテンツのテキスト抽出・OpenSearch 投入を行う（ADR-021）。
メタデータの検索インデックス更新は API ルートハンドラーで CUD 操作時に実行。
Interpret のみフォーマット別処理を行う。

| フォーマット                   | isTextFormat | エンコーディング検出                         | Parquet 生成 |    プレビュー表示     |
| ------------------------------ | :----------: | -------------------------------------------- | :----------: | :-------------------: |
| CSV                            |     Yes      | chardet（+ 日本語再検証）                    |     Yes      | テーブル+テキスト切替 |
| TSV                            |     Yes      | chardet（+ 日本語再検証）                    |     Yes      | テーブル+テキスト切替 |
| TXT                            |     Yes      | chardet（+ 日本語再検証）                    |      -       |       テキスト        |
| HTML/HTM                       |     Yes      | chardet（+ 日本語再検証）                    |      -       |       テキスト        |
| XML                            |     Yes      | `<?xml encoding>` 宣言パース、fallback UTF-8 |      -       |       テキスト        |
| JSON                           |     Yes      | UTF-8 固定（RFC 8259）                       |      -       |       テキスト        |
| GeoJSON                        |     Yes      | UTF-8 固定（RFC 7946）                       |      -       |   地図+テキスト切替   |
| MD                             |     Yes      | UTF-8 固定                                   |      -       |       テキスト        |
| RDF                            |      No      | スキップ                                     |      -       |        非対応         |
| PDF                            |      No      | スキップ                                     |      -       |    iframe（本体）     |
| XLSX/XLS                       |      No      | スキップ                                     |      -       | Office Online Viewer  |
| DOC/DOCX                       |      No      | スキップ                                     |      -       | Office Online Viewer  |
| PPT/PPTX                       |      No      | スキップ                                     |      -       | Office Online Viewer  |
| ZIP                            |      No      | JSONマニフェスト生成（yauzl）                |      -       |     ファイル一覧      |
| PNG/JPEG/GIF/WebP/SVG/BMP/TIFF |      No      | スキップ                                     |      -       |      img（本体）      |

**サイズ制限:**

| 項目                     | 制限値 | 設定ファイル                     |
| ------------------------ | ------ | -------------------------------- |
| ブラウザアップロード     | 100 MB | `packages/shared/src/formats.ts` |
| 外部 URL 取得（Fetch）   | 100 MB | `apps/worker/src/config.ts`      |
| CSV/TSV Parquet 生成対象 | 100 MB | `packages/shared/src/formats.ts` |

**関連ファイル:**

- フォーマット判定: `packages/shared/src/formats.ts`（`isTextFormat`, `isCsvFormat`, `isZipFormat`, `isOfficeFormat`, `isImageFormat`）
- エンコーディング検出: `packages/shared/src/encoding-node.ts`（`detectEncoding`）
- Interpret ステップ: `apps/worker/src/pipeline/steps/interpret.ts`
- フロントエンド プレビュー: `apps/web/src/components/resource-preview.tsx`
- GeoJSON 地図プレビュー: `apps/web/src/components/geojson-preview.tsx`, `geojson-map.tsx`（Leaflet + OSM/国土地理院切替）
- 画像プレビュー: `apps/web/src/components/image-preview.tsx`

## よく使うコマンド（セットアップ後）

```bash
pnpm install                    # 依存関係インストール
pnpm dev                        # 全apps/packages の開発サーバー起動
pnpm build                      # 全パッケージビルド
pnpm test                       # 全テスト実行（ユニット + 統合）
pnpm test:e2e                   # E2Eテスト実行（Playwright、要 dev サーバー）
pnpm db:generate                # Drizzle マイグレーション生成
pnpm db:migrate                 # マイグレーション実行
pnpm db:create-user             # ユーザー作成（初期 sysadmin 作成等）
pnpm eval:search                # 検索品質評価（ゴールデンセット、要稼働環境。ADR-034）
pnpm eval:suggest               # AI提案品質評価（ゴールデンセット、要稼働環境+KUKAN_TOKEN。ADR-040）
pnpm lint                       # ESLint
pnpm typecheck                  # TypeScript 型チェック
```

### AWS デプロイ

環境は `infra/config/environments.ts` で定義（`environments.example.ts` をコピー）。
通常は CDK Pipelines（push 起点）でデプロイ。合成パスが standalone と pipeline で異なり
物理リソース名が変わるため、**その環境を作った側の合成方法で手動操作する**（ADR-030 / ADR-031、`docs/specs/jp/phase4-deploy.md`）。

```bash
cd infra
# standalone 管理の環境（pipeline を使わない環境）: -c env で環境を選ぶ
npx cdk deploy -c env=dev 'Dev/**'            # 指定環境を直接デプロイ（Stage 配下を glob 指定。
                                              # --all はトップレベルのみ対象で Stage 内スタックを拾えない）
npx cdk diff   -c env=dev 'Dev/KukanStack'    # 差分確認（diff は --all 不可）

# pipeline 管理の環境を手動操作する場合: pipeline 修飾パスで指定し、-c env は付けない
# standalone 合成（-c env）だと物理名が変わり、置換や偽差分が発生する（例: scaling policy が
# 同一メトリクスで再作成衝突し「Only one TargetTrackingScaling policy ...」400）。
npx cdk deploy 'KukanPipeline/Dev/KukanStack' # 手動デプロイ（-c env なし）
npx cdk diff   'KukanPipeline/Dev/KukanStack' # 差分確認（-c env なし）
npx cdk deploy KukanPipeline                  # パイプラインスタック自体の初回デプロイ
```
