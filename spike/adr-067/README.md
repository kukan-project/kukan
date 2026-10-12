# ADR-067 スパイク: DuckLake のカタログをリソース単位の SQLite ファイルにする

ADR-067（`docs/adr/jp/067-per-resource-lake-catalog.md`）§決定 7 の 7 項目を確かめるハーネス。
判定と実測値は ADR が正本で、ここには再現手段だけを置く。結果の JSON（`results*.json`）は
コミットしない。

## 構成

- カタログ: ローカルの SQLite ファイル（`--catalog duckdb` で DuckDB ファイル。選択肢 D との比較用）
- `DATA_PATH`: `compose.yml` の MinIO。`s3://$S3_BUCKET/spike-adr-067/<実行時刻>/lake/<resource>/<generation>/data/`
  （§決定 1 の配置。カタログは `DATA_PATH` の外）
- DuckDB は worker の `@duckdb/node-api`（1.5.5）を借りる。認証情報は `.env` の `S3_*`
- 表は合成データ（`id` を主キーにした 1 万行。版ごとに 20 行を変え、1 行を消す）。取り込みは
  `keyed-load.ts` と同じ 2 文の `MERGE INTO` を 1 トランザクションで

## 実行方法

`docker compose up` で MinIO が動いている状態で:

```bash
node spike/adr-067/check.mjs                       # SQLite カタログで全項目
node spike/adr-067/check.mjs --catalog duckdb      # DuckDB ファイルのカタログで同じ項目（4・7 を並べる）
node spike/adr-067/check.mjs --only 4 --versions 50
DUCKDB_EXTENSION_DIRECTORY=/path/to/exts node spike/adr-067/check.mjs --only 5
# 拡張ディレクトリは extension_directory を指定した DuckDB で INSTALL httpfs / aws / sqlite / ducklake して作る
```

## 項目

| #   | 確かめること                                                                                               | 関数        |
| --- | ---------------------------------------------------------------------------------------------------------- | ----------- |
| 1   | 全行置換・キー付き MERGE・`AT (VERSION => n)`・expire・cleanup・`merge_adjacent_files` が動くか            | `checks[1]` |
| 2   | `data_inlining_row_limit = 0` が再 ATTACH 後も効くか（1 行の INSERT がファイルを書くか）                   | `checks[2]` |
| 3   | DETACH 後に `-wal` / `-journal` が残らないか。コミット中に SIGKILL した本体の一貫性（`node:sqlite`）       | `checks[3]` |
| 4   | 版 N 本でのカタログの大きさと ATTACH の時間                                                                | `checks[4]` |
| 5   | `sqlite` 拡張を固定のディレクトリから自動ロード無しで読めるか                                              | `checks[5]` |
| 6   | `delete_orphaned_files` が `DATA_PATH` の外に触れないか。DuckLake が `DATA_PATH` に置く階層                | `checks[6]` |
| 7   | パージ後の再構築（1 版を抜いて N−1 版を取り込み直す）の時間                                                | `checks[7]` |
| 8   | 大きな差分: 版あたりの取り込み時間、差分の読み（遠い版・隣の版）、カタログの大きさ。`--rows` / `--changed` | `checks[8]` |
| 9   | 別の `DATA_PATH` で ATTACH し直したときの扱い（拒否と `OVERRIDE_DATA_PATH`）                               | `checks[9]` |

MinIO に書いた `spike-adr-067/` は消さない。終わったら手で消す。
