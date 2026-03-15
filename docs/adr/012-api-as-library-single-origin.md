# ADR-012: API をライブラリ化し Next.js に埋め込む（単一オリジン + Headless 両対応）

## ステータス

承認済み（2026-03-15）

## コンテキスト

Phase 1 では `apps/api`（Hono, port 3000）と `apps/web`（Next.js, port 3001）を別プロセス・別ポートで運用していた。この構成には以下の問題があった：

- CORS 設定の管理が必要
- `NEXT_PUBLIC_API_URL` 環境変数の二重管理
- Cookie の `SameSite` / `Domain` 設定が煩雑
- 開発時に2プロセス起動が必要

一方、CKAN のユースケースでは **Headless CMS** 的に API だけを独立運用し、サードパーティ製フロントエンドや外部システムから直接 API を叩く需要もある。

## 検討した選択肢

### A) 現状維持（apps/api + apps/web 分離）

- 良い点: デプロイ単位が独立、スケール特性を分けやすい
- 問題点: CORS・Cookie・環境変数の管理コストが高い

### B) API を packages/api にライブラリ化 — 採用

- 良い点:
  - Next.js 埋め込み時は単一オリジン（CORS 不要、Cookie 設定が単純）
  - `server.ts` を残すことでスタンドアロン起動も可能（Headless モード）
  - Server Components から `app.request()` で HTTP ホップなしの直接呼び出し
  - 開発時は `pnpm dev` で Next.js 1プロセスのみ
- 問題点: Next.js と API のスケールが連動する（大規模環境では分離が必要になる可能性）

### C) Next.js API Routes で API を書き直す

- 問題点: Hono のミドルウェア・ルーティング資産を捨てることになる。スタンドアロン運用不可

## 決定

`apps/api` を `packages/api` に移動しライブラリ化する。`createApp()` をエクスポートし、2つのモードで動作可能にする。

## 動作モード

### 1. 埋め込みモード（デフォルト）

Next.js の catch-all Route Handler (`app/api/[...path]/route.ts`) から Hono app を呼び出す。フロントエンドと API が同一プロセス・同一オリジンで動作。

```
ブラウザ → Next.js (port 3000) → Route Handler → app.fetch(req) → Hono
                                → Server Component → app.request(path) → Hono（HTTP ホップなし）
```

```typescript
// apps/web/src/app/api/[...path]/route.ts
import { getApp } from '@/lib/hono-app'

async function handler(req: Request) {
  const app = await getApp()
  return app.fetch(req)
}

export const GET = handler
export const POST = handler
// ...
```

Server Components からは `serverFetch()` 経由で `app.request()` を直接呼び出し、HTTP ホップを完全に排除：

```typescript
// apps/web/src/lib/api.ts
export async function serverFetch(path: string, init?: RequestInit) {
  const app = await getApp()
  return app.request(`http://localhost${path}`, { ...init, headers: { ... } })
}
```

### 2. スタンドアロンモード（Headless KUKAN）

`packages/api/src/server.ts` で Hono app を直接 Node.js HTTP サーバーとして起動。Next.js フロントエンドなしで API だけを提供する。

```bash
# 開発
cd packages/api && pnpm dev:standalone

# 本番
cd packages/api && pnpm start
```

**ユースケース:**
- **Headless KUKAN**: 自前フロントエンドや SPA から API だけを利用
- **外部システム連携**: ETL ツール、BI ツール、他システムからの CKAN 互換 API 利用
- **マイクロサービス分離**: 大規模環境で API と Web を別インスタンスにスケール

スタンドアロンモードでは `TRUSTED_ORIGINS` 環境変数（カンマ区切り）で CORS の許可オリジンを設定する。

## 根拠

- 90% のユースケース（自治体ポータル）は単一オリジンで十分 → 埋め込みモードがデフォルト
- Headless 需要は `server.ts` を残すだけで対応可能 → コスト最小
- `app.request()` による in-process 呼び出しはレイテンシ・リソース効率で最適
- Hono のコードは一切変更不要（`createApp()` が返す app は両モードで同一）

## 影響

- `apps/api/` は存在しなくなる（`packages/api/` に移動）
- `pnpm dev` では Next.js のみ起動（port 3000）
- `NEXT_PUBLIC_API_URL` 環境変数は廃止
- CORS ミドルウェアは `app.ts` から削除（スタンドアロン時は `TRUSTED_ORIGINS` で制御）
- `vitest.workspace.ts` の API テストパスを `./packages/api` に更新
- Server Components は `serverFetch()` → `app.request()` で HTTP ホップなし
- Client Components は `clientFetch()` で同一オリジンの相対パス fetch
