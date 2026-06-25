# ADR-032: MCP データクエリ基盤（スキーマ永続化 + サーバーサイド DuckDB クエリ）

## ステータス

**承認（Accepted）** — Part A（スキーマ永続化、PR #8）、Part B（サーバーサイド DuckDB クエリ）ともに実装済み。

ADR-029「CSV/TSV プレビュー Parquet の列型自動推定」で得られる列スキーマを永続化し、
ADR-016「DuckDB-WASM データエクスプローラー」のクエリ機能をサーバーサイドに展開して
MCP（Model Context Protocol）から利用可能にする設計。

## コンテキスト

KUKAN には既に MCP サーバー（`packages/api/src/mcp/`、HTTP Streamable / ステートレス）があり、
`search_datasets` → `get_dataset` → `get_resource` という**カタログ探索**のツール群を公開している。
しかしツールはいずれも**メタデータ取得で止まっており、データ本体に対する操作ができない**。
AI エージェントから見ると「目次は読めるが本文が読めない図書館」の状態にある。

具体的なギャップは 2 つ:

1. **フィールド（列）が不可視**: リソースの列名・型は、利用者が Parquet をダウンロードして
   初めて分かる。実際には Extract ステップで型推論（ADR-029 `inferColumnType()`）が走り、
   列名・推論型がその瞬間に確定しているにもかかわらず、**結果を永続化せず捨てている**。
2. **サーバーサイドクエリができない**: SQL クエリは現状ブラウザ上の DuckDB-WASM
   （`apps/web/src/hooks/use-duckdb.ts` / `duckdb-sql.ts`）でしか実行できない。
   API・MCP からデータに対して集計・絞り込みをかける手段がない。

この 2 つを埋めると、

```
search_datasets → get_dataset → get_resource_schema → query_resource
```

という**閉じたエージェントループ**が成立し、KUKAN は「AI が自律的に探索・集計できるデータ基盤」へ
質的に変わる。CKAN の DataStore + datastore_search_sql に相当する機能を、
専用テーブル投入ではなく**既存の Parquet プレビューを直接クエリする**形で実現する。

## 検討した選択肢

### スキーマ可視化

- **A) 都度 Parquet フッタから抽出**: クエリ/表示のたびにストレージから Parquet フッタを
  Range 読みして列情報を得る。永続データ不要だが I/O が都度発生し、検索インデックスにも載せられない。
- **B) パイプライン時に永続化（採用）**: Extract で既に確定している列名・推論型を
  `resource_pipeline.metadata` に書き込む。追加コストはほぼゼロで、MCP・UI・将来の列名検索すべてに効く。

### サーバーサイドクエリの実行基盤

- **A) サーバーサイド DuckDB（採用）**: ネイティブ DuckDB で Parquet を直接クエリ。
  フロントの DuckDB-WASM とロジックを共有でき、列指向 Parquet の利点（projection/predicate pushdown）を活かせる。
- **B) PostgreSQL DataStore 方式（CKAN 型）**: リソースごとに Postgres テーブルを作って投入。
  スキーマ可変・大量リソースで重く、「アダプターを増やさない」設計思想（ADR-005）に反する。
- **C) クエリ非対応のまま**: ギャップが残る。却下。

### クエリインターフェース

- **A) 生 SQL（SELECT 限定・サンドボックス）（採用）**: AI は SQL に習熟しており最も柔軟・強力。
  集計・GROUP BY・式を自由に書ける。安全性は実行環境のサンドボックス化で担保する。
- **B) 構造化クエリ（filters/sort/aggregate）**: `duckdb-sql.ts` のロジックを共有しサーバーで SQL に
  コンパイル。攻撃面は小さいが表現力が限定的で、AI の強みを活かせない。

### クエリ実行プロセスの配置

- **A) API（web）プロセス内（採用）**: 実装が単純で、既存の storage アダプタ・認証・可視性チェックを
  そのまま使える。ネイティブアドオン依存とメモリ負荷を web に載せるトレードオフはあるが、
  プレビュー対象は ≤50MB に制限済み（ADR-029）で同時実行を絞れば許容範囲。
- **B) 専用クエリサービス / Worker 側**: 重いクエリを web から隔離できるがコンポーネントと
  デプロイ経路が増える。将来スケールが必要になった時点で切り出す（残課題）。

## 決定

**2 つの協調した変更を行う。**

### Part A — 列スキーマの永続化

1. Extract ステップ（`apps/worker/src/pipeline/steps/extract.ts`）で Parquet を生成する際、
   各列の `{ name, type, nullable, nullCount, stats? }` と `rowCount` を**スキーマとして組み立て**、
   `resource_pipeline.metadata.schema` に保存する。`type` は ADR-029 の推論型
   （`integer` / `float` / `boolean` / `string`）をそのまま用いる。
   `stats` は数値列（`integer` / `float`）の min/max（非 null 値が 1 つ以上ある場合のみ）で、
   セル変換と同一パスで（追加スキャンなしに）算出する。整数の min/max は INT64 が JS Number の安全域を超えうるため
   **十進文字列**、float は数値で保存する。distinct・合計・平均等は Parquet 統計の対象外のため
   Part B のクエリに委ねる。
2. 対象は **Parquet を生成するフォーマットのみ**（CSV/TSV・≤50MB）。それ以外（PDF・画像・
   大容量 CSV 等）は `schema` を持たない（`null`）。
3. 公開経路:
   - API: `GET /api/v1/resources/{id}/schema` — 可視性チェック後、保存済みスキーマを返す。
     スキーマ未生成（非対応フォーマット / 未処理）は 404 ではなく `queryable: false` を含む明示的レスポンス。
   - MCP: `get_resource_schema` ツール — 列名・型・行数・「`data` という名前のテーブルをクエリする」旨を
     テキストで返す。
4. **後方互換**: 既存リソースは再処理（`reprocess`）で順次スキーマが付与される。一括バックフィルは行わない
   （ADR-029 §7 と同じ方針）。

### Part B — サーバーサイド DuckDB クエリ

1. **ライブラリ**: `@duckdb/node-api`（公式ネイティブバインディング）を API プロセスに追加。
2. **公開経路**:
   - API: `POST /api/v1/resources/{id}/query`（body: `{ sql: string }`）
   - MCP: `query_resource(id, sql)` ツール（`readOnlyHint: true`）
3. **Parquet の取り込み**: storage アダプタでプレビュー Parquet（`preview_key`）を取得し、
   一時ファイルへ書き出す。クエリ後は `finally` で必ず削除する。
   （v1 では一時ファイルをキャッシュしない。web プロセスではメモリが希少資源のため Buffer を
   ヒープに載せず、ディスクの一時ファイル経由とする。`previewKey` をキーにした一時ファイル
   キャッシュ〔dispose で削除する専用 LRU〕は連続クエリの最適化として残課題 §4 で扱う。）
4. **サンドボックス（本 ADR の核心）**: クエリごとに**使い捨ての DuckDB インスタンス**を作り、
   次の順序で完全に隔離する。
   1. 外部アクセスが有効な状態で、Parquet を**インメモリテーブル `data` に実体化**する
      （`CREATE TABLE data AS SELECT * FROM read_parquet('<tmp>')`）。これ以降ファイルには一切触れない。
   2. 設定をロックダウンする:
      - `SET enable_external_access = false`（ファイル/URL/httpfs/COPY を全面禁止）
      - `SET autoinstall_known_extensions = false; SET autoload_known_extensions = false;`（拡張の取得禁止）
      - `SET memory_limit = '<上限>'; SET threads = <上限>;`（リソース制限）
      - `SET lock_configuration = true;`（以降ユーザー SQL から `SET` で戻せないようにする）
   3. **ユーザー SQL を検証**する（多層防御）:
      - 文を 1 つだけ許可（末尾以外の `;` を禁止）。
      - 先頭キーワードが `SELECT` または `WITH` のもののみ許可。`PRAGMA` / `ATTACH` / `COPY` /
        `INSTALL` / `LOAD` / `SET` / `CALL` / `EXPORT` / `INSERT` / `UPDATE` / `DELETE` / `CREATE` /
        `DROP` 等は拒否。
      - 先頭が `WITH` でも CTE が書き込み文を包む（`WITH x AS (...) DELETE ...`）ケースを防ぐため、
        文レベルの書き込み/DDL キーワードを拒否する（コメント・文字列を除去した上で判定。`replace` は
        SELECT 関数のため除外）。
      - ※ ②のロックダウンにより、検証をすり抜けてもファイルアクセス・DDL/DML・拡張ロードは
        実行できない。検証は防御の一層であって唯一の砦ではない。
   4. **行数・時間の上限**:
      - 結果ストリームを読みながら**最大行数で打ち切る**（クエリ形状に依存しない確実な上限）。
        併せて結果バイト数の上限も設ける。
      - **ウォールクロックのタイムアウト**で接続を `interrupt()` する（DuckDB に SQL レベルの
        statement_timeout がないため、タイムアウトで明示キャンセルする）。タイマーは materialize も
        覆い、巨大/異常な Parquet が接続とセマフォを占有し続けるのを防ぐ。超過は `408`
        （`RequestTimeoutError`）。
   5. クエリ終了後はインスタンスを破棄する。
5. **同時実行とメモリ**: セマフォで同時クエリ数を制限する。1 クエリの `memory_limit` と同時実行数で
   DuckDB のメモリピーク（≈ `memory_limit × 同時実行数`）を境界づける。超過分は `429`
   （`TooManyRequestsError`）を返す（キューイングしない）。**v1 既定は保守的に
   `memory_limit = 256MB` × 同時実行 1**（ピーク約 256MB）で web コンテナ（small=512MB）の OOM を
   避ける。デプロイ scale 連動は残課題。
6. **アクセス制御**: プレビュー（ADR-017）と同じ `getByIdWithAccessCheck` を通す。SQL 検証
   （長さ＋read-only）はダウンロード/materialize の**前**に実行し、MCP 経路でも長さ制限を担保する。
7. **クエリ対象の明示**: AI は固定テーブル名 `data` をクエリする。テーブル名・列・型は
   `get_resource_schema` の出力と `query_resource` の説明文に明記し、エージェントが
   スキーマを見てから SQL を書けるようにする。
8. **結果フォーマット**: API は JSON（`{ columns, rows, rowCount, truncated, elapsedMs }`、`rows` は
   列名キーのオブジェクト配列）、MCP `query_resource` は Markdown テーブルを返す。値は JSON 安全な
   形に直列化する（BIGINT 等は文字列）。

## 影響

- **DB**: スキーマ変更なし（`resource_pipeline.metadata` JSONB を拡張するのみ）。
  `metadata.schema` の型を `packages/shared` の Zod スキーマとして定義する。
- **Worker**: `extract.ts` がスキーマを組み立てて返し、`process-resource.ts` が
  `resource_pipeline.metadata` に保存する。型推論はすでに走っているため計算追加はほぼゼロ。
- **API**: `packages/api` に `@duckdb/node-api` 依存と、クエリ実行サービス
  （サンドボックス・セマフォ・タイムアウト）を追加。`RequestTimeoutError`(408) /
  `TooManyRequestsError`(429) を `@kukan/shared` に追加。`/schema`・`/query` ルートと
  MCP ツール 2 種を追加。
- **デプロイ**: `@duckdb/node-api` はネイティブアドオン（in-process。サイドカーではない）。
  `next.config` の `serverExternalPackages` に加えることで Next.js standalone のトレースに `.node` が
  含まれ、**alpine の musl バインディングが解決されるため Docker のベースイメージ変更は不要**
  （`node:24-alpine` で動作確認済み）。メモリ上限はクエリサンドボックス（`memory_limit`）と
  ECS タスク定義の両方で設定する。
- **セキュリティ**: 生 SQL を外部（AI）に開く口であり、サンドボックスの各設定（特に
  `enable_external_access=false` + `lock_configuration=true`）は必須。レビュー時の重点項目。
- **可観測性**: クエリ SQL・実行時間・打ち切り（行数/時間）をログに出す（ADR-019）。
- **テスト**:
  - SQL 検証関数のユニットテスト（複数文・非 SELECT・コメント偽装・大文字小文字）。
  - サンドボックスの統合テスト（`read_parquet`/`COPY`/`ATTACH`/`INSTALL` が確実に失敗すること、
    行数・タイムアウト上限が効くこと）。
  - スキーマ永続化のパイプライン統合テスト。

## 残課題（未解決事項）

1. **クエリ可能対象の拡大**: 現状 ≤50MB の CSV/TSV のみ。大容量ファイルや JSON 等への拡大
   （上限引き上げ、または raw ファイルへの DuckDB httpfs 直クエリ）。
2. **クエリサービスの切り出し**: 負荷増大時に web プロセスから専用サービス / Worker へ分離（選択肢 B）。
3. **クロスリソース JOIN**: 複数 Parquet を 1 クエリで結合する（複数テーブル登録）。需要を見て検討。
4. **一時ファイル/インスタンスのキャッシュ**: v1 はクエリごとに DL→削除。`previewKey` 単位の一時ファイル
   キャッシュ（dispose で削除する LRU）、さらにロック済み DuckDB 接続自体のキャッシュで連続クエリの
   レイテンシを下げる（同時実行管理が複雑化するため後続）。
5. ~~**結果フォーマット**~~（解決済み）: API=JSON、MCP=Markdown テーブルに決定（Part B-8）。CSV 等の
   追加形式は需要を見て検討。
6. **デプロイ scale 連動の上限**: `memory_limit` × 同時実行数を deployment scale（small/medium/large）に
   応じて env 注入し、medium 以上で同時実行を増やす（v1 は保守的な定数）。
7. **レート制限・課金**: AI からの高頻度・高コストクエリに対するレート制限とコスト可視化。

## 関連 ADR

- ADR-004: lru-cache（一時 Parquet のキャッシュに利用）
- ADR-005: アダプターは 4 つのみ（DuckDB はアダプター化しない＝本 ADR の方針の根拠）
- ADR-014 / ADR-016 / ADR-029: プレビュー Parquet・DuckDB エクスプローラー・列型推論（本 ADR が前提とする基盤）
- ADR-017: サーバー経由ダウンロード・プレビュー URL（可視性チェックの方式を踏襲）
- ADR-019: ロギング戦略（クエリログ）
- ADR-021: リソースコンテンツ全文検索（探索→クエリの導線で補完関係）
