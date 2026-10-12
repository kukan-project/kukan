# ADR-067: 層 2 のカタログをリソース単位のファイルにし、パージを再構築で行う

## ステータス

**承認済み（Accepted）** — 2026-10-12（提案 2026-10-12）、実装済み（§決定 6 の旧カタログの削除コマンドを除く）

DuckLake のカタログを、PostgreSQL の 1 スキーマ（カタログ全体で 1 つ）から、**リソースごとの
SQLite ファイル**（データと同じ `lake/<resourceId>/` prefix に置く）へ移す。スナップショットの
一連番号がリソースの中に閉じるので、版のパージは「そのリソースの層 2 を捨て、残る版を
層 1 から取り込み直す」ことで**バイト列の消去を再び主張できる**ようになる。ADR-043 §5 が
ii-b で狭めた保証範囲を戻し、残課題 3（マルチサイト）を閉じ、残課題 7 の決着（「細粒度パージは
成立しないので、パージが主張する範囲を狭める」）を覆す。

層 2 を「層 1 から常に再構築できる派生インデックス」とする位置づけ（ADR-043 決定の冒頭）は
変えない。配信経路（プレビュー Parquet、ADR-032 / ADR-055）にも触れない。

> **この ADR は Claude Code で設計会話をもとに起こした草案を、v0.34.0（`490944dd`）のソースと
> 公式文書に突き合わせて直したものである。** 接触面と数値はソースから出した。spike
> （§決定 7、`spike/adr-067/`）は 2026-10-12 に通し、結果は §決定 7 の「実測」にある。

## コンテキスト

### 1. 器がカタログ規模である

DuckLake のスナップショットはカタログ全体で単調増加する 1 つの列である。リソース A の版 v3 の
データファイルは「A の v3 コミット〜v4 コミット」の間にある**すべての**スナップショットから見え、
その間に別リソース B がコミットしていれば、B の版行がそのスナップショットを名指ししている。
したがって A の v3 だけを expire できない。ADR-043 §5.1 はこれを「器の原則」と呼び、
`packages/lake/src/__tests__/purge.ducklake.test.ts`「leaves one table’s rows on the disk because
another table needs the snapshots」で固定している。

この性質から、ADR-043 は ii-b で次を受け入れた。

- **層 2 はバイト列消去を保証しない**（§5）。`ducklake_snapshot_id` を null 化して到達不能にする
  だけで、「法的削除」の語を落とした
- **expire は明示リスト方式**（§6-4）。ID がカタログ共通なので `older_than` が使えず、
  `reclaimInSession`（`packages/api/src/services/lake/lake-reclaim.ts`）が毎回「パージされて
  いない版が参照する ID」を**全リソース分**集め、`reclaimUnreferencedSnapshots`
  （`packages/lake/src/maintenance.ts`）がその補集合を `ducklake_expire_snapshots(versions => [...])`
  → `ducklake_cleanup_old_files(cleanup_all => true)` に渡す
- **層 2 への書き込みはカタログ全体で直列**になる。取り込み・パージの降ろし・回収は大域の
  advisory lock `LAKE_INGEST_LOCK`（`packages/api/src/services/concurrency/advisory-lock.ts`）の
  下で走る — スナップショット列と回収の集合計算がリソースを跨ぐためである
- **細粒度パージ（直前版に戻して後続版だけ再取り込み）は成立しない**（残課題 7 の決着）。
  再取り込みが新しいファイルを書いても、古いファイルは別リソースの保持スナップショットが掴んだまま
- **マルチサイト**（残課題 3）でカタログを分けるか決めていない。実際にはサイトごとに
  PostgreSQL のデータベースを分けている（ADR-041、`infra/lib/lambda/site-db-handler`）ので、
  各サイトの DB に同名の `ducklake` スキーマがある

### 2. パージの完全性が要る

行政のオープンデータでは、誤掲載・個人情報の混入・ライセンス違反で過去版を**消す**必要が出る。
「到達不能にした」では監査に答えにくく、「消えていないものを『削除しました』と報告しない」
（§5）という今の立場は誠実だが、消せないこと自体は解決していない。

### 3. 層 2 の用途は台帳である

v0.34.0 時点で DuckLake のテーブルを読むのは版の差分（`version-diff-service.ts` の `runDiff` →
`diffVersions`、サーバーが組み立てる固定クエリ）と、worker の取り込み・降ろしの内部の読みだけで
ある。`query_resource`・OData・プレビューはプレビュー Parquet を読む（`query-service.ts` /
`odata-service.ts` の `previewKey`）。主キーの事前検査（`checkKeyAgainstPreview`）も `scanLake` で
lake セッションを開くが、読むのはプレビュー Parquet でカタログではない。**版一覧は
`resource_version`（PostgreSQL）から出ており、DuckLake を読まない。**

カタログ横断の問い合わせは層 2 に求めていない（ADR-043 §4）。**単一カタログが与える「全テーブルを
同一スナップショットで読む」「1 回の ATTACH で全部見える」という性質を、何も使っていない。**

### 4. 同じリソースへの書き手は同時に 1 つである

層 2 へ書く経路は次で尽きる（v0.34.0）。

| 経路                                 | 入口                                                                       | 層 2 にすること                                                                                         | claim（ADR-044）     |
| ------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------- |
| パイプラインの Lake ステップ         | `steps/lake.ts` → `ingestVersionIntoLake` → `ingestParquetVersion`         | `CREATE TABLE AS` / キー付き `MERGE INTO`（`keyed-load.ts`）/ 全行置換 / 列が動けば `CREATE OR REPLACE` | `run`                |
| 再取り込み（`lake-ingest-version`）  | `retry-lake-ingest.ts`（失敗時・毎時スイープ・版の移行から積まれる）       | 同上                                                                                                    | `job`                |
| 版パージ（`purge-resource-version`） | `resource-version-service.ts` `purgeFromLake`                              | `DROP TABLE` か `restandLakeTable`（版行に記録しない載せ直し）、続けて回収                              | `job`                |
| パッケージ／下書きのパージ           | `package-service.ts` → `drop-lake-tables` ジョブ → `dropPurgedLakeTables`  | `DROP TABLE` + 回収                                                                                     | 無し（行が消えた後） |
| 組織パージ（`purge-organization`）   | `organization-service.ts` `purgeDeletedOrg`                                | `dropResourceTables` + `reclaimLakeStorage`                                                             | `job`                |
| 孤児掃除（毎時 cron）                | `sweep-lake-orphans.ts` → `deleteOrphanedFiles`、`queueStrandedLakeTables` | `ducklake_delete_orphaned_files`、取り残したテーブルの drop を再投入                                    | —                    |
| セッションを開くたび（web を含む）   | `connection.ts` `disableDataInlining`                                      | `data_inlining_row_limit` が 0 でなければ `set_option` で書く                                           | —                    |
| 管理者の全データ削除                 | `routes/admin.ts`（`DELETE /api/v1/admin/data`）                           | `lake/` prefix の削除と、PostgreSQL 側から `DROP SCHEMA ducklake CASCADE`                               | —                    |

同じリソースの層 2 を書き換える経路はどれも ADR-044 の実行 claim の下にある（パッケージ／下書きの
パージは行を消した後なので取り合う相手がいない）。**カタログの楽観ロックや複数書き手の調停は、
リソース単位にすれば要らない。** 今それを担っている大域ロックは、カタログを共有しているために
要るものである（§コンテキスト 1）。

### 5. 層 2 は表形式リソースにしかない

Lake ステップ（`apps/worker/src/pipeline/steps/lake.ts`）は、解釈（Interpret）がローカルに表を
書いたときだけ呼ばれ（`steps/interpret.ts` の `onTable` フック。手前で `isTableSourceFormat` に
合わない形式を返す）、自分ではフォーマットを判定しない。再取り込みジョブも同じ門を通る —
対象を選ぶ `pendingLakeIngestQuery`（`resource-version-service.ts`）が形式を表の源
（`TABLE_SOURCE_FORMATS`）とサイズ上限で絞り、`withInterpretedVersion` で解釈し直して表が出たときだけ
取り込む。

表を産むのは `TABLE_SOURCE_FORMATS = ['csv', 'tsv', 'json', 'geojson']`
（`packages/shared/src/formats.ts`）のうち、CSV/TSV と、レコードの一覧として読める JSON/GeoJSON
（ADR-063 §決定 10）である。**XLSX は表にならない** — 素直な表の XLSX を表として解釈する ADR-057 は
提案のままで、XLSX は文書テキストの経路だけを通る。PDF・Office 文書・一太郎・Markdown・画像・ZIP は
層 1 の版ファイルと文書テキスト成果物（`text.ndjson.zst`）までで、DuckLake に触れない。
**本 ADR の対象も表形式リソースだけ**である。

### 6. PostgreSQL と周辺にある DuckLake の痕跡

`ducklake` スキーマは DuckLake 拡張が `ATTACH 'ducklake:postgres:...' (METADATA_SCHEMA 'ducklake')`
で自前に作って管理するもので、Drizzle のマイグレーション対象ではない（ADR-043 §3-1）。
カタログを PostgreSQL から外すときに触る痕跡は次で尽きる。

- **`resource_version` の 6 列と部分索引 1 つ**（`packages/db/src/schema/resource-version.ts`）。
  `ducklake_snapshot_id`、`lake_key_columns`、`lake_ingest_reason`、`lake_ingest_queued_at`
  （スイープのリース）、`lake_ingest_failures`、`lake_ingest_failed_at`（ADR-043 の
  `ingest-failed`）と `idx_resource_version_pending_lake`。**本 ADR は
  `ducklake_snapshot_id` の代わりに新しい列を足し**（§決定 1）、残りはそのまま使える
- **`resource.column_settings`**（主キーの設定。版の作成時に `lake_key_columns` へ凍結される）。変えない
- **ジョブ種別** `lake-ingest-version` と `drop-lake-tables`（`pipeline-types.ts`）
- **スキーマ名の定数** `LAKE_METADATA_SCHEMA = 'ducklake'`（`packages/lake/src/config.ts`）と、
  それを使う ATTACH（`connection.ts`）と **admin ルートの `DROP SCHEMA IF EXISTS ducklake CASCADE`**
  （`routes/admin.ts`、全データ削除）
- **カタログ接続の予算** `WEB_LAKE_CATALOG_CONNECTIONS = 1` / `WORKER_LAKE_CATALOG_CONNECTIONS = 2`
  （`packages/shared/src/lake-limits.ts`）。`lake-scan.ts` と worker の `index.ts` が
  `pg_pool_max_connections` に渡し、`infra/lib/config.ts` が 1 タスクあたりの接続数に足して
  `max_connections` と照合する（`synth-multi-site.test.ts` が式を固定）。環境変数ではない
- **同梱する DuckDB 拡張**: `Dockerfile` の web / worker 両段が `httpfs`・`aws`・**`postgres`**・
  `ducklake` を `DUCKDB_EXTENSION_DIRECTORY` に入れ、`connection.ts` が同じ 4 つを読む。
  **`postgres` 拡張はカタログのためだけにある**
- **文書**: システム管理者ガイド（日英）の「差分のカタログは同じ PostgreSQL の `ducklake` スキーマに
  ある」、マルチサイトガイドと `docker/multi-site/README.md` のカタログ接続の内訳

テストはすでに PostgreSQL を使っていない。`*.ducklake.test.ts`（4 本: ingest / merge /
maintenance / purge）はローカルの DuckDB ファイルをカタログにしている
（`ATTACH 'ducklake:<dir>/catalog.ducklake'`）。

## 検討した選択肢

### A) 今のまま（単一カタログ、到達不能にするだけ）— 不採用

パージ完全性を諦めることになる。§コンテキスト 2 の要求に答えられない。

### B) データセット（package）単位のカタログ — 不採用

可視性・パッケージパージの単位と一致し、PostgreSQL のスキーマ数も `#datasets` に収まる。
しかし**同じデータセットの別リソースが掴む**ので器の原則は消えない。年度別 CSV が並ぶ
データセットはふつうにあり、そこでは A と同じ状態になる。将来の JOIN のために単一 ATTACH が
欲しいとしても、実需の結合はデータセットを跨ぐ（施設一覧 × 町丁目別人口）ので、データセット単位の
利益は限られる。どちらの目的にも中途半端。

### C) リソース単位、カタログは PostgreSQL のスキーマ — 不採用

器がリソースと一致し、パージは成立する。しかし DuckLake のカタログは `METADATA_SCHEMA` 1 つに
つき十数個の表を作るため、表形式リソース数万件の県サイトで数十万表になる。サイトごとに DB を
分けても（ADR-041）同じインスタンスに載るので合算される。`pg_catalog` の肥大、autovacuum、
バックアップ／リストア時間に効く。カタログ接続の予算も残る。

### D) リソース単位、カタログは DuckDB ファイル（S3 上） — 不採用（次点、spike で再判定）

スキーマ数の問題が消え、テストが今使っている形（`ducklake:<path>`）そのものなので、拡張を
増やさずに済む。

草案ではファイル形式の前方互換が無いことを退ける理由にしたが、**これは誤りだった**。DuckDB は
1.0 から 1.5 まで新しいファイルを既定で storage version `v1.0.0` で書き、古い 1.x でも読める
（「Forward compatibility is provided on a best effort basis」、`STORAGE_VERSION` を上げたときだけ
古い版から開けなくなる — <https://duckdb.org/docs/current/internals/storage.html>、
<https://duckdb.org/docs/current/sql/statements/attach.html>）。ロールバックで効くのはむしろ
**DuckLake のカタログ版**であり、これは D でも E でも同じである（§決定 1）。

残る差は次で、どれも決定的ではない。

- **大きさ**: DuckDB ファイルは既定 256 KiB ブロック（`BLOCK_SIZE` 既定 262144）で伸びるので、
  行が少なくてもカタログが大きくなる。実測で版 50・ファイル 97 本のカタログが **DuckDB ファイルで
  4.5 MB、SQLite で 188 KB**（約 24 分の 1、§決定 7）。差分のたびにダウンロードするので、この差は効く
- **DuckDB 無しで読めるか**: 監査・障害調査で sqlite3 CLI や Python 標準ライブラリから開ける。
  テストで「パージ後のカタログにパージ対象のファイルが載っていない」を DuckDB を介さずに確かめられる
- **公式の位置づけ**: DuckDB カタログは「limited to a single client」、SQLite は「multiple local
  clients」向け（<https://ducklake.select/docs/stable/duckdb/usage/choosing_a_catalog_database>）。
  KUKAN は毎回ファイルをダウンロードして開くので、どちらでも 1 クライアントではある

spike では SQLite に固有の不具合は出ず、ATTACH の時間も同じ（4 ms 前後）だった。書き込みは SQLite の
ほうが遅い（版 50 の取り込みで 16 秒対 9 秒）が、パージの再構築という稀な操作の時間で、差分のたびに
ダウンロードする大きさの差より軽い。**E を採る。** どちらでも§決定の 2〜6 は変わらない。

### E) リソース単位、カタログは SQLite ファイル（S3 上） — 採用

D の利点（スキーマ数・接続予算が消える）に加えて、上の 3 点。

代償は DuckDB の `sqlite` 拡張を同梱すること。ただし**カタログのためだけにある `postgres` 拡張が
不要になる**ので、閉域網向けに `DUCKDB_EXTENSION_DIRECTORY` で固定配布する拡張の数は変わらない
（`httpfs`・`aws`・`sqlite`・`ducklake`）。

### 補: Iceberg にしない理由

カタログをファイル化すると「新規インフラが要る」という ADR-043 の退け方は弱まる（KUKAN の
`resource_version` が metadata の場所を指せばカタログになる）。それでも DuckLake を続けるのは、
**書き手が今のランタイム（worker の DuckDB node-api、1.5.5）にある**から。

DuckDB からの Iceberg 書き込みは **Iceberg REST カタログを ATTACH したときに限られる**。
「Writing to a table read directly from storage with iceberg_scan is not supported」
「the catalog is required to commit the new table metadata」
（<https://duckdb.org/docs/current/core_extensions/iceberg/writing_to_iceberg.html>）、
「Attaching a catalog is required for writing to Iceberg」
（<https://duckdb.org/docs/current/core_extensions/iceberg/catalogs.html>）。ファイルシステム／
hadoop 型のカタログは文書に無い。書ける操作は揃ってきている（`CREATE TABLE`・`INSERT` が 1.4.0、
`UPDATE`・`DELETE` が 1.4.2、`MERGE INTO`・`ALTER TABLE` が 1.5.3 —
<https://duckdb.org/2025/11/28/iceberg-writes-in-duckdb.html>、
<https://duckdb.org/2026/05/29/new-iceberg-features>）が、merge-on-read のみで、ソートされた表への
更新・削除はできない。

したがって Iceberg にするには REST カタログ（Polaris・Lakekeeper 等、または AWS Glue / S3 Tables）を
同梱・運用することになり、TypeScript 単一のモノレポと閉域網配布の前提では「新規インフラ」と同じ
重さになる。Iceberg は外へ出す形（ADR-043 残課題 9 の export）として持つ。層 2 は再構築できるので、
この判断は後から覆せる。

## 決定（提案）

### 1. カタログの置き場所

- 1 リソース = 1 カタログ = 1 SQLite ファイル。テーブル名は今の `lakeTableName(resourceId)` のまま
  （カタログに 1 つしか無いが、名前を変える理由も無い）
- 配置は `lake/<resourceId>/` の下に**世代**を切る:

  ```
  lake/<resourceId>/<generation>/catalog.<token>.sqlite   ← コミットごとに新しい鍵
  lake/<resourceId>/<generation>/data/                    ← DuckLake の DATA_PATH
  ```

  - **カタログはコミットごとに新しい鍵へ書く。** 上書きにすると S3 バージョニングの noncurrent に
    旧カタログ（列統計に値そのものが入る）が残り、本 ADR の目的と矛盾する。「版鍵は動かない」
    （ADR-043 §1-2）と同じ規則
  - **カタログは `DATA_PATH` の外に置く。** `ducklake_delete_orphaned_files` は `DATA_PATH` 配下の
    「カタログが知らないファイル」を消すので、同じ場所に置くとカタログ自身が孤児と読まれうる
    （spike で確認、§決定 7-6）
  - **世代はパージの再構築（§決定 4）のたびに変わる。** 通常の取り込みは同じ世代に足していく。
    古い世代は prefix ごと消せばよく、データファイルを 1 本ずつ突き合わせる必要が無い

- 現在のカタログ鍵は**リソースに 1 つ**なので、`resource_pipeline` に `lake_catalog_key` を足す
  （草案は `resource_version` に置いたが、取り込みのたびにカタログが新しい鍵になるので、古い版の行が
  回収済みの鍵を指すことになる）。派生物のポインタ（`preview_key` 等）と同じ表で、claim もここにある。
  ただし `pipelineObjectKeys`（live 版のパージで捨てる派生物の一覧）には入れない — 層 2 は
  捨てるのではなく作り直すものだからである
- **スナップショットの番号は新しい列 `resource_version.lake_snapshot_id`（リソース内の番号）に持つ。**
  `ducklake_snapshot_id` は共有カタログの番号のまま触らない。同じ列を振り直すと、旧版へ戻したときに
  共有カタログの別のスナップショットを指し、キー付きの差分が黙って誤る（§決定 6）。取り込み待ちの
  部分索引は新しい列で作り直し、旧列と旧索引は §決定 6 の後片付けで外す。`lake_key_columns` など
  残りの 4 列は変えない
- **PostgreSQL の `ducklake` スキーマは不要になる。** Drizzle の外にあるので、移行完了後に
  `DROP SCHEMA ducklake CASCADE` を運用手順（システム管理者ガイド）に明記して削除する。
  admin の全データ削除からも `DROP SCHEMA` を外す（`lake/` prefix の削除だけで足りる）。
  libpq のカタログ接続が消えるので、`lake-limits.ts` の 2 定数、`infra/lib/config.ts` の接続予算の
  足し込み、`synth-multi-site.test.ts` の式、`LAKE_METADATA_SCHEMA` を外し、同梱拡張の `postgres` を
  `sqlite` に替える
- SQLite ファイルは S3 上で直接開けない（DuckDB の `sqlite` 拡張はローカルファイルを開く。DuckLake の
  文書は置き場所に触れていない）ので、**読みも書きも一度ローカルにダウンロードする**
- **データインラインはカタログを作るときに切る。** DuckLake 1.0（DuckDB 1.5.2 で同梱）から
  インラインは既定で有効（10 行）になった（<https://ducklake.select/2026/04/13/ducklake-10/>、
  <https://ducklake.select/docs/stable/duckdb/advanced_features/data_inlining>）。
  `set_option` は「Configuration is persisted in the ducklake_metadata table」
  （<https://ducklake.select/docs/stable/duckdb/usage/configuration>）なのでカタログに残る。
  新規作成の直後に 1 回書き、**セッションを開くたびに確かめて書く今の `disableDataInlining` は
  worker の取り込みに限る**（web はダウンロードしたカタログを読むだけで、書いても捨てるだけになる）
- **DuckLake のカタログ版の移行。** DuckLake 1.0 から、新しい拡張でカタログを開いても自動では
  移行しなくなった（ATTACH の `AUTOMATIC_MIGRATION` 既定 `false`、
  <https://ducklake.select/docs/stable/duckdb/usage/connecting>）。単一カタログなら移行は 1 回だが、
  リソース単位では**数万のファイル**になる。層 2 は再構築できるので、カタログ版が上がるリリースでは
  §決定 6 の再構築を流すのが基本形になる（残課題 6）
- 表形式でないリソースには `lake/<resourceId>/` を作らない（§コンテキスト 5）。同じリソースでも
  版によって表として読めた／読めなかったが変わりうる（CSV の破損、JSON の構造変化、format ラベルの
  訂正）。表として読めた版だけが層 2 に乗り、読めなかった版は `lake_snapshot_id` が null のまま
  層 1 にだけある — 現状と同じ

### 2. 取り込み（ingest）

今の `ingestVersionIntoLake` の中身（`ingestParquetVersion`、キー付き `MERGE INTO`、
1 版 = 1 スナップショット）はそのままで、前後が変わる。

1. `resource_pipeline.lake_catalog_key` のカタログをダウンロードする（無ければ新しい世代で新規作成し、
   インラインを切る）。ローカルパスを `ducklake:sqlite:` で ATTACH、`DATA_PATH` をその世代の
   `data/` に向ける
2. 取り込み（今のまま）
3. DETACH してジャーナルが本体に畳まれた状態にし、新しい鍵へ PUT。**PUT は先行記録に乗せる**
   （ADR-045）。行が入る前に落ちた試行のカタログは、参照ゼロのまま期限切れになりスイープが消す
4. 1 トランザクションで、版行の `lake_snapshot_id` を書き、`lake_catalog_key` を新しい鍵へ
   CAS で動かし（元の鍵が変わっていたら失敗）、旧カタログ鍵を回収予約する

取り込みはすでに claim の下にある（`run` / `job`）ので、**同じリソースへの同時書き込みは起きない。
大域の `LAKE_INGEST_LOCK` は外す。** このロックが守っているのは、カタログ全体の最大値で自分の
スナップショットを特定すること、base を読んでからコミットするまでの割り込み、回収の集合計算の 3 つで、
どれもカタログを共有しているために要るものである。使っている 4 か所（`lake-ingest.ts`、
`lake-reclaim.ts`、`resource-version-service.ts` の `purgeFromLake`、worker の `build-context.ts`）は
すべて層 2 で、代わりにコミットのトランザクションで `lake_catalog_key` の CAS と claim の保持
（`stillHeld`）を確かめる。

SQLite のジャーナルモードは既定の rollback journal にし、途中で落ちても本体ファイルが一貫している
ようにする。**落ちた試行のローカルファイルは使わずに捨てる。** コミット中に落ちると hot journal
（`-journal`）が残り、本体はその隣にあって初めて一貫する（§決定 7 の実測 3）。PUT するのは DETACH が
済んだファイルだけで、次の試行は必ず S3 からダウンロードし直す。落ちた試行の Parquet は世代の `data/` に孤児として残り、今と同じく
`ducklake_delete_orphaned_files` の cron が消す（cron はカタログごとに回すことになる。
毎時全件ではなく、取り込みに失敗したリソースだけを回す形で足りるかを実装時に決める）。

> **実装で決めたこと:** cron は使わない。書き込み（取り込み・再構築）がコミットの後に、そのリソースの
> prefix で現在のカタログが読まないもの（現在の世代でカタログが参照しないデータファイルと、他の世代）を
> 消す。失敗した書き込みは自分の書いたものを消す。それも片付けきれなかったときは、再構築ジョブ
> （`rebuild-lake-catalog`）が claim の下で片付け、失敗すればキューが再試行する。DuckLake のファイル名は
> UUID で一意なので、カタログが参照するファイル名と prefix の一覧の突き合わせで足りる。カタログ
> オブジェクトは先行記録（ADR-045）に任せる。旧カタログの `sweep-lake-orphans` は止めた（§決定 6）。

### 3. 読み取り

- 差分: `lake_catalog_key` のファイルをダウンロードして ATTACH（読み取り専用）し、`AT (VERSION => n)` で
  両端を開く（`diffVersions` はそのまま）。開くのは 1 リソース分なので、今より軽い。鍵は
  書き換わらないので、web はファイルを鍵で lru-cache してよい（ADR-004）
- 主キーの事前検査（`checkKeyAgainstPreview`）はプレビュー Parquet しか読まないので、カタログを
  開かずに済むようにする
- web の DuckDB の枠（`lake-scan.ts` が ADR-032 のクエリと共有する `withDuckdbSlot`）を使う経路は
  差分だけになる

### 4. パージ（再構築方式）

版パージの層 2 への波及を、「降ろし（`restandLakeTable`）+ 到達不能化 + best effort の回収」から
**再構築**に変える。**状態遷移と claim は今のまま**で、`purgeFromLake` の中身だけが入れ替わる。

今の流れ（`resource-version-service.ts`、ADR-043 §5 / ADR-028 の型）:

1. API の `claimPurge` が行を `active → purging` にし、同じトランザクションで
   `purge-resource-version` を積む（resource claim は取らない）。`purging` は 1 リソースに 1 行
   （`idx_resource_version_one_purging`）
2. worker の `executePurge` が **`withResourceClaimsOrConflict`（kind `job`）** の下で
   `purgeVersion` を走らせる。claim が取れなければ `ConflictError` で失敗し、キューが再試行する
3. `purgeVersion`: 層 1 の版ファイルを削除（**削除が先**）→ live 版なら派生物・内容索引を捨て、
   `purgeRebuildPending` を立てる → **`purgeFromLake`** → live を残る最上位の版へ戻す（無ければ空に）
   → `rebuildOnly` のパイプラインを積む → 墓標（`purged`、`ducklake_snapshot_id = null`）
4. 途中で落ちたら行は `purging` のまま。キューの再配送か、毎時の `queueStrandedPurges` が積み直す。
   各段は冪等

新しい `purgeFromLake`（claim の下、層 1 の削除の後）:

1. **再構築する。** パージ対象の版が層 2 に入っていなかった（`lake_snapshot_id` が null）なら
   この段を飛ばす。入っていたなら、**`purged` / `purging` 以外で `lake_snapshot_id` が非 null の版**
   を**版番号順に**層 1 から取り込み直し、新しい世代のカタログを作る。解釈は取り込みと同じく
   `withInterpretedVersion`（ADR-046）を通し、各版が凍結している `lake_key_columns` で MERGE するので、
   ii-b の履歴も再現される。対象を「表として解釈できる版」ではなく「層 2 に入っていた版」にするのは、
   主キーの不備で外した版（`lake_ingest_reason`）を混ぜず、未取り込みの版を今まで通りスイープに
   任せるためである。残る版が無ければカタログを作らない
2. **差し替える。** 新しいカタログを PUT（先行記録）し、1 トランザクションで残る版の
   `lake_snapshot_id` を振り直し、**パージ対象の行の `lake_snapshot_id` を null にし**、
   `lake_catalog_key` を新しい鍵（残る版が無ければ null）へ動かす。パージ対象の行を墓標より前に
   null にするのは、再試行で 1 を繰り返さないためである（振り直した後の番号は旧カタログの番号と
   衝突しうる）
3. **古い世代を消す。** `lake/<resourceId>/` の下の、現在の世代以外を prefix ごと削除する。
   **この段は 1 を飛ばしたときも毎回行う**ので、2 の直後に落ちた再試行もここで完了する。旧カタログは
   回収予約に回さず即時に消す（予約の猶予 1 時間 + スイープ周期のあいだ、列統計が残るため）

墓標は `lake_snapshot_id` と `ducklake_snapshot_id` の両方を null にする（後者は旧版へ戻したときのため、
§決定 6）。

今の 3 分岐（`stays` / `drop` / `onto`）と回収（`reclaimInSession`）は要らなくなる。再構築した
カタログでは、テーブルの現在内容は最後に取り込んだ版（残る `active` 版のうち層 2 に入っていた
最上位）であり、ADR-043 §5 の「層 2 の戻り先」と一致する — 番号を振り直すので「スナップショットが
最大で解決する版」と「版番号が最大の版」が食い違う履歴も残らない。

これで全行置換・キー付き・compaction 後のいずれでも、パージ対象の版に由来するバイト列は層 2 に
残らない。DuckLake のメタデータ表に入る列統計（ファイルごとの min/max。氏名列なら値そのもの）も
カタログごと消える。

**意味論は変わらない。** パージ対象の版が書いた行でも、後続版で現行のままなら残る — 後続版の
版ファイルから再び取り込まれるため。それは現行データであり消してはならない（ADR-043 残課題 7）。

**再構築は解釈のやり直しである。** 解釈の規則（型推定、JSON の平坦化など）が版を作った時点から
変わっていれば、再構築後の差分は今の規則で読んだものになる。層 2 は派生インデックスなので
これは許容する。今の規則で表にならない、あるいは凍結したキーが不正になる版が出たら、通常の取り込みと
同じく理由（キーの不備は `lake_ingest_reason`、表にならないのは `no_table_reason`）を記録して飛ばし、
パージは止めない。

**費用。** 1 回のパージで、そのリソースの層 2 に入っていた全版を解釈し直す（最悪で 100 MB × 版数）。
パージは sysadmin が理由を付けて行う稀な操作なので受け入れる。重い解釈は ADR-059 の子プロセスで走る。
claim は 15 分で古いと判定されるので（`CLAIM_STALE_AFTER_MS`）、版を 1 つ取り込むごとに claim の時刻を
延ばす。

**expire / cleanup / `merge_adjacent_files` の役割。** 版の取り込みは 1 版 = 1 スナップショットで
いずれかの版行が名指しし、降ろしの載せ直しも無くなるので、**通常運用で expire すべき
スナップショットは生まれない**。カタログ全体の集合演算（`reclaimInSession` と
`reclaimUnreferencedSnapshots`）は撤去する。`merge_adjacent_files`（仕様書 §11-2.1 で決定済み、
v0.34.0 では未配線）を配線するときは、置き換えた古いファイルを `cleanup_old_files` で消す必要が
残る。いずれもパージの完了をこれらに依存させない点は現状と同じ。

**パッケージ／組織パージ**は prefix の削除に単純化される。`dropResourceTables` と回収の代わりに
`lake/<resourceId>/` を消せばよく、カタログの外側にある順序の制約（行を消してから drop、取り残しの
再投入）も prefix 削除の冪等性で済む。`drop-lake-tables` ジョブを残すか、`purgePackageStorage` の
prefix 削除（`resources/`・`previews/`）に `lake/` を加えて畳むかは実装時に決める。

> **実装で決めたこと:** `drop-lake-tables` ジョブを残した（種別名もそのまま。アップデートの時点で
> 積まれていたジョブも、接頭辞の削除として走る）。web は行の削除と同じトランザクションでジョブを積み、
> worker が接頭辞を消す。対象は、層 2 に入ったリソースではなく全リソースにした — 初回の取り込みに
> 失敗したリソースは、カタログが無くても残骸を持ちうる。組織のパージは worker の中で走るので、claim の
> 下でその場で消す。取り残しの再投入（`queueStrandedLakeTables`）の代わりに、手動の照合ツール
> `reconcile-orphans` が、リソースの行が無い `lake/<resourceId>/` を回収予約に入れる。

### 5. 保証文

ADR-043 §5 の「層 2 はバイト列の消去を保証しない」を撤回し、代わりに次の形で書く。

> アプリからの到達経路なし、かつ層 1・層 2・層 3・検索索引から削除。
> ただし次は保持期間の経過で消える: S3 の noncurrent 版（ADR-037、30 日。MinIO は設定次第）、
> 途中の版が作った回収予約中のプレビュー（仕様書 §9.8、1 時間 + スイープ周期）、
> OpenSearch のセグメント内のトゥームストーン（マージまで）、PostgreSQL の dead tuple（VACUUM まで）、
> DB スナップショットと AWS Backup（保持期間）。

「法的削除」の語を戻すかは、この残置と、パージが残す人の書いた抄録（残課題 3）をどこまで保証文に
含めるかで決める（残課題 2）。

### 6. 移行と戻し

**移行は 1 つのリリースで一方向に行う。** 共有カタログとリソース単位のカタログを設定で切り替える形
（二重のモード）は取らない。層 2 は層 1 から作り直せる派生物なので、行き来できることより「戻しても
壊れず、戻ってきたら作り直せる」ことで足りる。利用者は版を飛ばして上げ下げできるので、順に適用する
ことを前提にした手当ては効かない — この節の手当てはすべて、そのリリース 1 つの中で完結する。

**移行の中身は、§決定 4 の再構築（パージ対象なし）を、層 2 を持つ全リソースに流すことである。**

- 対象は「`ducklake_snapshot_id` が非 null の版を持ち、`lake_catalog_key` がまだ無いリソース」で、
  事前に数えられる。各リソースを claim（`job`）の下で再構築するジョブを 1 つ足し、全件を積むジョブ
  （管理画面の「一度きりの移行操作」から）と、毎時の層 2 取り込みスイープが件数の上限つきで積む経路の
  両方から流す。ボタンが押されなくても、移行はいつか終わる
- 読むのは層 1 だけで、旧カタログは読まない。版番号・ハッシュ・`lake_key_columns` は
  `resource_version` にあり、書くのは新しい列 `lake_snapshot_id` だけ。`state = purged` の版は対象から
  自然に抜ける
- 移行が済んでいないリソースの差分は、既存の `'not-ingested'` で示す（残課題 1）

**欠けていたら作り直す。** `lake_catalog_key` の鍵が取得できない（404）、またはカタログが指すデータ
ファイルが欠けていたら、そのリソースを要再構築として扱い、同じ再構築を流す。次の 3 つの場面を、
この 1 つの規則で回復させる。

- 新しい版に上げた後で旧版へ戻し、24 時間以上たってから再び上げたとき（旧版の孤児掃除が新しい配置を
  消している。下の「戻し」）
- DB か S3 の一方だけを過去の時点へ戻したとき（下の「バックアップからの復元」）
- 運用者が `lake/` を手で消したとき

**旧カタログの孤児掃除を止める。** 旧カタログの `sweep-lake-orphans` は `DATA_PATH = lake/` の下で
「共有カタログが知らないファイル」を消すので、新しい配置 `lake/<resourceId>/` もそう見える。
新しい版では、共有カタログに対する孤児掃除は走らせない。同じリリースに入れれば足りる — 旧イメージ
との重なり（ローリング更新）は数分で、消されるのは 24 時間より古いファイルだけ
（`LAKE_ORPHAN_RETENTION_MS`）だからである。

**戻し。** 旧版のイメージへ戻すことはできる。旧版は共有カタログと `ducklake_snapshot_id` を使い、
新しい版はどちらにも書かないので、それらは移行前のまま残っている。新しい版で取り込んだ版は
`ducklake_snapshot_id` が null なので、旧版の毎時スイープが拾い直す。ただし次の制限を付ける。

- **新しい版でパージしたリソースは、旧版で層 2 の差分を保証しない。** パージの墓標は
  `ducklake_snapshot_id` も null にするので、パージした版を端点とする差分は開けない。しかし共有
  カタログのテーブルの現在内容は、パージした版のまま残りうる（次のキー付き取り込みの基準もずれる）。
  新しい版から共有カタログには接続しないので、これを手当てしない。旧版のままこのリソースの差分を
  正しくしたいなら、旧版のパージ経路は使えない — 新しい版へ戻るのが手当てである
- 戻している間に旧版の孤児掃除が新しい配置を消すと、再び新しい版へ上げたとき「欠けていたら作り直す」
  が働く。その間、差分は「未取り込み」と表示される

**旧カタログの削除。** 共有カタログ（`ducklake` スキーマ、Drizzle の外）と旧ファイル（`lake/main/`、
§決定 7-6）は、移行の残りが 0 になり、戻さないと判断してから削除する。AWS では PostgreSQL に直接
SQL を流す手順が無いので、`reconcile-orphans` と同じ形の worker の CLI を足す。既定は報告だけで、
`--commit` で `DROP SCHEMA ducklake CASCADE` と `lake/main/` の削除を行い、移行の残りが 0 でなければ
拒む。マルチサイトではサイトの DB ごとに実行する。**これを実行するまで、過去にパージした版の行は
旧カタログに残る**（§決定 5 の保証は、この削除の後に成り立つ）。

**バックアップからの復元。** DB か S3 のどちらかを過去の時点へ戻したら、`lake/` を戻そうとせず、
「欠けていたら作り直す」に任せる。`lake/` の noncurrent 版は復元しない（パージした行が戻るため）。
DB を戻すと、その時点より後に行ったパージの記録も消えるので、パージはやり直す（層 2 に限らない、
既存の性質である）。

最初の本番採用の公開前に入れれば、本番の履歴を一度も移行しない。

> **実装で決めたこと:**
>
> - **移行の操作は新しく足さず、既存の「バージョンの補完」を使う。** 取り込み待ちの判定が
>   `lake_snapshot_id` を見るので、旧カタログにしか無い版もそこに入り、取り込みジョブがリソースごとの
>   再構築に回す。取り込みジョブは解釈する前に移行前かを確かめ、解釈を無駄にしない
> - **毎時の取り込みスイープは 1 回 200 件まで**（`LAKE_INGEST_SWEEP_LIMIT`）。スイープのジョブは通常
>   優先度で、移行の直後は旧カタログのリソースが一度に対象になり、それぞれが全版を読み直す再構築に
>   なる。上限が無いと、最初のスイープが通常のアップロードより前に全部を並べる
> - **「欠けている」の判定は、ポインタの鍵が無いか（HEAD）、カタログが参照するファイル名が世代の
>   `data/` の一覧に無いか。** 判定するのは再構築ジョブで、取り込みの失敗と差分の読み取りの失敗が積む
>   （同じジョブが待っていれば積まない）。カタログが無い差分は「未取り込み」を返す
> - **再構築で読み取りが失敗する版は、`ingest-failed` として除いて続ける。** 1 つの版が毎回失敗すると、
>   再構築全体が止まり、移行もパージも終わらなくなるためである。ストレージに届かないとき（その版ファイル
>   の HEAD が失敗する）だけは、全版が同じく失敗するので記録せずに投げる
> - **移行前のリソースの版パージは、そのまま移行を兼ねる。** 再構築が旧カタログにしか無い版も読み直す
>   ため、パージの前に移行を済ませる必要は無い

### 7. spike で確かめること

実装の前に `spike/adr-067/` で通す。構成はローカルの SQLite カタログ + `DATA_PATH` が MinIO
（`compose.yml` のもの）。

1. `ingestParquetVersion` 相当の全行置換・キー付き `MERGE INTO`・`AT (VERSION => n)` の差分・
   `ducklake_expire_snapshots(versions => [...])`・`ducklake_cleanup_old_files`・
   `ducklake_merge_adjacent_files` が、DuckDB ファイルのカタログと同じ結果になるか。公式文書には
   SQLite カタログに固有の制約は書かれていない（違いが書かれているのはインラインの型の扱いだけ）。
   `MERGE INTO` は「only supports a single UPDATE/DELETE action currently」
   （<https://ducklake.select/docs/stable/duckdb/usage/upserting>）で、今のキー付き取り込みは
   upsert と delete を別の 2 文にしているので当たらないはず
2. `set_option('data_inlining_row_limit', 0)` が SQLite カタログに残り、DETACH → 再 ATTACH 後も
   効いているか
3. DETACH 後のファイルに `-wal` / `-journal` が残らないこと。取り込みの途中で止めた試行の
   本体ファイルが一貫していること
4. カタログファイルの大きさ（版 50・ファイル 500 で）と、ATTACH にかかる時間。DuckDB ファイルの
   カタログと並べる（選択肢 D の再判定）
5. `sqlite` 拡張を `DUCKDB_EXTENSION_DIRECTORY` から固定配布で読めること（DuckDB の版と揃える）
6. `ducklake_delete_orphaned_files` が `DATA_PATH` の外（カタログファイル）に触れないこと。あわせて
   今の単一カタログが `lake/` の下にどういう階層でファイルを置いているか（移行で消す範囲）
7. 再構築の時間（版 50 の CSV を版番号順に取り込み直す）

#### 実測（2026-10-12）

DuckDB 1.5.5（DuckLake `d8a1881e`）、開発環境の MinIO。表は `id` を主キーにした 1 万行で、版ごとに
20 行を変え 1 行を消す（`spike/adr-067/README.md`）。比較に同じ手順を DuckDB ファイルのカタログでも
流した。生の結果はコミットしない。

| #   | 確かめたこと                                                                           | SQLite                                                                                                                                                                    | DuckDB ファイル                                     |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1   | 全行置換・キー付き MERGE・`AT (VERSION => n)`・expire・cleanup・`merge_adjacent_files` | すべて動く。差分 39 行、cleanup 14 件、残るオブジェクト 4 本                                                                                                              | 同じ値                                              |
| 2   | `data_inlining_row_limit = 0` の永続                                                   | 再 ATTACH 後も `0`（scope `GLOBAL`）。1 行の INSERT がファイルを書く                                                                                                      | 同じ                                                |
| 3   | DETACH 後の残りと、コミット中の SIGKILL                                                | DETACH 後は本体だけ。5 回の SIGKILL で、3 回は `-journal` が残ったが `PRAGMA integrity_check` は 5 回とも `ok`、最新スナップショットはコミット済みの数と一致              | —                                                   |
| 4   | 版 50（ファイル 97 本）の大きさと ATTACH                                               | **188 KB**、ATTACH 4〜5 ms、取り込み 16.1 秒                                                                                                                              | 4.5 MB、3〜5 ms、9.5 秒                             |
| 5   | 拡張の固定配布                                                                         | `httpfs`・`aws`・`sqlite_scanner`・`ducklake` をすべて指定のディレクトリから、自動ロード無しで読めた                                                                      | —                                                   |
| 6   | `delete_orphaned_files` の範囲と配置                                                   | `DATA_PATH` の外は消さない（中の孤児は消す）。配置は `<DATA_PATH>/main/<table>/ducklake-<uuid>.parquet`                                                                   | 同じ                                                |
| 7   | 再構築（1 版を抜いて 49 版）                                                           | 17.0 秒                                                                                                                                                                   | 9.1 秒                                              |
| 8   | 大きな差分（10 万行 × 20 版、変更率 0.2% / 10% / 100%）                                | 取り込み 320 / 321 / 393 ms/版、差分の読み 60 / 61 / 56 ms、カタログ 147 KB                                                                                               | 148 / 188 / 246 ms/版、61 / 56 / 58 ms、4.2〜4.5 MB |
| 9   | 別の `DATA_PATH` で ATTACH し直す                                                      | 記録と食い違うと ATTACH がエラーで止まる。`OVERRIDE_DATA_PATH true` を付けると通り、既存のファイルは新しい `DATA_PATH` からの相対位置で読みにいく（移していなければ 404） | —                                                   |

読み取れること:

- **SQLite カタログに固有の制約は見つからなかった。** 1・2・6 は DuckDB ファイルのカタログと同じ値
- **3 は §決定 2 の規則を要る。** 本体は一貫しているが、それは隣の `-journal` があるときに限る。落ちた
  試行のファイルは捨てて S3 からダウンロードし直す
- **6 と同じ規則で、今の単一カタログ（`DATA_PATH` が `lake/`）のファイルは `lake/main/<table>/` にある。** 移行（§決定 6）で消すのは
  `lake/main/` で、新しい `lake/<resourceId>/` とは重ならない
- **7 から、パージの再構築は 1 リソース 50 版で十数秒。** 1 万行の表で、版の大きさに比例して伸びる
- **8 から、差分が大きくても SQLite と DuckDB ファイルの差は広がらない。** 差分の読みはどの変更率でも
  同じで、重さは両端の Parquet の量（表の大きさ）で決まる。書き込みの差は変更の量に比例せず、
  コミット 1 回あたりほぼ一定（約 150 ms）の上乗せである。カタログの大きさは変更率に関係なく約 30 分の 1

## 影響

- **変更箇所**（v0.34.0 で数えた）:
  - `packages/lake`（テストを除き 1,845 行）。主に `connection.ts`（356 行。ATTACH・拡張・
    インライン・プール設定）、`config.ts`（220 行。スキーマ名・接続文字列）、`table.ts`（124 行）、
    `maintenance.ts`（83 行。expire の集合演算を撤去）。`ingest.ts` / `keyed-load.ts` / `diff.ts` は
    ほぼ無変更、`restandLakeTable` は撤去
  - `lake-ingest.ts` / `lake-reclaim.ts`（371 + 179 = 550 行）。`lakeStandDown` と
    `reclaimInSession` が無くなり、カタログの取得・PUT・ポインタ移動が入る
  - `resource-version-service.ts` の `purgeFromLake` と、層 2 の移行・バックフィル経路
  - `organization-service.ts`、`package-service.ts`（パッケージ／下書きのパージ）、`routes/admin.ts`
    （全データ削除から `DROP SCHEMA` を外す）
  - worker の `build-context.ts`（429 行。層 2 の配線）、`steps/lake.ts`（62 行）、
    `retry-lake-ingest.ts`、`sweep-lake-orphans.ts`（48 行）、`index.ts`（カタログ接続数）
  - `lake-scan.ts`（113 行）は接続数の定数とキー検査の分岐が外れる。`version-diff-service.ts`（158 行）は
    ほぼ無変更
  - `packages/shared/src/lake-limits.ts`、`infra/lib/config.ts` の接続予算、`Dockerfile` の拡張
  - OData・サンドボックス・Interpret は `@kukan/lake` の DuckDB ヘルパーを借りているだけで触らない
- **テスト**: `*.ducklake.test.ts` 4 本はすでにファイルのカタログを使っているので、ATTACH の文字列を
  替えて動く想定。`purge.ducklake.test.ts` の「別テーブルが掴んで消えない」の固定は外し、
  「パージ後のカタログと世代にパージ対象のファイルが無い」へ置き換える。
  `synth-multi-site.test.ts` の接続数の式を替える
- **文書**: ADR-043 §5・§6-4・残課題 3・7 の改訂、`phase-versioning-2-ducklake.md` §9・§11-3、
  `docs/pipeline.md` / `docs/jobs.md` の版パージと `drop-lake-tables`、システム管理者ガイド（日英）の
  `ducklake` スキーマの記述と削除手順、マルチサイトガイドの接続数
- **DB**: Drizzle のマイグレーションは `resource_pipeline.lake_catalog_key` と
  `resource_version.lake_snapshot_id`、その取り込み待ちの部分索引の追加（追加のみなので、前のイメージでも
  動く）。`ducklake_snapshot_id` と旧索引は、旧カタログを削除した後のリリースで外す。`ducklake`
  スキーマの削除は Drizzle の外（§決定 6 の CLI）
- **CI**: DuckDB 拡張のキャッシュキーは `packages/lake/package.json` のハッシュで、`sqlite` を足しても
  変わらない。キーを変えないと古いキャッシュが当たり、テストが拡張を取りにいってタイムアウトする
- **実装の順序**: 再構築は移行のために作るので、パージも最初から再構築方式にする（共有カタログ前提の
  降ろしを新しいカタログの上で一度動かす中間段は作らない）。
  1. 列・索引の追加と、孤児掃除の参照確認に `lake_catalog_key` を足す
  2. `@kukan/lake` のセッションを別名つきにし、カタログを持たないセッションを足す（主キーの事前検査を
     そちらへ移す）
  3. `@kukan/lake` にカタログをダウンロード・ATTACH・DETACH・PUT する基本操作を足す
  4. 新しい配置での取り込み・差分・再構築方式のパージ・移行ジョブ・欠けていたら作り直す・旧カタログの
     孤児掃除の停止・`sqlite` 拡張と CI のキャッシュキー（ここまでが 1 つのリリース）
  5. パッケージ／組織のパージを prefix の削除にし、降ろし・回収・`LAKE_INGEST_LOCK` を撤去。文書と UI
  6. 旧カタログを削除する CLI。本番で移行を確かめた後に、`postgres` 拡張・接続予算・`ducklake_snapshot_id`
     を外す
- **運用**: 差分のたびにカタログファイルを 1 つ取得する（版 50 で 188 KB、鍵でキャッシュ可）。
  PostgreSQL の接続予算から libpq 分（web +1 / worker +2）が消える。マルチサイトの分離が自然に
  得られる（ADR-043 残課題 3）。DuckLake のカタログ版が上がるリリースでは再構築を流す
- **工数の目安**: カタログの切り替え自体は 1 週間程度。重いのは再構築方式のパージと、カタログ
  ファイルの先行記録・ポインタ移動。テスト・文書込みで 2〜4 人週

## 残課題

1. **再構築中の差分の見せ方。** `DiffUnavailableReason` に「再構築中」を足すか、既存の理由で足りるか
2. **保証文の確定**（§決定 5）。S3 noncurrent 版をパージ時に明示削除するか（ADR-043 残課題 8 と
   合わせる）、30 日の残置を保証文に書くか
3. ~~**派生物の波及。**~~ **解決済み（2026-10-12）。** 草案の時点では、パージ自体が AI 抄録
   （ADR-053）にもリソース埋め込み（ADR-054）にも触れず、リソースが空になるパージや Summarize が
   作り直さない条件（非公開・生成側なし）で、パージした内容から作った抄録が `resource.summary`・
   検索文書・埋め込みに残っていた。今はパージが**その版から作った AI 抄録**を消し（判定は抄録の版。
   live かどうかは問わない）、検索文書と埋め込みの同期を積む。抄録の表示設定の変更も、読んだ行への
   条件付き更新にして、パージが消した本文を書き戻さないようにした。

   **人が書いた抄録（`source: 'human'`）は意図して残す。** 編集者の文であり、パージした内容を引用して
   いるかは機械には分からない。保証文（§決定 5）がこれをどう書くかは残課題 2 で決める

4. **S3 接続設定の二重導出**（ADR-043 残課題 11）は本 ADR では解かない
5. **横断クエリ**は本 ADR の範囲外。やるならプレビュー Parquet の複数登録（ADR-032 残課題 3）で、
   層 2 の分割粒度とは独立
6. **DuckLake のカタログ版が上がるときの手順。** 再構築を流すのが基本形（§決定 1）だが、全件の
   再構築の時間と、その間の差分の見え方（残課題 1）は件数しだいで重い。`AUTOMATIC_MIGRATION` で
   開くたびに移行して新しい鍵へ書く遅延移行も選べるが、前のイメージへ戻すと移行済みのカタログが
   読めない。どちらにするかは初めてカタログ版が上がるときに決める
7. ~~**大域ロック `LAKE_INGEST_LOCK` の撤去**~~ **解決済み（2026-10-12）。** 使っている 4 か所は
   すべて層 2 で、外せる（§決定 2）
8. ~~**既にある SQLite カタログに別の `DATA_PATH` を渡して ATTACH したとき、どちらが効くか。**~~
   **解決済み（2026-10-12、§決定 7 の実測 9）。** カタログはデータファイルを `DATA_PATH` からの相対で
   持ち、記録と食い違う `DATA_PATH` はエラーで拒む。ATTACH では常に今の設定から `DATA_PATH` を組み立て
   `OVERRIDE_DATA_PATH` を付ける。バケットごと移したなら相対の配置が保たれて読め、移していなければ
   404 になって §決定 6 の「欠けていたら作り直す」が回復させる

## 関連

- ADR-043: リソースバージョニングと行レベル差分 — §5・§6-4 を改訂し、残課題 3 を閉じ、残課題 7 の
  決着を覆す
- ADR-044: リソース単位の実行 claim — 同じリソースへの書き手が 1 つである根拠
- ADR-045: ストレージオブジェクトの先行記録 — カタログファイルの PUT を乗せる
- ADR-046: 正本の確定と、その解釈の分離 — 再取り込みの単位（`withInterpretedVersion`）
- ADR-028: 組織パージの非同期化と durable claim — 版パージの状態遷移の型
- ADR-037: バックアップ戦略 — 保証文の残置期間の根拠
- ADR-041: マルチサイトデプロイ — カタログ分割の残課題を閉じる
- ADR-053 / ADR-054: AI 抄録とリソース埋め込み — パージの波及（残課題 3、解決済み）
- ADR-057: 素直な表の XLSX — 実装されれば層 2 の対象が増える
- ADR-059: worker の重い処理を子プロセスで — 再構築の解釈が走る場所
- ADR-005: アダプターは 4 つのみ — 拡張は入れ替えで数が変わらず、アダプターも増やさない
