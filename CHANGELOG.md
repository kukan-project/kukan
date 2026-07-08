# Changelog

All notable changes to KUKAN are documented in this file (English / 日本語).
This project adheres to [Semantic Versioning](https://semver.org/).

## [0.7.3] - 2026-07-08

Documentation-only patch release. No code changes.

**Documentation**

- The `environments.ts` sample in the system administrator guide (English / Japanese) now uses a consistent multi-line format for every environment entry — the `prd` entry was previously collapsed onto a single line (#46).

---

**ドキュメント**

- システム管理者ガイド（日英）の `environments.ts` サンプルで、1行に潰れていた `prd` エントリを他のエントリと同じ複数行フォーマットに統一（#46）。

## [0.7.2] - 2026-07-08

**Breaking Changes**

- **`brandConfig.searchExampleQueries` was removed** (#44). The example-query chips under the search box are now managed at runtime from the admin UI instead of the fork-side brand config. When upgrading a fork that sets this field: delete the `searchExampleQueries` line from `apps/web/src/brand/brand-config.ts` (the build fails until it is removed), then re-enter the queries in **Dashboard → Site Management → Example Search Queries**. Values are not migrated automatically.

**Upgrade Notes**

- Run database migrations after upgrading — this release adds a `system_setting` table (additive only; no changes to existing tables).
- `docker compose up` now starts the Ollama container as part of the default stack (it previously required `--profile ai`). With `AI_TYPE=ollama`, a one-shot `ollama-init` container downloads the embedding model (~1.2 GB) automatically on first start; it skips the registry entirely when the model volume is pre-distributed (closed networks). With other `AI_TYPE` values it exits immediately without downloading anything.

**Highlights**

- Sysadmins can now tune search behavior from the admin UI without a redeploy. A new **Site Management** page section controls three runtime settings: a semantic-search on/off switch, a similarity-threshold adjustment, and the example-query chips. Changes propagate to all instances within 30 seconds and every change is recorded in the audit log (#44).

**Features**

- DB-backed runtime settings foundation: a registry of settings (key + validation schema + default) backed by a `system_setting` table, exposed through a generic sysadmin API (`GET /api/v1/admin/settings`, `PUT /api/v1/admin/settings/:key`). Adding a future setting requires no new endpoint (#44).
- Semantic search kill switch: turning it off degrades all searches to keyword-only, skips query embedding entirely (no provider cost), and hides the semantic affordances in the search UI — the "include related results" toggle and the natural-language search placeholder. The same UI adjustments apply automatically on deployments without an embedding provider (`AI_TYPE=none`) (#44).
- Similarity-threshold adjustment: the vector-search similarity floor can be shifted ±4 notches of 0.025 around the model's measured baseline. The offset is stored relative to the baseline, so it remains meaningful when the embedding model changes; a golden-set sweep on bge-m3 measured overall nDCG@10 improving from 82% to 85% at −2 notches (#44).
- Example-query chips are now editable from the admin UI, so operators can keep them aligned with the catalog's actual content (#44).

---

**破壊的変更**

- **`brandConfig.searchExampleQueries` を削除**（#44）。検索ボックス下のクエリ例チップは、フォーク側ブランド設定ではなく管理画面からランタイムに管理する方式に変更。このフィールドを設定しているフォークをアップグレードする場合: `apps/web/src/brand/brand-config.ts` から `searchExampleQueries` 行を削除し（削除するまでビルドが失敗します）、**ダッシュボード → サイト管理 → 検索例クエリ** に値を入れ直してください。値の自動移行は行われません。

**アップグレード時の注意**

- アップグレード後にデータベースマイグレーションを実行してください — 本リリースで `system_setting` テーブルが追加されます（追加のみ。既存テーブルへの変更はありません）。
- `docker compose up` がデフォルトスタックの一部として Ollama コンテナを起動するようになりました（従来は `--profile ai` が必要）。`AI_TYPE=ollama` の場合、ワンショットの `ollama-init` コンテナが初回起動時に埋め込みモデル（約1.2GB）を自動ダウンロードします。モデルボリュームを事前配布している閉域網ではレジストリに接続せずスキップします。その他の `AI_TYPE` では何もダウンロードせず即終了します。

**ハイライト**

- 再デプロイなしで検索の挙動を管理画面から調整できるようになりました。**サイト管理**ページに、意味検索のオン/オフ・類似度しきい値の調整・検索例クエリの3つのランタイム設定が追加されています。変更は30秒以内に全インスタンスへ伝播し、すべての変更が監査ログに記録されます（#44）。

**機能**

- DB バックエンドのランタイム設定基盤: 設定のレジストリ（キー + 検証スキーマ + 既定値）を `system_setting` テーブルで永続化し、汎用の sysadmin API（`GET /api/v1/admin/settings`、`PUT /api/v1/admin/settings/:key`）で公開。今後の設定追加にエンドポイントの追加は不要です（#44）。
- 意味検索のキルスイッチ: オフにするとすべての検索がキーワード検索のみに退避し、クエリ埋め込み自体をスキップ（プロバイダ課金なし）。検索 UI の「意味の近い結果を含める」トグルと自然文プレースホルダーも非表示になります。埋め込みプロバイダのないデプロイ（`AI_TYPE=none`）でも同じ UI 調整が自動で適用されます（#44）。
- 類似度しきい値の調整: ベクトル検索の類似度下限を、モデル実測の基準値から ±4目盛り（1目盛り 0.025）で調整可能。オフセットとして保存されるためモデル変更後も意味が保たれます。bge-m3 のゴールデンセット評価では −2目盛りで overall nDCG@10 が 82% → 85% に改善（#44）。
- 検索例クエリを管理画面から編集可能に。カタログの実データに合わせて運用中に育てられます（#44）。

## [0.7.1] - 2026-07-07

Documentation-only patch release. No code changes.

**Documentation**

- The `.env` examples no longer suggest an OpenSearch heap below the compose default of 2g — copying the old values could reintroduce the circuit-breaker failures fixed in 0.7.0 (#41).
- Release notes in CHANGELOG.md are no longer hard-wrapped, fixing forced mid-sentence line breaks in GitHub Releases (#40).
- The landing page feature cards now describe the implemented semantic search and MCP SQL queries, with all cards aligned to a uniform length (#42).

---

**ドキュメント**

- `.env` の example が compose デフォルト（2g）を下回る OpenSearch ヒープ値を提案しないように修正。旧値をコピーすると 0.7.0 で修正したサーキットブレーカー問題が再発するため（#41）。
- CHANGELOG.md の折り返しを解除し、GitHub Release 本文で文の途中に強制改行が入る問題を修正（#40）。
- ランディングページの機能カードを、実装済みのセマンティック検索・MCP 経由 SQL クエリを反映した内容に更新し、全カードの分量を統一（#42）。

## [0.7.0] - 2026-07-07

The first tagged release of KUKAN. Earlier trial deployments tracked the `main` branch; from this release on, use release tags (`vX.Y.Z`) and check this file before upgrading.

**Breaking Changes**

- **The PostgreSQL container image changed from `postgres:16-alpine` to `pgvector/pgvector:pg16`** (#23). Database migrations now run `CREATE EXTENSION vector`, which fails on images without pgvector. When upgrading an existing Docker Compose deployment:
  - Development: recreate the `pgdata` volume (`docker compose down -v`).
  - Production: dump with `pg_dump` on the old container, restore on the new one. Reusing the volume as-is is not safe — the Alpine → Debian switch changes the collation implementation, which can silently corrupt indexes.

**Upgrade Notes**

- The local / on-premises OpenSearch heap default was raised from 512m to 2g to prevent circuit-breaker failures under load (#31). Ensure the host has enough RAM, or override via `OPENSEARCH_JAVA_OPTS`.
- AWS deployments now enable semantic search via Amazon Bedrock by default (Titan Text Embeddings v2). This adds Bedrock IAM permissions and per-invocation cost. Opt out with `bedrock: false` in `infra/config/environments.ts` (#36). **Cohere Embed v4 is the recommended model** — measurably stronger Japanese retrieval than the Titan default (nDCG 75 vs 70 on our golden set, +5–12pt on question-form queries). Set `bedrock: { embeddingModel: 'cohere.embed-v4:0' }`; it requires a one-time Marketplace subscription invoke (#37).
- After upgrading, rebuild the search index (`POST /api/v1/admin/reindex-metadata`) to populate embeddings and updated mappings.

**Highlights**

- **Semantic search over dataset metadata** (ADR-034): hybrid BM25 + vector search with RRF fusion (#25), natural-language queries in the search UI (#32), and a semantic match badge with an opt-out toggle (#26). Embeddings run on Bedrock (Titan v2 / Cohere Embed v4), Ollama (bge-m3), or OpenAI, with per-model similarity floors (#22, #27, #37) and a golden-set evaluation script (`pnpm eval:search`, #29).
- **Server-side data queries** (ADR-032): resource column schemas are persisted and exposed (#8), and resources can be queried with SQL through server-side DuckDB (#13) — the foundation for MCP-based data access by AI agents.
- **Multi-environment AWS deployment**: CDK Pipelines deploy each environment (dev / prd) from branch pushes via CodeConnections, on a CloudFront → internal ALB → ECS Fargate architecture (ADR-027 / ADR-030 / ADR-031).
- Everything the beta already shipped: dataset / organization / group catalog with a CKAN-compatible API, resource pipeline with format-aware previews (CSV/TSV tables, GeoJSON maps, PDF, Office, images), full-text search (OpenSearch with kuromoji, PostgreSQL fallback), DuckDB-WASM data explorer, GA4 analytics, brand customization, and on-premises Docker Compose deployment for air-gapped networks.

**Bug Fixes (notable)**

- Search returns 503 instead of silently showing zero results during an OpenSearch outage (#11).
- Hybrid search pagination stays consistent past the RRF fusion window (#35).
- Japanese request boilerplate (e.g. 「〜を教えてください」) is stripped from metadata queries before embedding (#34).
- Docker images: DuckDB crash on Alpine fixed and HIGH CVEs eliminated (#14, #15, #16); on-premises Docker Compose startup repaired (#17).

---

**破壊的変更**

- **PostgreSQL コンテナイメージを `postgres:16-alpine` から `pgvector/pgvector:pg16` に変更しました**（#23）。マイグレーションが `CREATE EXTENSION vector` を実行するため、pgvector を含まないイメージでは失敗します。既存の Docker Compose 環境をアップグレードする場合:
  - 開発環境: `pgdata` ボリュームを再作成（`docker compose down -v`）。
  - 本番環境: 旧コンテナで `pg_dump` → 新コンテナへリストア。Alpine → Debian の変更で照合順序（collation）の実装が変わるため、ボリュームの流用はインデックス破損の危険があり安全ではありません。

**アップグレード時の注意**

- ローカル / オンプレミスの OpenSearch ヒープのデフォルトを 512m から 2g に引き上げました（負荷時のサーキットブレーカー発動対策、#31）。ホストのメモリを確認するか、`OPENSEARCH_JAVA_OPTS` で上書きしてください。
- AWS デプロイでは Amazon Bedrock によるセマンティック検索がデフォルトで有効になります（Titan Text Embeddings v2）。Bedrock の IAM 権限と呼び出しコストが発生します。無効化は `infra/config/environments.ts` で `bedrock: false`（#36）。**推奨モデルは Cohere Embed v4** です — デフォルトの Titan より日本語検索が計測上優れています（ゴールデンセットで nDCG 75 対 70、質問文クエリで +5〜12pt）。`bedrock: { embeddingModel: 'cohere.embed-v4:0' }` で指定し、初回のみ Marketplace 購読のための invoke が必要です（#37）。
- アップグレード後は検索インデックスの再構築（`POST /api/v1/admin/reindex-metadata`）を実行し、埋め込みと新しいマッピングを反映してください。

**ハイライト**

- **メタデータのセマンティック検索**（ADR-034）: BM25 + ベクトルのハイブリッド検索（RRF 融合、#25）、検索 UI での自然文クエリ対応（#32）、セマンティックマッチバッジと OFF トグル（#26）。埋め込みは Bedrock（Titan v2 / Cohere Embed v4）、Ollama（bge-m3）、OpenAI に対応し、モデル別の類似度しきい値（#22, #27, #37）とゴールデンセット評価スクリプト（`pnpm eval:search`、#29）を備えます。
- **サーバーサイドのデータクエリ**（ADR-032）: リソースの列スキーマを永続化・公開し（#8）、サーバーサイド DuckDB で SQL クエリが可能に（#13）。AI エージェントによる MCP 経由のデータアクセスの基盤です。
- **マルチ環境 AWS デプロイ**: CDK Pipelines + CodeConnections でブランチ push を起点に各環境（dev / prd）を自動デプロイ。CloudFront → 内部 ALB → ECS Fargate 構成（ADR-027 / ADR-030 / ADR-031）。
- ベータで提供済みの機能一式: データセット / 組織 / グループのカタログ管理と CKAN 互換 API、フォーマット別プレビュー付きリソースパイプライン（CSV/TSV テーブル、GeoJSON 地図、PDF、Office、画像）、全文検索（OpenSearch + kuromoji、PostgreSQL フォールバック）、DuckDB-WASM データエクスプローラー、GA4 アクセス統計、ブランドカスタマイズ、閉域網向け Docker Compose オンプレミスデプロイ。

**主なバグ修正**

- OpenSearch 障害時に 0 件表示ではなく 503 を返すように（#11）。
- ハイブリッド検索のページネーションが RRF 融合ウィンドウを越えても一貫するように（#35）。
- 「〜を教えてください」等の日本語定型句を埋め込み前にクエリから除去（#34）。
- Docker イメージ: Alpine での DuckDB クラッシュ修正と HIGH CVE の解消（#14, #15, #16）、オンプレ Docker Compose の起動不具合修正（#17）。
