# ADR-017: サーバー経由のダウンロード URL（パーマリンク化）

## ステータス

**提案（Proposed）**

## コンテキスト

現在、リソースのダウンロードは `GET /api/v1/resources/:id/download-url` で
Signed URL（S3 presigned URL）を取得し、クライアントがその URL にアクセスする二段階方式をとっている。

### 現状の問題

1. **パーマリンク不可**: Signed URL は有効期限があり、共有・ブックマーク・外部サイトからのリンクに使えない
2. **LocalStorageAdapter 非互換**: ローカルストレージ（Web サーバーのローカルファイルシステム）では `getSignedUrl()` が `file://` URL を返しているが、ブラウザはセキュリティ上 `file://` にアクセスできないため実質的に動作しない。本来は HTTP URL でサーバー経由のアクセスが必要
3. **CKAN 非互換**: CKAN は `/dataset/{name}/resource/{id}/download/{filename}` という安定した URL パターンを持つ
4. **二段階アクセス**: API で URL 取得 → リダイレクト と 2 ステップ必要

### preview-url の現状

`GET /api/v1/resources/:id/preview-url` も同様に Signed URL を返す。
ただしプレビューは公開用途ではなく（ブラウザ内表示のみ）、Parquet の Range Read が必要なため、
サーバー経由プロキシにすると Range ヘッダー転送の複雑さが増す。

## 決定（提案）

### 1. ダウンロード: サーバー経由ストリーミング

**CKAN 互換のパーマリンク URL を新設し、サーバーが Storage からストリーミングプロキシする。**

#### URL パターン

| URL | 用途 | 実装 |
|-----|------|------|
| `/dataset/{nameOrId}/resource/{resourceId}/download/{filename}` | 公開パーマリンク（CKAN 互換） | Next.js Route Handler |
| `GET /api/v1/resources/:id/download` | API エンドポイント | Hono ルート |

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

### 2. プレビュー: Signed URL を維持 + Local 対応

プレビュー URL は Signed URL 方式を維持する。理由:

- Parquet の Range Read は HTTP Range ヘッダーに依存しており、サーバープロキシだと転送が複雑
- プレビューはブラウザ内表示のみで、パーマリンクの必要性がない
- DuckDB-WASM（ADR-016）も `httpfs` で直接 Signed URL にアクセスする設計

**LocalStorageAdapter の場合のみ**、サーバー経由のプレビューエンドポイントを使用する:

| ストレージ | preview-url の返す URL |
|------------|----------------------|
| S3 互換 | Presigned URL（現状通り） |
| Local | `/api/v1/resources/:id/preview` （サーバー経由、Range 対応） |

#### Local 用プレビューエンドポイント

```
GET /api/v1/resources/:id/preview
→ Storage.download() でファイル取得
→ Range ヘッダーがあれば部分レスポンス（206）
→ なければ全体レスポンス（200）
```

### 3. 廃止

| エンドポイント | 状態 |
|---|---|
| `GET /api/v1/resources/:id/download-url` | **廃止** → `download` に置換 |
| `GET /api/v1/resources/:id/preview-url` | 維持（Local 対応を追加） |

## フロントエンドへの影響

| コンポーネント | 現在 | 変更後 |
|---|---|---|
| `DownloadButton` | `download-url` → `window.open(signedUrl)` | `<a href="/api/v1/resources/:id/download">` または同等 |
| `useParquetPreview` | `preview-url` → Signed URL | 変更なし（Local 時は API URL が返る） |
| `ResourcePreview` (PDF) | `preview-url` → Signed URL | 変更なし |
| リソース詳細ページ | — | CKAN 互換 URL をメタ情報として表示可能 |

## 実装順序

| 順序 | 内容 |
|------|------|
| 1 | `GET /api/v1/resources/:id/download` エンドポイント追加（ストリーミング） |
| 2 | Next.js Route Handler `/dataset/[nameOrId]/resource/[resourceId]/download/[filename]/route.ts` |
| 3 | `DownloadButton` を新エンドポイントに切り替え |
| 4 | `download-url` エンドポイント削除 |
| 5 | `LocalStorageAdapter.getSignedUrl()` を API URL に変更、`preview` エンドポイント追加 |
| 6 | ADR-015 更新（download-url 廃止を反映） |

## 関連 ADR

- ADR-015: 統一 preview-url エンドポイント（download-url 廃止を反映予定）
- ADR-016: DuckDB-WASM データエクスプローラー（Signed URL に直接アクセス）
