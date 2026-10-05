# ADR-063 スパイク: 列の役割を規則で判定する

ADR-063（表のプロファイル）§決定 1 の規則を、手元の開発環境の CSV/TSV に当てて分類の当たり外れを見る
ハーネス。判定と内訳は `docs/adr/jp/063-table-profile-indexing.md` の「試行」節が正本。
結果の JSON（`results*.json`）はコミットしない。

## 実行方法

開発環境（`docker compose up` と、CSV/TSV を取り込み済みの `pnpm dev`）が動いている状態で:

```bash
node spike/adr-063/classify.mjs [--examples 12]
```

- 列スキーマとプレビュー Parquet の場所は `kukan-postgres` コンテナの `resource_pipeline` から読む
- Parquet は MinIO から DuckDB（worker の `@duckdb/node-api`）で直接読む。認証情報は `.env` の `S3_*`
- 標準出力に役割ごとの列数と例、外れやすい組み合わせ（1,000 種類を超えるカテゴリ・名称、コードに見える
  カテゴリ）を出す
