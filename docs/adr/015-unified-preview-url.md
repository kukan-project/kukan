# ADR-015: 統一 preview-url エンドポイント

## ステータス

**置換済み（Superseded）** — サーバープロキシ `/preview` に統合。

`preview-url`（presigned URL を返す）は、CORS 問題の回避とアーキテクチャ簡素化のため
`/preview`（サーバー経由ストリーミング）に置き換えられた。
`download-url` も同様に ADR-017 で `/download` に置換済み。

これにより presigned URL を返すエンドポイントは `upload-url`（アップロード用）のみとなった。

## コンテキスト

KUKAN のリソースプレビューは、フォーマットによって表示方法が異なる:

- **CSV/TSV**: パイプラインで Parquet に変換し、ブラウザで hyparquet により表示
- **PDF**: Storage 上の元ファイルを iframe で inline 表示
- **TXT**: `/text` エンドポイントから生テキストを取得して表示

初期実装では、CSV/TSV は `preview-url`、PDF は `download-url?inline=true` と、
フォーマットごとに異なるエンドポイントを呼び分けていた。
これはフロントエンドの条件分岐を増やし、新フォーマット追加時の拡張性が低い。

## 決定（当初）

`GET /api/v1/resources/:id/preview-url` をプレビュー URL 取得の統一エントリーポイントとした。

## 置換理由

1. **CORS 問題**: hyparquet の `asyncBufferFromUrl` が HEAD リクエストを送信するが、
   GET 署名の presigned URL では HEAD が CORS エラーになる
2. **アーキテクチャ簡素化**: presigned URL の有効期限管理が不要に
3. **認証一元化**: サーバープロキシならアクセス制御をサーバー側で統一管理できる
4. **download-url と同じ経緯**: ADR-017 で download-url → download に置換した設計と一貫

## 現在のプレビューアーキテクチャ

| エンドポイント  | 用途                         | 方式                             |
| --------------- | ---------------------------- | -------------------------------- |
| `GET /preview`  | プレビュー配信（Range 対応） | サーバー経由ストリーミング       |
| `GET /text`     | テキストプレビュー           | サーバー経由（charset 変換付き） |
| `GET /download` | ファイルダウンロード         | サーバー経由 / 外部 URL は 302   |

フロントエンドのコンポーネント分岐:

```
ResourcePreview
  ├── PDF     → PdfPreview      → /preview (iframe src)
  ├── CSV/TSV → TablePreview    → /preview (hyparquet) + /text (raw toggle)
  ├── GeoJSON → GeoJsonPreview  → /text (Leaflet + raw toggle)
  ├── ZIP     → ZipPreview      → /preview (JSON manifest)
  ├── Text    → TextOnlyPreview → /text
  └── Other   → PreviewNotAvailable
```

## 関連 ADR

- ADR-014: プレビューデータのストレージ形式に Parquet を採用
- ADR-017: サーバー経由のダウンロード URL（`download-url` → `download` 置換）
