# ADR-015: 統一 preview-url エンドポイント

## ステータス

**承認済み（Accepted）**

## コンテキスト

KUKAN のリソースプレビューは、フォーマットによって表示方法が異なる:

- **CSV/TSV**: パイプラインで Parquet に変換し、ブラウザで hyparquet により表示
- **PDF**: Storage 上の元ファイルを iframe で inline 表示
- **TXT**: `/text` エンドポイントから生テキストを取得して表示

初期実装では、CSV/TSV は `preview-url`、PDF は `download-url?inline=true` と、
フォーマットごとに異なるエンドポイントを呼び分けていた。
これはフロントエンドの条件分岐を増やし、新フォーマット追加時の拡張性が低い。

## 決定

**`GET /api/v1/resources/:id/preview-url` をプレビュー URL 取得の統一エントリーポイントとする。**

バックエンドがフォーマットに応じて適切な URL を返す:

| フォーマット | 返す URL                                                     | フロントエンドの表示 |
| ------------ | ------------------------------------------------------------ | -------------------- |
| CSV/TSV      | Parquet プレビューファイルの presigned URL                   | hyparquet テーブル   |
| PDF          | 元ファイルの presigned URL（inline disposition + MIME 指定） | iframe               |
| TXT          | `null`（`/text` エンドポイントを別途使用）                   | テキスト表示         |
| その他       | `null`                                                       | 「利用不可」表示     |

### レスポンス形式

```json
{ "url": "https://storage.example.com/..." }
```

または

```json
{ "url": null }
```

### フロントエンドの分岐

フロントエンドはフォーマットに応じて**表示コンポーネント**を選択するが、
**URL の取得先は常に `preview-url`** で統一される（TXT を除く）。

```
ResourcePreview
  ├── PDF  → PdfPreview   → preview-url → iframe
  ├── TXT  → TextPreview  → /utf8-text → <pre>
  └── *    → TablePreview → preview-url → hyparquet table
```

### `download-url` との役割分担

| エンドポイント | 用途                                 | URL の種類                                                                                    |
| -------------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `preview-url`  | ブラウザ内プレビュー表示用           | Storage presigned URL（inline disposition）                                                   |
| `download-url` | ユーザーによるファイルダウンロード用 | 外部 URL はそのまま、upload は Storage presigned（attachment disposition + 元ファイル名付き） |

`download-url` は外部 URL リソースの場合、オリジナルの URL をそのまま返す。
`preview-url` は常に Storage 上のファイル（Parquet プレビューまたは元ファイル）の presigned URL を返す。

## 影響

- `preview-url` エンドポイントにリソース情報の取得とフォーマット分岐を追加
- フロントエンドの `PdfPreview` が `download-url?inline=true` ではなく `preview-url` を使用
- 新フォーマット（Excel, GeoJSON 等）のプレビュー追加時は `preview-url` に分岐を追加するだけで対応可能

## 関連 ADR

- ADR-014: プレビューデータのストレージ形式に Parquet を採用
