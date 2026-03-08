# Phase 2: Frontend — 実装仕様書

> **目標**: Next.js 15 によるカタログUI、認証フロー、管理画面を実装し、Phase 1 API をブラウザから操作可能にする

## 1. 前提

- Phase 1 API が完成済み（CRUD + CKAN互換 + 検索 + 認証）
- Better Auth のメール/パスワード認証 + API Key 認証が動作
- `apps/web` および `packages/ui` は未作成

## 2. 技術スタック

| カテゴリ | 技術 | 備考 |
|---|---|---|
| フレームワーク | Next.js 15 (App Router) | Server Components 優先 |
| UIライブラリ | shadcn/ui | Radix UI ベース、`packages/ui` にコピー |
| スタイリング | Tailwind CSS 4 | CSS-first config |
| 状態管理 | React Server Components + `nuqs` | URL state 管理 |
| データフェッチ | Server Components + Route Handlers | クライアントは `fetch` |
| フォーム | React Hook Form + Zod | `@kukan/shared` バリデーター再利用 |
| 認証クライアント | `better-auth/react` | セッション Cookie 自動管理 |
| i18n | `next-intl` | 日本語/英語、構造のみ Phase 2 |
| テスト | Vitest + Testing Library | コンポーネント + E2E は Phase 3+ |

## 3. ディレクトリ構成

### 3.1 `apps/web`

```
apps/web/
├── src/
│   ├── app/
│   │   ├── layout.tsx                  # ルートレイアウト（ヘッダー/フッター）
│   │   ├── page.tsx                    # トップページ（検索 + 統計）
│   │   ├── globals.css                 # Tailwind + CSS Variables（テーマ）
│   │   │
│   │   ├── dataset/
│   │   │   ├── page.tsx                # データセット一覧（検索/フィルター）
│   │   │   └── [nameOrId]/
│   │   │       └── page.tsx            # データセット詳細
│   │   │
│   │   ├── organization/
│   │   │   ├── page.tsx                # 組織一覧
│   │   │   └── [nameOrId]/
│   │   │       └── page.tsx            # 組織詳細（所属データセット一覧）
│   │   │
│   │   ├── group/
│   │   │   ├── page.tsx                # グループ一覧
│   │   │   └── [nameOrId]/
│   │   │       └── page.tsx            # グループ詳細
│   │   │
│   │   ├── search/
│   │   │   └── page.tsx                # 全文検索結果
│   │   │
│   │   ├── auth/
│   │   │   ├── sign-in/
│   │   │   │   └── page.tsx            # ログインフォーム
│   │   │   └── sign-up/
│   │   │       └── page.tsx            # 登録フォーム
│   │   │
│   │   └── dashboard/
│   │       ├── layout.tsx              # 管理画面レイアウト（サイドバー）
│   │       ├── page.tsx                # ダッシュボードトップ
│   │       ├── datasets/
│   │       │   ├── page.tsx            # 自分のデータセット管理
│   │       │   ├── new/
│   │       │   │   └── page.tsx        # データセット新規作成
│   │       │   └── [nameOrId]/
│   │       │       └── edit/
│   │       │           └── page.tsx    # データセット編集
│   │       ├── organizations/
│   │       │   ├── page.tsx            # 組織管理
│   │       │   └── new/
│   │       │       └── page.tsx        # 組織新規作成
│   │       ├── groups/
│   │       │   ├── page.tsx            # グループ管理
│   │       │   └── new/
│   │       │       └── page.tsx        # グループ新規作成
│   │       ├── api-tokens/
│   │       │   └── page.tsx            # APIトークン管理
│   │       └── profile/
│   │           └── page.tsx            # プロフィール設定
│   │
│   ├── components/
│   │   ├── layout/
│   │   │   ├── header.tsx              # サイトヘッダー（ナビ + 検索 + ユーザーメニュー）
│   │   │   ├── footer.tsx              # サイトフッター
│   │   │   └── sidebar.tsx             # 管理画面サイドバー
│   │   ├── dataset/
│   │   │   ├── dataset-card.tsx        # データセットカード（一覧用）
│   │   │   ├── dataset-detail.tsx      # データセット詳細表示
│   │   │   ├── dataset-form.tsx        # 作成/編集フォーム
│   │   │   ├── resource-list.tsx       # リソース一覧テーブル
│   │   │   └── resource-form.tsx       # リソース追加/編集フォーム
│   │   ├── organization/
│   │   │   ├── organization-card.tsx
│   │   │   └── organization-form.tsx
│   │   ├── group/
│   │   │   ├── group-card.tsx
│   │   │   └── group-form.tsx
│   │   ├── search/
│   │   │   ├── search-bar.tsx          # グローバル検索バー
│   │   │   ├── search-results.tsx      # 検索結果リスト
│   │   │   └── search-filters.tsx      # フィルターサイドバー
│   │   ├── tag/
│   │   │   └── tag-badge.tsx           # タグバッジ
│   │   └── auth/
│   │       ├── sign-in-form.tsx
│   │       ├── sign-up-form.tsx
│   │       └── user-menu.tsx           # ヘッダーのユーザーメニュー
│   │
│   ├── lib/
│   │   ├── api.ts                      # API クライアント（fetch ラッパー）
│   │   ├── auth-client.ts              # Better Auth React クライアント
│   │   └── utils.ts                    # ユーティリティ（cn() 等）
│   │
│   └── hooks/
│       ├── use-session.ts              # 認証セッション hook
│       └── use-pagination.ts           # URL ベースページネーション
│
├── public/
│   └── logo.svg
├── next.config.ts
├── tailwind.config.ts
├── postcss.config.mjs
├── package.json
└── tsconfig.json
```

### 3.2 `packages/ui`

```
packages/ui/
├── src/
│   ├── components/
│   │   └── ui/                         # shadcn/ui コンポーネント
│   │       ├── button.tsx
│   │       ├── card.tsx
│   │       ├── input.tsx
│   │       ├── dialog.tsx
│   │       ├── dropdown-menu.tsx
│   │       ├── badge.tsx
│   │       ├── table.tsx
│   │       ├── form.tsx
│   │       ├── select.tsx
│   │       ├── textarea.tsx
│   │       ├── pagination.tsx
│   │       ├── skeleton.tsx
│   │       ├── toast.tsx
│   │       ├── separator.tsx
│   │       ├── avatar.tsx
│   │       ├── sheet.tsx
│   │       └── command.tsx
│   ├── lib/
│   │   └── utils.ts                    # cn() ヘルパー
│   └── index.ts                        # re-export
├── package.json
└── tsconfig.json
```

## 4. ページ一覧と機能

### 4.1 公開ページ（認証不要）

| ページ | パス | データソース | 機能 |
|---|---|---|---|
| トップ | `/` | `GET /api/v1/packages?limit=5` + 統計 | 最新データセット、検索バー |
| データセット一覧 | `/dataset` | `GET /api/v1/packages` | ページネーション、検索、フィルター |
| データセット詳細 | `/dataset/[nameOrId]` | `GET /api/v1/packages/:nameOrId` | メタデータ、リソース一覧、タグ |
| 組織一覧 | `/organization` | `GET /api/v1/organizations` | カード一覧 |
| 組織詳細 | `/organization/[nameOrId]` | `GET /api/v1/organizations/:nameOrId` | 組織情報 + 所属データセット |
| グループ一覧 | `/group` | `GET /api/v1/groups` | カード一覧 |
| グループ詳細 | `/group/[nameOrId]` | `GET /api/v1/groups/:nameOrId` | グループ情報 |
| 検索結果 | `/search?q=...` | `GET /api/v1/search` | 全文検索、組織/タグフィルター |
| ログイン | `/auth/sign-in` | `POST /api/auth/sign-in` | メール/パスワード |
| 登録 | `/auth/sign-up` | `POST /api/auth/sign-up` | メール/パスワード |

### 4.2 管理ページ（認証必須）

| ページ | パス | 機能 |
|---|---|---|
| ダッシュボード | `/dashboard` | 自分のデータセット数、最近の変更 |
| データセット管理 | `/dashboard/datasets` | 自分のデータセット一覧 |
| データセット作成 | `/dashboard/datasets/new` | フォーム（Zod バリデーション） |
| データセット編集 | `/dashboard/datasets/[nameOrId]/edit` | フォーム + リソース管理 |
| 組織管理 | `/dashboard/organizations` | 組織一覧（sysadmin のみ作成可） |
| 組織作成 | `/dashboard/organizations/new` | フォーム |
| グループ管理 | `/dashboard/groups` | グループ一覧 |
| グループ作成 | `/dashboard/groups/new` | フォーム |
| APIトークン | `/dashboard/api-tokens` | トークン生成/一覧/削除 |
| プロフィール | `/dashboard/profile` | ユーザー情報表示 |

## 5. API クライアント

### 5.1 `apps/web/src/lib/api.ts`

```typescript
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'

// Server Components 用（cookie 転送付き）
export async function serverFetch(path: string, init?: RequestInit) {
  const { cookies } = await import('next/headers')
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get('better-auth.session_token')

  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      ...(sessionToken && { Cookie: `better-auth.session_token=${sessionToken.value}` }),
    },
  })
}

// Client Components 用（credentials: 'include' で cookie 送信）
export async function clientFetch(path: string, init?: RequestInit) {
  return fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
  })
}
```

### 5.2 `apps/web/src/lib/auth-client.ts`

```typescript
import { createAuthClient } from 'better-auth/react'

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000',
})

export const { signIn, signUp, signOut, useSession } = authClient
```

## 6. テーマとスタイリング

ADR-010 に準拠。Phase 2 では **Tier 1: CSS Variables** のみ実装。

### 6.1 `apps/web/src/app/globals.css`

```css
@import 'tailwindcss';

:root {
  /* shadcn/ui default light theme */
  --background: 0 0% 100%;
  --foreground: 222.2 84% 4.9%;
  --card: 0 0% 100%;
  --card-foreground: 222.2 84% 4.9%;
  --popover: 0 0% 100%;
  --popover-foreground: 222.2 84% 4.9%;
  --primary: 222.2 47.4% 11.2%;
  --primary-foreground: 210 40% 98%;
  --secondary: 210 40% 96%;
  --secondary-foreground: 222.2 47.4% 11.2%;
  --muted: 210 40% 96%;
  --muted-foreground: 215.4 16.3% 46.9%;
  --accent: 210 40% 96%;
  --accent-foreground: 222.2 47.4% 11.2%;
  --destructive: 0 84.2% 60.2%;
  --destructive-foreground: 210 40% 98%;
  --border: 214.3 31.8% 91.4%;
  --input: 214.3 31.8% 91.4%;
  --ring: 222.2 84% 4.9%;
  --radius: 0.5rem;

  /* KUKAN-specific */
  --kukan-header-height: 64px;
  --kukan-logo-height: 32px;
  --kukan-container-max-width: 1280px;
}
```

## 7. 認証フロー

### 7.1 ログイン

1. ユーザーが `/auth/sign-in` でメール/パスワードを入力
2. `authClient.signIn.email()` → `POST /api/auth/sign-in/email`
3. Better Auth がセッション Cookie を Set-Cookie で返す
4. リダイレクト → `/dashboard`

### 7.2 認証状態の取得

- **Server Component**: `serverFetch('/api/v1/users/me')` で取得。401 なら未認証。
- **Client Component**: `useSession()` hook（Better Auth React）

### 7.3 認証ガード

`/dashboard/*` ルートは `layout.tsx` でセッションチェック。未認証なら `/auth/sign-in` にリダイレクト。

```typescript
// apps/web/src/app/dashboard/layout.tsx
export default async function DashboardLayout({ children }) {
  const res = await serverFetch('/api/v1/users/me')
  if (!res.ok) redirect('/auth/sign-in')
  const user = await res.json()
  return <DashboardShell user={user}>{children}</DashboardShell>
}
```

## 8. データフェッチパターン

### 8.1 Server Components（推奨）

一覧・詳細ページは Server Components でフェッチ。SEO + 初回表示速度に有利。

```typescript
// apps/web/src/app/dataset/page.tsx
export default async function DatasetsPage({ searchParams }) {
  const params = new URLSearchParams(searchParams)
  const res = await serverFetch(`/api/v1/packages?${params}`)
  const data = await res.json()
  return <DatasetList data={data} />
}
```

### 8.2 Client Components（操作系）

作成・編集フォーム、削除確認は Client Components。

```typescript
// submit handler
const onSubmit = async (values: CreatePackageInput) => {
  const res = await clientFetch('/api/v1/packages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(values),
  })
  if (!res.ok) { /* エラーハンドリング */ }
  router.push(`/dataset/${values.name}`)
}
```

## 9. i18n

Phase 2 では `next-intl` の構造を用意し、日本語をデフォルトとする。翻訳は段階的に追加。

```
apps/web/
├── messages/
│   ├── ja.json          # 日本語（デフォルト）
│   └── en.json          # 英語（スタブ）
```

初期は UI ラベル（ナビ、ボタン、フォームラベル）のみ。コンテンツ（データセット名等）は翻訳対象外。

## 10. Docker Compose 更新

`apps/web` の dev サーバーを追加。

```yaml
# docker/compose.yml に追加（Phase 2）
# Note: 開発時は pnpm dev で直接起動するため、Docker は本番/CI用
```

開発中は `pnpm dev` で API (port 3000) + Web (port 3001) が同時起動。

## 11. 環境変数

### 11.1 `apps/web/.env.local`

```bash
NEXT_PUBLIC_API_URL=http://localhost:3000
```

### 11.2 `.env.example` 追記

```bash
# Frontend
NEXT_PUBLIC_API_URL=http://localhost:3000
```

## 12. CORS 設定

API 側の CORS を `apps/web` の origin に対応させる。開発中は `http://localhost:3001`。

```typescript
// apps/api/src/app.ts の CORS 設定に追加
cors({
  origin: ['http://localhost:3001'],
  credentials: true,  // Cookie 送信に必要
})
```

## 13. 実装順序

### Step 1: プロジェクトスケルトン

1. `packages/ui` — shadcn/ui セットアップ、基本コンポーネント追加
2. `apps/web` — Next.js 15 初期化、Tailwind CSS 4、globals.css
3. turbo.json / pnpm-workspace は既に対応済み
4. 環境変数、CORS 設定

### Step 2: レイアウトと認証

5. ルートレイアウト（ヘッダー、フッター）
6. Better Auth クライアント（`auth-client.ts`）
7. ログイン / 登録ページ
8. ダッシュボードレイアウト（認証ガード、サイドバー）

### Step 3: 公開ページ

9. トップページ（最新データセット + 検索バー）
10. データセット一覧（ページネーション、検索）
11. データセット詳細（メタデータ + リソース一覧）
12. 組織一覧 / 詳細
13. グループ一覧 / 詳細
14. 検索結果ページ（フィルター付き）

### Step 4: 管理ページ

15. ダッシュボードトップ
16. データセット作成フォーム
17. データセット編集フォーム（+ リソース追加）
18. 組織 / グループ管理
19. APIトークン管理
20. プロフィールページ

### Step 5: 仕上げ

21. i18n 構造セットアップ（ja.json / en.json）
22. レスポンシブ対応（モバイル）
23. ローディング UI（Skeleton）
24. エラーページ（404、500）
25. テスト（コンポーネント単体テスト）

## 14. 主要 dependencies（`apps/web`）

```json
{
  "dependencies": {
    "next": "15.x",
    "react": "19.x",
    "react-dom": "19.x",
    "better-auth": "1.x",
    "@kukan/shared": "workspace:*",
    "@kukan/ui": "workspace:*",
    "next-intl": "4.x",
    "nuqs": "2.x",
    "react-hook-form": "7.x",
    "@hookform/resolvers": "3.x",
    "zod": "3.x"
  },
  "devDependencies": {
    "typescript": "5.x",
    "tailwindcss": "4.x",
    "@tailwindcss/postcss": "4.x",
    "postcss": "8.x"
  }
}
```

## 15. Phase 2 完了基準

- [ ] `pnpm build` が `apps/web` を含めて全パッケージで成功
- [ ] `pnpm dev` で API + Web が同時起動
- [ ] トップページ、データセット一覧/詳細、組織一覧/詳細、グループ一覧/詳細が表示
- [ ] 全文検索が動作（キーワード入力 → 結果表示）
- [ ] ログイン / ユーザー登録が動作
- [ ] ダッシュボードにログイン後アクセス可能
- [ ] データセット作成/編集/削除がフォームから操作可能
- [ ] 組織/グループの作成が管理画面から操作可能
- [ ] APIトークンの生成/削除がUIから操作可能
- [ ] レスポンシブ対応（モバイル表示が崩れない）
- [ ] `pnpm test` が全テスト合格（既存194 + 新規）
