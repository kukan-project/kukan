# パイプライン フォーマット別処理仕様

## 概要

パイプラインは **Fetch → Extract** の 2 ステップで構成される。
Index ステップは廃止済み（検索インデックス更新は API ルートハンドラーで CUD 操作時に実行）。

Extract の失敗はパイプライン全体を失敗にしない（non-critical）。Fetch の失敗はパイプライン全体を失敗にする。

## データフローとキャッシュ

リソースの `urlType` に関わらず、すべてのデータは **Storage（S3/MinIO）に保存**される。
プレビュー表示時にオンザフライ処理は行わず、パイプラインの事前処理結果を配信する。

```
┌─────────────────────────────────────────────────────────────────────┐
│ upload（ファイルアップロード）                                        │
│                                                                     │
│   ブラウザ ─── presigned PUT ──→ Storage [resources/{pkg}/{res}]    │
│                                     │                               │
│                        パイプライン enqueue                          │
│                                     ↓                               │
│   [Fetch] ハッシュ計算のみ ─→ DB 更新                               │
│                                     ↓                               │
│   [Extract] Storage 読み取り ─→ Storage [previews/{pkg}/{res}.*]    │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│ url（外部 URL）                                                      │
│                                                                     │
│   外部サーバー                                                       │
│       │                                                             │
│       ↓                                                             │
│   [Fetch] ダウンロード ──→ Storage [resources/{pkg}/{res}]          │
│                                │                                    │
│                                ↓                                    │
│   [Extract] Storage 読み取り ─→ Storage [previews/{pkg}/{res}.*]    │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│ プレビュー表示時（両方共通）                                          │
│                                                                     │
│   ブラウザ ─→ /preview ─→ Storage から配信（オンザフライ処理なし）    │
│   ブラウザ ─→ /text    ─→ Storage から配信（charset 変換のみ）       │
└─────────────────────────────────────────────────────────────────────┘
```

**重要**: 外部 URL リソースも Fetch ステップで Storage にダウンロード済みのため、
プレビュー表示時に外部サーバーへの再アクセスは発生しない。
外部 URL に再アクセスするのは **再処理（Reprocess）実行時の Fetch ステップのみ**。
再処理時にハッシュが変わっていれば Storage 上のファイルが上書き更新される。

## ストレージキー

| 種別                  | キーパターン                                | 例                         |
| --------------------- | ------------------------------------------- | -------------------------- |
| リソース本体          | `resources/{packageId}/{resourceId}`        | `resources/abc/def`        |
| プレビュー（Parquet） | `previews/{packageId}/{resourceId}.parquet` | `previews/abc/def.parquet` |
| プレビュー（JSON）    | `previews/{packageId}/{resourceId}.json`    | `previews/abc/def.json`    |

---

## Step 1: Fetch

リソースデータを Storage に格納する。`urlType` によって動作が異なる。

### upload（ファイルアップロード）

| 項目       | 内容                                         |
| ---------- | -------------------------------------------- |
| 動作       | Storage に既に存在するため、ダウンロード不要 |
| ハッシュ   | 未計算の場合のみ SHA-256 を計算し DB 更新    |
| サイズ制限 | なし（アップロード時に制限済み）             |

### url（外部 URL）

| 項目         | 内容                                                                      |
| ------------ | ------------------------------------------------------------------------- |
| 動作         | 外部 URL から Storage にストリーミングダウンロード                        |
| ハッシュ     | ストリーム中にオンザフライで SHA-256 計算、変更があれば DB 更新           |
| サイズ制限   | **100 MB**（`Content-Length` ヘッダーとストリーム中の両方でチェック）      |
| タイムアウト | **30 秒**                                                                 |
| エラー       | HTTP エラー → `BAD_GATEWAY (502)`、サイズ超過 → `PAYLOAD_TOO_LARGE (413)` |

### 共通

- `urlType` も `url` もない場合 → `ValidationError`
- 結果: `{ storageKey, format, packageId }` を Extract に渡す

---

## Step 2: Extract

Storage のリソースデータを読み取り、エンコーディング検出とプレビュー生成を行う。

### フォーマット別処理マトリクス

| フォーマット | isTextFormat | エンコーディング検出                                      |  プレビュー生成   | 成果物     |
| ------------ | :----------: | --------------------------------------------------------- | :---------------: | ---------- |
| **CSV**      |     Yes      | `Encoding.detect()` 自動検出                              |      Parquet      | `.parquet` |
| **TSV**      |     Yes      | `Encoding.detect()` 自動検出                              |      Parquet      | `.parquet` |
| **TXT**      |     Yes      | `Encoding.detect()` 自動検出                              |       なし        | —          |
| **HTML/HTM** |     Yes      | `Encoding.detect()` 自動検出                              |       なし        | —          |
| **XML**      |     Yes      | `<?xml encoding>` 宣言パース（先頭 200B）、fallback UTF-8 |       なし        | —          |
| **JSON**     |     Yes      | UTF-8 固定（RFC 8259）                                    |       なし        | —          |
| **GeoJSON**  |     Yes      | UTF-8 固定（RFC 7946）                                    |       なし        | —          |
| **MD**       |     Yes      | UTF-8 固定                                                |       なし        | —          |
| **ZIP**      |  No (独自)   | —                                                         | JSON マニフェスト | `.json`    |
| **PDF**      |      No      | —                                                         | なし（スキップ）  | —          |
| **XLSX/XLS** |      No      | —                                                         | なし（スキップ）  | —          |
| **DOC/DOCX** |      No      | —                                                         | なし（スキップ）  | —          |
| **RDF**      |      No      | —                                                         | なし（スキップ）  | —          |

### フォーマット別詳細

#### CSV / TSV

1. Storage からファイル全体をバッファに読み込み（**50MB 超の場合は Parquet 生成スキップ**、エンコーディングのみ検出して返却）
2. `encoding-japanese` でエンコーディング自動検出（SJIS/EUCJP/JIS/UTF8）
3. 検出結果に基づき UTF-8 に変換
4. `papaparse` で全行パース（`header: false, skipEmptyLines: true`）
5. タイトル行スキップ: 先頭のセルが 1 つだけの行を除去（複数カラムの場合のみ）
6. **カラム数チェック: 500 カラム超の場合 → エラー（`Too many columns`）**
7. フッター行除去: 末尾の「合計」「注」「※」等で始まる行を除去
8. `hyparquet-writer` で Parquet バッファ生成（rowGroupSize: 5,000）
9. Storage に `previews/{packageId}/{resourceId}.parquet` としてアップロード
10. 結果: `{ previewKey, encoding }`

#### ZIP

1. Storage からファイルを一時ファイルに書き出し
2. `yauzl` で中央ディレクトリ読み取り（ファイル内容は展開しない）
3. ファイル名デコード: UTF-8 フラグ → UTF-8、なければ UTF-8 試行 → Shift_JIS フォールバック
4. エントリ上限: **10,000 件**（超過分は切り捨て、`truncated: true`）
5. JSON マニフェスト生成: `{ totalFiles, totalSize, totalCompressed, truncated, entries[] }`
6. Storage に `previews/{packageId}/{resourceId}.json` としてアップロード
7. 一時ファイル削除
8. 結果: `{ previewKey: "...json", encoding: "UTF8" }`

#### XML

1. Storage から先頭 **200 バイト**のみ読み込み
2. `<?xml ... encoding="...">` 宣言をパース
3. 宣言なし → UTF-8、あれば対応するエンコーディング名に変換
4. 結果: `{ previewKey: null, encoding }`

#### JSON / GeoJSON / MD

1. Storage アクセス不要（仕様上 UTF-8 固定）
2. 結果: `{ previewKey: null, encoding: "UTF8" }`

#### TXT / HTML / HTM

1. Storage からファイル全体をバッファに読み込み
2. `encoding-japanese` でエンコーディング自動検出
3. 結果: `{ previewKey: null, encoding }`

#### PDF / XLSX / XLS / DOC / DOCX / RDF

1. `isTextFormat` → false、`isZipFormat` → false
2. 結果: `null`（Extract ステップ自体がスキップ扱い）

---

## フロントエンド プレビュー表示

API エンドポイント `/api/v1/resources/:id/preview` がサーバープロキシとして機能する。
`resolvePreviewTarget()` がフォーマットに応じてストレージキーを解決:

- **PDF** → リソース本体（`resources/{packageId}/{resourceId}`）
- **その他** → パイプライン生成物（`previewKey` from `resource_pipeline`）

### フォーマット別 UI マッピング

| フォーマット                      | コンポーネント                                       | データソース                    | 表示方式                        |
| --------------------------------- | ---------------------------------------------------- | ------------------------------- | ------------------------------- |
| **CSV / TSV**                     | `TablePreview` → `ParquetPreview` + `RawTextPreview` | `/preview`（Parquet）+ `/text`  | テーブル / テキスト切り替え     |
| **PDF**                           | `PdfPreview`                                         | `/preview`（リソース本体）      | iframe                          |
| **GeoJSON**                       | `GeoJsonPreview`                                     | `/text`                         | Leaflet 地図 + テキスト切り替え |
| **ZIP**                           | `ZipPreview`                                         | `/preview`（JSON マニフェスト） | ツリー形式ファイル一覧          |
| **JSON / XML / HTML / TXT / MD**  | `TextOnlyPreview` → `RawTextPreview`                 | `/text`                         | pre タグ（テキストのみ）        |
| **XLSX / XLS / DOC / DOCX / RDF** | `PreviewNotAvailable`                                | —                               | 「プレビュー非対応」表示        |

### ParquetPreview の状態

| 状態                                       | 表示                                    |
| ------------------------------------------ | --------------------------------------- |
| ロード中                                   | Skeleton                                |
| メタデータなし（プレビュー未生成 or 失敗） | 「プレビューデータなし」                |
| 0 行                                       | 「データが空です」                      |
| データあり                                 | ページング付きテーブル（100 行/ページ） |

### エンドポイント一覧

| エンドポイント  | 用途                                                      | 利用元                                             |
| --------------- | --------------------------------------------------------- | -------------------------------------------------- |
| `GET /preview`  | サーバープロキシ（Range 対応）                            | PDF iframe, ParquetPreview (hyparquet), ZipPreview |
| `GET /text`     | テキストプレビュー（charset 変換付き）                    | RawTextPreview, GeoJsonPreview                     |
| `GET /download` | ファイルダウンロード（upload: ストリーム、外部 URL: 302） | DownloadButton                                     |
