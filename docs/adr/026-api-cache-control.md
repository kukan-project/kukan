# ADR-026: API Cache-Control ヘッダー戦略

## ステータス

**承認済み（Accepted）**

## コンテキスト

Hono API のレスポンスに `Cache-Control` ヘッダーが設定されていなかった
（リソースのファイルストリーム系を除く）。ヘッダーが未設定の場合、
キャッシュの挙動はブラウザや CDN/プロキシの実装に依存し、
意図しないキャッシュや認証データの漏洩リスクがある。

CloudFront の導入有無にかかわらず、オリジン側で明示的にキャッシュ制御を
宣言すべきである。

## 決定

**Hono ミドルウェアでデフォルト値を設定し、公開ルートのみ `publicCache()` で上書きする。**

### デフォルトミドルウェア（`cacheControl`）

全 API ルートに適用。レスポンスに `Cache-Control` が未設定の場合のみ付与する。

| HTTP メソッド               | デフォルト値        | 理由                                           |
| --------------------------- | ------------------- | ---------------------------------------------- |
| GET / HEAD                  | `private, no-cache` | 認証で結果が変わる可能性があるため安全側に倒す |
| POST / PUT / PATCH / DELETE | `private, no-store` | 副作用のあるリクエスト                         |

- `private` — 共有キャッシュ（CDN / プロキシ）に保存させない
- `no-cache` — ブラウザキャッシュに保存してよいが、使用前に必ずオリジンに再検証する
- `no-store` — キャッシュに一切保存しない

既にルートハンドラーで `Cache-Control` を設定しているレスポンス
（`new Response()` でストリームを返すファイルダウンロード等）はスキップされる。

### 公開ルートミドルウェア（`publicCache()`）

認証で結果が変わらない完全公開 GET ルートに適用。

```
publicCache(maxAge = 60, swr = 300)
→ public, max-age={maxAge}, stale-while-revalidate={swr}
```

- `public` — CDN / プロキシでのキャッシュを許可
- `max-age` — キャッシュの有効期間（秒）
- `stale-while-revalidate` — 有効期限切れ後もバックグラウンドで再取得しながら古いキャッシュを返す期間

エラーレスポンス（ステータス 400 以上）には適用しない。
一時的な DB エラー等の失敗応答が CDN にキャッシュされることを防ぐため。

### ルート分類

| カテゴリ                                             | Cache-Control                                        | 適用方法                        |
| ---------------------------------------------------- | ---------------------------------------------------- | ------------------------------- |
| 認証で結果が変わる GET（packages, announcements 等） | `private, no-cache`                                  | デフォルト（変更不要）          |
| 認証必須 GET（users/me, admin 等）                   | `private, no-cache`                                  | デフォルト（変更不要）          |
| 書き込み（POST/PUT/DELETE）                          | `private, no-store`                                  | デフォルト（変更不要）          |
| 完全公開 GET（organizations, groups, tags 等）       | `public, max-age=60, stale-while-revalidate=300`     | `publicCache()` 適用            |
| 静的公開データ（license_list）                       | `public, max-age=3600, stale-while-revalidate=86400` | `publicCache(3600, 86400)` 適用 |
| ファイルストリーム（download, preview, text）        | `private, max-age=0` / `private, max-age=300`        | 既存のまま維持                  |
| ヘルスチェック                                       | `no-cache`                                           | 個別設定（機密情報なし）        |

### publicCache() 適用ルート一覧

| ルートファイル   | エンドポイント                           | 設定                       |
| ---------------- | ---------------------------------------- | -------------------------- |
| tags.ts          | ルーター全体（`tagsRouter.use`）         | `publicCache()`            |
| organizations.ts | `GET /`, `GET /:nameOrId`                | `publicCache()`            |
| groups.ts        | `GET /`, `GET /:nameOrId`                | `publicCache()`            |
| resources.ts     | `GET /formats`                           | `publicCache()`            |
| app.ts           | `GET /api/v1/site/settings`              | `publicCache()`            |
| ckan-compat.ts   | `organization_list`, `organization_show` | `publicCache()`            |
| ckan-compat.ts   | `group_list`, `group_show`               | `publicCache()`            |
| ckan-compat.ts   | `tag_list`, `tag_show`                   | `publicCache()`            |
| ckan-compat.ts   | `license_list`                           | `publicCache(3600, 86400)` |

## 影響

- 新規: `packages/api/src/middleware/cache-control.ts`（`cacheControl`, `publicCache`）
- 変更: `packages/api/src/app.ts`（ミドルウェア登録）
- 変更: 上記ルートファイル（`publicCache()` 適用）
- オンプレ環境: Caddy はキャッシュ機能を持たないため、ブラウザキャッシュ制御として機能
- CloudFront 環境: オリジンのヘッダーとして防御的に機能（ADR-027 参照）

## 関連

- ADR-027（CloudFront 再導入）: `docs/adr/027-cloudfront-reintroduction.md`
- 実装: `packages/api/src/middleware/cache-control.ts`
