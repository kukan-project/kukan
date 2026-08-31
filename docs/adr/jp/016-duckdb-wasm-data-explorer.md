# ADR-016: DuckDB-WASM によるデータエクスプローラー

## ステータス

**承認（Accepted）** — ADR-048 が置換を提案中（スパイク実測待ち）。対象は「解析モード」
トグルと全量バッファ登録の 2 決定で、DuckDB-WASM の採用自体は維持される。

## コンテキスト

ADR-014 で Parquet 形式のプレビューデータを採用し、`hyparquet` でブラウザ側の読み取りを行っている。
現状の制約:

1. **ページ内操作のみ**: フィルター・ソートは現在ロード済みの 100 行内でしか動作しない
2. **全データ対象の操作が不可**: 全行ソート・条件フィルター・集計には全データのメモリロードが必要
3. **全列 STRING**: 数値ソートが正しく動作しない（`"9" > "80"` になる）
4. **Row Group 統計が活用できない**: 型が STRING のため min/max 統計による Row Group スキップが無意味

CKAN のデータエクスプローラーのような、データの閲覧・フィルター・ソート・集計機能を実現したい。

## 検討した選択肢

### A) hyparquet のまま + クライアント側フィルター

- 良い点: 追加依存なし、軽量
- 問題点:
  - 全データ対象の操作には全行ロードが必要（10MB CSV で数万行）
  - SQL のような柔軟なクエリ不可
  - 集計機能の自前実装が必要

### B) サーバー側 API でフィルター・ソート

- 良い点: クライアント負荷が低い
- 問題点:
  - API エンドポイントの追加が必要
  - サーバー負荷増大
  - レイテンシがクライアント側処理より大きい

### C) DuckDB-WASM — 採用

- 良い点:
  - **SQL でクエリ**: `SELECT`, `WHERE`, `ORDER BY`, `GROUP BY`, `LIMIT/OFFSET` が全て使える
  - **型付き Parquet の活用**: 数値型・日付型の統計で Row Group スキップが可能（型推定追加後）
  - **集計機能**: SUM, AVG, COUNT, MIN, MAX 等がネイティブ
  - **業界標準**: データ分析エコシステムで広く採用
- 問題点:
  - WASM バイナリ ~35MB（EH バンドル、初回ロード。ブラウザキャッシュ後は 0）
  - メモリ使用量が hyparquet より大きい

## 決定

**DuckDB-WASM をデータエクスプローラーのクエリエンジンとして採用する。**

型推定（全列 STRING → 型付き Parquet）は後続フェーズで追加する。
現時点では全列を `CAST(col AS VARCHAR)` で比較し、STRING のままでも全機能が動作する設計とする。

### 1. DuckDB-WASM 統合

```
ブラウザ:
  DuckDB-WASM (内部 Web Worker)
    ↓ SQL クエリ
  registerFileBuffer (インメモリ)
    ↑ fetch + ArrayBuffer
  /api/v1/resources/:id/preview (同一オリジンプロキシ)
    ↓
  S3 / MinIO
```

- DuckDB-WASM インスタンスはシングルトンで管理（一度ロードすればページ内遷移で再ダウンロードなし）
- `httpfs` 拡張は使わず、`fetch` + `registerFileBuffer` でファイルを登録（httpfs の追加 WASM ロードを回避、同一オリジン API で CORS 問題なし）
- 遅延ロード: 「解析モード」を ON にしたときのみ WASM をロード（`next/dynamic` + `ssr: false`）
- WASM + Worker ファイルは `new URL(..., import.meta.url)` でバンドラに emit させ、
  `/_next/static/media/` からハッシュ付きで配信する。`public/` へコピーする方式は、
  固定パスゆえに `immutable` を付けられず（付ければ古いバイナリが固定される）、
  存在しないパスがキャッチオールページの HTML を 200 で返すため取りやめた

### 2. UI 設計: 解析モード

テーブル表示内の Switch トグル「解析モード」で hyparquet と DuckDB-WASM を切り替える:

- **OFF（デフォルト）**: hyparquet による軽量テーブル表示（WASM ロードなし）
- **ON**: DuckDB-WASM によるフィルター・ソート・検索付きテーブル

解析モードの状態は `sessionStorage` + `useSyncExternalStore` で管理:

- 同一セッション内でリソースをまたいで ON/OFF が保持される
- 複数の `TablePreview` インスタンスが同時に DOM に存在するケース（`ResourceExplorer` の `visitedIds` パターン）でも状態が同期される
- ページリロードで OFF にリセット（`sessionStorage` はタブ単位）

### 3. 現在実装済みの機能

| 機能               | SQL 変換例                                           |
| ------------------ | ---------------------------------------------------- |
| 列ソート           | `ORDER BY col ASC/DESC`                              |
| フィルター（等値） | `CAST(col AS VARCHAR) = 'value'`                     |
| フィルター（不等） | `CAST(col AS VARCHAR) != 'value'`                    |
| フィルター（含む） | `CAST(col AS VARCHAR) ILIKE '%keyword%'`             |
| フィルター（前方） | `CAST(col AS VARCHAR) ILIKE 'prefix%'`               |
| フィルター（後方） | `CAST(col AS VARCHAR) ILIKE '%suffix'`               |
| テキスト検索       | 全列に `CAST(col AS VARCHAR) ILIKE '%keyword%'` (OR) |
| ページネーション   | `LIMIT 100 OFFSET n`                                 |

### 4. 今後のフェーズ

| 順序 | 内容                                                             |
| ---- | ---------------------------------------------------------------- |
| 1    | ✅ DuckDB-WASM 統合 + 基本クエリ（ソート・フィルター・検索）     |
| 2    | Parquet 書き込み時の型推定追加（Extract ステップ、ADR-014 拡張） |
| 3    | 範囲フィルター（`BETWEEN`、型推定後に有効）                      |
| 4    | 集計・グラフ表示（Phase 7 Data Editor と連携）                   |

### 5. Parquet 書き込み時の型推定（フェーズ 2 で実装予定）

Extract ステップで CSV パース後、各列のデータ型を推定する:

| 推定型     | 条件                                    | Parquet 型                  |
| ---------- | --------------------------------------- | --------------------------- |
| 整数       | 全行が整数パターン（`/^-?\d+$/`）       | INT64                       |
| 浮動小数点 | 全行が数値パターン（`/^-?\d+\.?\d*$/`） | DOUBLE                      |
| 日付       | 全行が日付パターン（ISO 8601 等）       | STRING（将来 TIMESTAMP 化） |
| 文字列     | 上記以外                                | STRING                      |

注意点:

- 空文字・null は型推定から除外
- 先頭ゼロ付き数値（`"01234"`）は文字列として扱う（郵便番号等）
- 混合型の列は STRING にフォールバック
- 型推定は**ベストエフォート**。誤判定のリスクは許容し、元データは常に保持

## 影響

- `apps/web` に `@duckdb/duckdb-wasm` 依存を追加（遅延ロード）
- WASM バイナリ（mvp 41MB + eh 36MB。ブラウザはどちらか一方を取得）はビルド成果物として
  `/_next/static/media/` から配信。他のアセットと同じく `immutable`、存在しないハッシュは
  Next が `no-store` を付けて返す
- 型推定追加時: `@kukan/pipeline` の Extract ステップ変更、ADR-014 の「列型: 全列 STRING」を変更、Parquet 再生成が必要

## 関連 ADR

- ADR-014: プレビューデータの Parquet 形式（型推定追加時に列型を拡張）
- ADR-007: Data Editor アドオン（Phase 7 で集計・グラフ機能と連携）
