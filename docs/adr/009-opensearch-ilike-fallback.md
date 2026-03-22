# ADR-009: 日本語全文検索は OpenSearch + ILIKE フォールバック

## ステータス

改訂済み（2026-03-17） — pg_trgm GIN インデックス追加
改訂済み（2026-03-08） — 旧: pg_bigm 採用（2026-03-01）

## コンテキスト

Phase 1 で PostgreSQL 全文検索をフォールバック検索として実装するが、
PostgreSQL標準の `to_tsvector` は日本語のトークナイズに対応していない。

自治体オープンデータは日本語のタイトル・説明文が主体であり、
日本語検索は Phase 1 の時点で動作する必要がある。

旧 ADR-009 では pg_bigm を採用していたが、以下の理由で方針を変更した:

- pg_bigm は PostgreSQL のカスタム Docker イメージが必要（Alpine パッケージ未提供）
- 小規模デプロイでは ILIKE で実用上十分
- 中〜大規模デプロイでは pg_bigm ではなく OpenSearch を使うべき
- pg_bigm は「中間層」として保守コストに見合わない

## 検討した選択肢

### A) OpenSearch + ILIKE フォールバック — 採用

- 良い点:
  - OpenSearch は日本語形態素解析（kuromoji）をネイティブサポート
  - スコアリング、ファセット、サジェスト等の高度な検索機能
  - AWS OpenSearch Service / Docker コンテナ両対応でハイブリッドデプロイに適合
  - ILIKE フォールバックは追加拡張不要で全環境で動作
  - 検索バックエンドが2つ（OpenSearch / PostgreSQL ILIKE）で済む
- 問題点:
  - OpenSearch コンテナは最低 512MB〜1GB RAM が必要
  - ILIKE は大量データではフルスキャン（小〜中規模なら許容範囲）

### B) pg_bigm（旧決定）

- 良い点: 2-gram インデックスで言語非依存、Aurora PostgreSQL 対応
- 問題点:
  - カスタム Docker イメージが必要（postgres:16-alpine では未提供）
  - 1文字検索不可
  - 中〜大規模では結局 OpenSearch が必要 → 中間層の保守コストが無駄

### C) PGroonga

- 良い点: 高精度な日本語形態素解析
- 問題点: Aurora PostgreSQL 非対応、ハイブリッドデプロイ方針と矛盾

### D) mecab + pg_trgm

- 良い点: 形態素解析の精度が高い
- 問題点: mecab 辞書管理が煩雑、Aurora PostgreSQL 非対応

## 決定

**OpenSearch を本番検索エンジン、PostgreSQL ILIKE をフォールバックとする。**

| デプロイ規模      | 検索エンジン     | SEARCH_TYPE  |
| ----------------- | ---------------- | ------------ |
| 小規模 / 開発     | PostgreSQL ILIKE | `postgres`   |
| 中〜大規模 / 本番 | OpenSearch       | `opensearch` |

### PostgreSQL ILIKE フォールバック + pg_trgm GIN インデックス

- `package.name`, `package.title`, `package.notes` に対する ILIKE 検索
- `resource.name`, `resource.description` に対するリソースレベル ILIKE 検索（EXISTS サブクエリ）
- **pg_trgm GIN インデックス**で ILIKE クエリを高速化（3文字以上のクエリでインデックス有効）
- pg_trgm は PostgreSQL contrib モジュール（Aurora Serverless 含む全環境でプリインストール済み）
- 既存の ILIKE クエリをそのまま高速化（コード変更不要、透過的にインデックスが効く）
- `escapeLike()` で LIKE 特殊文字をエスケープ（`@kukan/shared` で共有）
- 1-2文字のクエリはフルスキャンにフォールバック（実用上許容範囲）

### OpenSearch（Phase 3 で実装）

- kuromoji アナライザーによる日本語形態素解析
- Docker コンテナ（`opensearchproject/opensearch`）と AWS OpenSearch Service の両方に対応
- Docker Compose では `profiles: [opensearch]` で opt-in 起動
- OpenSearchAdapter が `SEARCH_TYPE=opensearch` で切り替わる

## 実装

### PostgresSearchAdapter（ILIKE + pg_trgm）

```typescript
// packages/adapters/search/src/postgres.ts
// pg_trgm GIN インデックスにより、3文字以上の ILIKE クエリは自動的にインデックスを使用
const pattern = `%${escapeLike(query.q)}%`
const results = await db
  .select()
  .from(packageTable)
  .where(
    or(
      ilike(packageTable.name, pattern),
      ilike(packageTable.title, pattern),
      ilike(packageTable.notes, pattern),
      // リソースメタデータも検索対象
      sql`EXISTS (
        SELECT 1 FROM resource
        WHERE resource.package_id = package.id
        AND resource.state = 'active'
        AND (resource.name ILIKE ${pattern} OR resource.description ILIKE ${pattern})
      )`
    )
  )
```

### pg_trgm マイグレーション

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- パッケージレベル
CREATE INDEX idx_package_title_trgm ON package USING GIN (title gin_trgm_ops);
CREATE INDEX idx_package_notes_trgm ON package USING GIN (notes gin_trgm_ops);
CREATE INDEX idx_package_name_trgm ON package USING GIN (name gin_trgm_ops);
-- リソースレベル
CREATE INDEX idx_resource_name_trgm ON resource USING GIN (name gin_trgm_ops);
CREATE INDEX idx_resource_description_trgm ON resource USING GIN (description gin_trgm_ops);
```

### Phase 3: Docker Compose での OpenSearch

```yaml
# docker/compose.yml
services:
  opensearch:
    image: opensearchproject/opensearch:3
    profiles: [search]
    environment:
      - discovery.type=single-node
      - plugins.security.disabled=true
      - OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m
    ports:
      - '9200:9200'
    volumes:
      - opensearch-data:/usr/share/opensearch/data
```

### Phase 3: OpenSearchAdapter

```typescript
// packages/adapters/search/src/opensearch.ts
// Docker コンテナ: endpoint = http://localhost:9200
// AWS OpenSearch Service: endpoint = https://xxx.region.es.amazonaws.com
// AWS 環境では IAM ロール認証、コンテナではベーシック認証
```

## デュアルアダプター構成

`SEARCH_TYPE=opensearch` 環境でも、PostgresSearchAdapter は `dbSearch` として常にインスタンス化される（ADR-013 参照）。
ダッシュボード（`my_org=true`）は `dbSearch` で DB を直接クエリし、インデックス同期遅延の影響を受けない。
公開検索は `search`（OpenSearch）で kuromoji 形態素解析を活用する。

`SEARCH_TYPE=postgres` 環境では `search` と `dbSearch` が同一インスタンスを共用するため、追加コストは発生しない。

## 影響

- pg_trgm GIN インデックスにより、ILIKE 検索が数千〜数万件規模でも実用的なレスポンスタイム（パッケージ + リソース両方）
- Phase 3a: OpenSearch 3.x を Docker Compose に追加（`profiles: [search]` で opt-in）、OpenSearchAdapter 実装済み
- カスタム PostgreSQL Docker イメージは不要（素の `postgres:16` をそのまま使用）
- pg_bigm / PGroonga 等の非標準拡張は不要
- PostgresSearchAdapter はダッシュボード用 `dbSearch` としても活用され、全環境で DB 一貫性を保証
