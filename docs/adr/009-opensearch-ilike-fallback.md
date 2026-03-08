# ADR-009: 日本語全文検索は OpenSearch + ILIKE フォールバック

## ステータス

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

### PostgreSQL ILIKE フォールバック（Phase 1 実装済み）

- `package.name`, `package.title`, `package.notes` に対する ILIKE 検索
- インデックス不要、追加拡張不要
- 数千件規模までは実用的なレスポンスタイム
- `escapeLikePattern()` で LIKE 特殊文字をエスケープ

### OpenSearch（Phase 3 で実装）

- kuromoji アナライザーによる日本語形態素解析
- Docker コンテナ（`opensearchproject/opensearch`）と AWS OpenSearch Service の両方に対応
- Docker Compose では `profiles: [opensearch]` で opt-in 起動
- OpenSearchAdapter が `SEARCH_TYPE=opensearch` で切り替わる

## 実装

### Phase 1: PostgresSearchAdapter（ILIKE）

```typescript
// packages/adapters/search/src/postgres.ts
const pattern = `%${escapeLikePattern(query.q)}%`
const results = await db
  .select()
  .from(packageTable)
  .where(
    or(
      ilike(packageTable.name, pattern),
      ilike(packageTable.title, pattern),
      ilike(packageTable.notes, pattern)
    )
  )
```

### Phase 3: Docker Compose での OpenSearch

```yaml
# docker/compose.yml
services:
  opensearch:
    image: opensearchproject/opensearch:2
    profiles: [opensearch]
    environment:
      - discovery.type=single-node
      - plugins.security.disabled=true
      - OPENSEARCH_INITIAL_ADMIN_PASSWORD=admin
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

## 影響

- Phase 1: ILIKE で検索が動作。追加設定不要
- Phase 3: OpenSearch を Docker Compose に追加（profiles で opt-in）、OpenSearchAdapter を実装
- カスタム PostgreSQL Docker イメージは不要（素の `postgres:16` をそのまま使用）
- pg_bigm 関連のマイグレーション・設定は不要になった
