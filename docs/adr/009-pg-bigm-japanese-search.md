# ADR-009: 日本語全文検索は pg_bigm を採用する

## ステータス

承認済み（2026-03-01）

## コンテキスト

Phase 1 で PostgreSQL 全文検索をフォールバック検索として実装するが、
PostgreSQL標準の `to_tsvector` は日本語のトークナイズに対応していない。
`to_tsvector('simple', ...)` では日本語テキストが正しく分割されず、
検索精度が実用レベルに達しない。

自治体オープンデータは日本語のタイトル・説明文が主体であり、
日本語検索はPhase 1の時点で動作する必要がある。

## 検討した選択肢

### A) pg_bigm（2-gram全文検索）— 採用

- 良い点:
  - 2-gramインデックスで言語非依存（辞書不要）
  - `LIKE '%keyword%'` を高速化する GIN インデックス
  - インストールが簡単（`CREATE EXTENSION pg_bigm`）
  - PostgreSQL公式拡張リストに含まれる
  - Aurora PostgreSQL でも利用可能
  - 設定・運用コストが極めて低い
- 問題点:
  - 1文字検索が効かない（2-gramの制約）
  - 形態素解析ではないため、複合語の分割精度は劣る
  - インデックスサイズが大きくなりがち

### B) PGroonga（Groonga全文検索エンジン）

- 良い点: 高精度な日本語形態素解析、高速
- 問題点:
  - Aurora PostgreSQL で利用不可（カスタム拡張が必要）
  - オンプレのみ対応 → ハイブリッドデプロイ方針と矛盾
  - インストール・運用の複雑さ

### C) mecab + pg_trgm

- 良い点: 形態素解析の精度が高い
- 問題点:
  - mecab辞書のインストール・管理が必要
  - Docker/Lambdaでの辞書配布が面倒
  - Aurora PostgreSQLで非対応

### D) simple + ILIKE フォールバック

- 良い点: 追加拡張不要
- 問題点: 大量データでフルスキャンになり実用不可

## 決定

pg_bigm を採用する。

Phase 1（PostgreSQLフォールバック）で pg_bigm を使用し、
Phase 2 で OpenSearch に移行した後も、OpenSearch未導入環境（small / on-premise）では
pg_bigm が引き続きフォールバック検索を担う。

## 実装

### PostgresSearchAdapter での使用

```sql
-- 拡張有効化（マイグレーション）
CREATE EXTENSION IF NOT EXISTS pg_bigm;

-- インデックス作成
CREATE INDEX idx_package_title_bigm ON package USING gin (title gin_bigm_ops);
CREATE INDEX idx_package_notes_bigm ON package USING gin (notes gin_bigm_ops);

-- 検索クエリ
SELECT * FROM package
WHERE title LIKE '%オープンデータ%'
   OR notes LIKE '%オープンデータ%'
ORDER BY likequery(title, 'オープンデータ') DESC;
```

### Docker Compose での pg_bigm

```dockerfile
# docker/postgres/Dockerfile
FROM postgres:16-alpine
RUN apk add --no-cache postgresql16-pg_bigm
```

```yaml
# docker/docker-compose.yml
services:
  postgres:
    build: ./postgres # カスタムイメージ
    # ... 他設定同じ
```

### tsvector との併用

英語コンテンツには既存の `search_vector` (tsvector) が引き続き有効。
PostgresSearchAdapter 内で言語判定し、日本語は pg_bigm、英語は tsvector を使い分ける。

## 影響

- Docker Compose の postgres を素の `postgres:16-alpine` からカスタムビルドに変更
- Phase 1 仕様書の Docker Compose セクションを更新
- Aurora PostgreSQL は pg_bigm をサポートしているため、AWS環境でも同じ手法が利用可能
- Phase 2 で OpenSearch 導入後は、pg_bigm は OpenSearch 未導入環境のフォールバックとして残る
