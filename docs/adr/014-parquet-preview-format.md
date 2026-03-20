# ADR-014: プレビューデータのストレージ形式に Parquet を採用

## ステータス

**承認済み（Accepted）**

## コンテキスト

KUKAN のパイプラインはリソース（CSV/TSV）をパースし、プレビュー用のデータを Storage に保存する。
フロントエンドではこのデータを取得してテーブル表示する。

初期実装では JSON 形式で先頭 200 行のみ保存していたが、以下の課題がある：

1. **ページネーション不可**: JSON では全データを一括取得する必要があり、行数が多い場合に非効率
2. **全行保存時のサイズ**: JSON は表形式データの保存効率が悪い（キー名の繰り返し、文字列エスケープ等）
3. **生データの二重管理**: 「パース前の生テキスト」をプレビュー JSON 内に含めると、元ファイルと二重管理になる

## 検討した選択肢

### A) JSON（先頭 N 行のみ）

- 良い点: 実装が最も単純。フロントエンドで `JSON.parse()` するだけ
- 問題点:
  - 先頭 200 行しか見られない（ページネーション不可）
  - 全行保存するとファイルサイズが膨らむ（CSV より大きくなることも）
  - 行単位のランダムアクセス不可

### B) gzip 圧縮 JSON

- 良い点: サイズ削減。S3 の Content-Encoding で透過的に扱える
- 問題点: ページネーション問題は解決しない。全データの解凍が必要

### C) Parquet — 採用

- 良い点:
  - **HTTP Range リクエストによるページネーション**: Row Group 単位でバイト範囲指定取得が可能
  - **全行保存可能**: 列指向圧縮により、CSV の文字列データでも効率的に格納
  - **スキーマ内蔵**: ヘッダー情報がファイルメタデータに含まれる
  - **行数メタデータ**: `num_rows` がフッターに含まれ、全データ取得なしで総行数がわかる
  - **業界標準**: データ分析エコシステムで広く使われている
- 問題点:
  - ライブラリ依存の追加
  - フロントエンドでの読み取りに Parquet リーダーが必要

## 決定

**プレビューデータの保存形式を Parquet とする。**

### ライブラリ選定

| 用途               | ライブラリ         | 理由                                                                     |
| ------------------ | ------------------ | ------------------------------------------------------------------------ |
| サーバー側書き込み | `hyparquet-writer` | 純 JS、137KB、依存ゼロ（hyparquet のみ）、ESM 対応                       |
| ブラウザ側読み取り | `hyparquet`        | 純 JS、200KB、依存ゼロ、`asyncBufferFromUrl` で Range ベース読み取り対応 |

検討した他のライブラリ：

- `parquet-wasm`: WASM バンドル 1.2MB（Brotli 圧縮後）、Range Read 未対応
- `@dsnp/parquetjs`: 依存 12 個、6.9MB、Range Read 未対応
- `@duckdb/duckdb-wasm`: 144MB、目的外に大きすぎる

### 設計

```
パイプライン (サーバー側):
  CSV バッファ → parseBuffer() → ExtractedData → parquetWriteBuffer() → Storage 保存
                                                    ↓
                                    previews/{packageId}/{resourceId}.parquet

フロントエンド (ブラウザ側):
  Storage URL → asyncBufferFromUrl() → parquetMetadataAsync() → num_rows 取得
                                      → parquetReadObjects({ rowStart, rowEnd }) → テーブル表示
```

### Parquet 書き込み設定

- **圧縮**: `SNAPPY`（hyparquet-writer のデフォルト）
  - 純 JS 実装の Snappy 圧縮でストレージサイズを削減
  - hyparquet がブラウザ側で Snappy 解凍に対応しており、Range Read と組み合わせて利用可能
- **Row Group サイズ**: 5,000 行
  - UI のページサイズ（50〜100 行）に対して十分細かい粒度
  - 10MB CSV（約 50,000 行）で約 10 Row Group
- **列型**: 全列 `STRING`（CSV から取得した文字列データそのまま）

### 生データの表示

パース前の生データ表示は、プレビュー Parquet ファイルには含めない。
元ファイルが `resources/{packageId}/{resourceId}` に保存されているため、
フロントエンドはそこから直接ダウンロードして表示する。

### ストレージキー構成

| データ               | キー                                        |
| -------------------- | ------------------------------------------- |
| 元ファイル           | `resources/{packageId}/{resourceId}`        |
| パース済みプレビュー | `previews/{packageId}/{resourceId}.parquet` |

### 不要になる型・概念

- `StoredPreviewData` 型（JSON 構造の定義）→ 削除
- `rawText` / `raw_text`（生テキスト）→ 削除（元ファイルから直接取得）
- `MAX_PREVIEW_ROWS`（200 行制限）→ 削除（全行保存、Range Read でページネーション）

## 影響

- `@kukan/pipeline` に `hyparquet-writer` 依存を追加
- `apps/web` に `hyparquet` 依存を追加（Phase 3 Step 6 フロントエンド実装時）
- Extract ステップが JSON ではなく Parquet を生成
- フロントエンドのプレビューコンポーネントを Parquet 読み取りに対応（Phase 3 Step 6）
- Storage アダプターは変更不要（バイナリファイルのアップロード/ダウンロードは既存 API で対応）

## 関連 ADR

- ADR-005: 4 つのアダプターのみ（StorageAdapter）
