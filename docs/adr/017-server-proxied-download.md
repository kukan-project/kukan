# ADR-017: サーバー経由のダウンロード URL（パーマリンク化）

## ステータス

**承認済み（Accepted）**

## コンテキスト

現在、リソースのダウンロードは `GET /api/v1/resources/:id/download-url` で
Signed URL（S3 presigned URL）を取得し、クライアントがその URL にアクセスする二段階方式をとっている。

### 現状の問題

1. **パーマリンク不可**: Signed URL は有効期限があり、共有・ブックマーク・外部サイトからのリンクに使えない
2. **CKAN 非互換**: CKAN は `/dataset/{name}/resource/{id}/download/{filename}` という安定した URL パターンを持つ
3. **二段階アクセス**: API で URL 取得 → リダイレクト と 2 ステップ必要

## 決定

### 1. ダウンロード: サーバー経由ストリーミング

**CKAN 互換のパーマリンク URL を新設し、サーバーが Storage からストリーミングプロキシする。**

#### URL パターン

| URL                                                             | 用途                          | 実装                  |
| --------------------------------------------------------------- | ----------------------------- | --------------------- |
| `/dataset/{nameOrId}/resource/{resourceId}/download/{filename}` | 公開パーマリンク（CKAN 互換） | Next.js Route Handler |
| `GET /api/v1/resources/:id/download`                            | API エンドポイント            | Hono ルート           |

両方とも同じロジック: Storage からファイルを取得し、レスポンスにストリーミング。

#### レスポンスヘッダー

```
Content-Type: {resource.mimetype || application/octet-stream}
Content-Disposition: attachment; filename="{filename}"
Content-Length: {resource.size}  (判明している場合)
Cache-Control: private, max-age=0
```

#### 外部 URL リソースの扱い

外部 URL リソース（`urlType !== 'upload'`）は、サーバーでプロキシせず元の URL にリダイレクトする:

```
HTTP 302 Found
Location: {resource.url}
```

#### 認証

- 公開データセットのリソース: 認証不要
- private データセットのリソース: 認証必要（未認証は 401）
- 外部 URL リソース: リダイレクトのみ（アクセス制御は外部サイト側）

#### ストリーミングの安全性

Node.js のストリーミングはイベントループをブロックしない:

- `pipe()` / `Readable.toWeb()` はバックプレッシャー対応
- チャンク単位（~64KB）で処理され、チャンク間でイベントループが回る
- 10MB 上限のファイルサイズなら同時ダウンロード数十でも問題なし
- 既存の `/text` エンドポイントも同じパターンで動作中

### 2. プレビュー: サーバー経由プロキシに統合

当初 Signed URL 維持とした `preview-url` も、以下の理由でサーバープロキシ `/preview` に統合した:

- hyparquet の `asyncBufferFromUrl` が HEAD リクエストを送信し、GET 署名の presigned URL では CORS エラーになる
- Range ヘッダー転送はサーバー側で問題なく動作（`/preview` エンドポイントで実装済み）
- presigned URL の有効期限管理が不要になりアーキテクチャが簡素化

### 3. 廃止エンドポイント

| エンドポイント                           | 状態                           |
| ---------------------------------------- | ------------------------------ |
| `GET /api/v1/resources/:id/download-url` | **廃止** → `download` に置換  |
| `GET /api/v1/resources/:id/preview-url`  | **廃止** → `preview` に置換   |

### 4. 現在のエンドポイント体系

Presigned URL を返すエンドポイントは `upload-url`（アップロード用 PUT）のみ。
読み取り系はすべてサーバー経由ストリーミング:

| エンドポイント | 用途 | 方式 |
|---------------|------|------|
| `GET /download` | ファイルダウンロード | サーバー経由 / 外部 URL は 302 |
| `GET /preview` | プレビュー配信（Range 対応） | サーバー経由ストリーミング |
| `GET /text` | テキストプレビュー | サーバー経由（charset 変換付き） |
| `POST /upload-url` | アップロード用 presigned URL 発行 | Signed URL（PUT 用） |

## フロントエンドへの影響

| コンポーネント          | 変更前                                    | 変更後                                        |
| ----------------------- | ----------------------------------------- | --------------------------------------------- |
| `DownloadButton`        | `download-url` → `window.open(signedUrl)` | `<a href="/api/v1/resources/:id/download">`   |
| `useParquetPreview`     | `preview-url` → Signed URL → hyparquet   | `/preview` → hyparquet（サーバープロキシ）     |
| `PdfPreview`            | `preview-url` → Signed URL → iframe      | `/preview` を iframe src に直接指定            |
| `ZipPreview`            | `preview-url` → Signed URL → fetch JSON  | `/preview` から JSON 取得                      |

## 関連 ADR

- ADR-015: 統一 preview-url エンドポイント（本 ADR により置換済み）
- ADR-016: DuckDB-WASM データエクスプローラー
