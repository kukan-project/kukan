# Changelog

All notable changes to KUKAN are documented in this file (English / 日本語).
This project adheres to [Semantic Versioning](https://semver.org/).

## [0.7.0] - 2026-07-07

The first tagged release of KUKAN. Earlier trial deployments tracked the `main`
branch; from this release on, use release tags (`vX.Y.Z`) and check this file
before upgrading.

**Breaking Changes**

- **The PostgreSQL container image changed from `postgres:16-alpine` to
  `pgvector/pgvector:pg16`** (#23). Database migrations now run
  `CREATE EXTENSION vector`, which fails on images without pgvector. When
  upgrading an existing Docker Compose deployment:
  - Development: recreate the `pgdata` volume (`docker compose down -v`).
  - Production: dump with `pg_dump` on the old container, restore on the new
    one. Reusing the volume as-is is not safe — the Alpine → Debian switch
    changes the collation implementation, which can silently corrupt indexes.

**Upgrade Notes**

- The local / on-premises OpenSearch heap default was raised from 512m to 2g
  to prevent circuit-breaker failures under load (#31). Ensure the host has
  enough RAM, or override via `OPENSEARCH_JAVA_OPTS`.
- AWS deployments now enable semantic search via Amazon Bedrock by default
  (Titan Text Embeddings v2). This adds Bedrock IAM permissions and
  per-invocation cost. Opt out with `bedrock: false` in
  `infra/config/environments.ts` (#36). **Cohere Embed v4 is the recommended
  model** — measurably stronger Japanese retrieval than the Titan default
  (nDCG 75 vs 70 on our golden set, +5–12pt on question-form queries). Set
  `bedrock: { embeddingModel: 'cohere.embed-v4:0' }`; it requires a one-time
  Marketplace subscription invoke (#37).
- After upgrading, rebuild the search index
  (`POST /api/v1/admin/reindex-metadata`) to populate embeddings and updated
  mappings.

**Highlights**

- **Semantic search over dataset metadata** (ADR-034): hybrid BM25 + vector
  search with RRF fusion (#25), natural-language queries in the search UI
  (#32), and a semantic match badge with an opt-out toggle (#26). Embeddings
  run on Bedrock (Titan v2 / Cohere Embed v4), Ollama (bge-m3), or OpenAI,
  with per-model similarity floors (#22, #27, #37) and a golden-set
  evaluation script (`pnpm eval:search`, #29).
- **Server-side data queries** (ADR-032): resource column schemas are
  persisted and exposed (#8), and resources can be queried with SQL through
  server-side DuckDB (#13) — the foundation for MCP-based data access by AI
  agents.
- **Multi-environment AWS deployment**: CDK Pipelines deploy each environment
  (dev / prd) from branch pushes via CodeConnections, on a CloudFront →
  internal ALB → ECS Fargate architecture (ADR-027 / ADR-030 / ADR-031).
- Everything the beta already shipped: dataset / organization / group catalog
  with a CKAN-compatible API, resource pipeline with format-aware previews
  (CSV/TSV tables, GeoJSON maps, PDF, Office, images), full-text search
  (OpenSearch with kuromoji, PostgreSQL fallback), DuckDB-WASM data explorer,
  GA4 analytics, brand customization, and on-premises Docker Compose
  deployment for air-gapped networks.

**Bug Fixes (notable)**

- Search returns 503 instead of silently showing zero results during an
  OpenSearch outage (#11).
- Hybrid search pagination stays consistent past the RRF fusion window (#35).
- Japanese request boilerplate (e.g. 「〜を教えてください」) is stripped from
  metadata queries before embedding (#34).
- Docker images: DuckDB crash on Alpine fixed and HIGH CVEs eliminated
  (#14, #15, #16); on-premises Docker Compose startup repaired (#17).

---

**破壊的変更**

- **PostgreSQL コンテナイメージを `postgres:16-alpine` から
  `pgvector/pgvector:pg16` に変更しました**（#23）。マイグレーションが
  `CREATE EXTENSION vector` を実行するため、pgvector を含まないイメージでは
  失敗します。既存の Docker Compose 環境をアップグレードする場合:
  - 開発環境: `pgdata` ボリュームを再作成（`docker compose down -v`）。
  - 本番環境: 旧コンテナで `pg_dump` → 新コンテナへリストア。Alpine → Debian
    の変更で照合順序（collation）の実装が変わるため、ボリュームの流用は
    インデックス破損の危険があり安全ではありません。

**アップグレード時の注意**

- ローカル / オンプレミスの OpenSearch ヒープのデフォルトを 512m から 2g に
  引き上げました（負荷時のサーキットブレーカー発動対策、#31）。ホストのメモリを
  確認するか、`OPENSEARCH_JAVA_OPTS` で上書きしてください。
- AWS デプロイでは Amazon Bedrock によるセマンティック検索がデフォルトで
  有効になります（Titan Text Embeddings v2）。Bedrock の IAM 権限と呼び出し
  コストが発生します。無効化は `infra/config/environments.ts` で
  `bedrock: false`（#36）。**推奨モデルは Cohere Embed v4** です — デフォルトの
  Titan より日本語検索が計測上優れています（ゴールデンセットで nDCG 75 対 70、
  質問文クエリで +5〜12pt）。`bedrock: { embeddingModel: 'cohere.embed-v4:0' }`
  で指定し、初回のみ Marketplace 購読のための invoke が必要です（#37）。
- アップグレード後は検索インデックスの再構築
  （`POST /api/v1/admin/reindex-metadata`）を実行し、埋め込みと新しい
  マッピングを反映してください。

**ハイライト**

- **メタデータのセマンティック検索**（ADR-034）: BM25 + ベクトルの
  ハイブリッド検索（RRF 融合、#25）、検索 UI での自然文クエリ対応（#32）、
  セマンティックマッチバッジと OFF トグル（#26）。埋め込みは Bedrock
  （Titan v2 / Cohere Embed v4）、Ollama（bge-m3）、OpenAI に対応し、
  モデル別の類似度しきい値（#22, #27, #37）とゴールデンセット評価スクリプト
  （`pnpm eval:search`、#29）を備えます。
- **サーバーサイドのデータクエリ**（ADR-032）: リソースの列スキーマを永続化・
  公開し（#8）、サーバーサイド DuckDB で SQL クエリが可能に（#13）。
  AI エージェントによる MCP 経由のデータアクセスの基盤です。
- **マルチ環境 AWS デプロイ**: CDK Pipelines + CodeConnections でブランチ
  push を起点に各環境（dev / prd）を自動デプロイ。CloudFront → 内部 ALB →
  ECS Fargate 構成（ADR-027 / ADR-030 / ADR-031）。
- ベータで提供済みの機能一式: データセット / 組織 / グループのカタログ管理と
  CKAN 互換 API、フォーマット別プレビュー付きリソースパイプライン
  （CSV/TSV テーブル、GeoJSON 地図、PDF、Office、画像）、全文検索
  （OpenSearch + kuromoji、PostgreSQL フォールバック）、DuckDB-WASM データ
  エクスプローラー、GA4 アクセス統計、ブランドカスタマイズ、閉域網向け
  Docker Compose オンプレミスデプロイ。

**主なバグ修正**

- OpenSearch 障害時に 0 件表示ではなく 503 を返すように（#11）。
- ハイブリッド検索のページネーションが RRF 融合ウィンドウを越えても一貫する
  ように（#35）。
- 「〜を教えてください」等の日本語定型句を埋め込み前にクエリから除去（#34）。
- Docker イメージ: Alpine での DuckDB クラッシュ修正と HIGH CVE の解消
  （#14, #15, #16）、オンプレ Docker Compose の起動不具合修正（#17）。
