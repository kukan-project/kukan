> **Note**: This is a machine-translated version of the original Japanese implementation spec for reference purposes. The authoritative version is [`jp/phase2-frontend.md`](../jp/phase2-frontend.md).

# Phase 2: Frontend — Implementation Spec

> **This is a record of a completed phase.** Later ADRs have changed parts of the implementation,
> so for the current shape see the phase list in `CLAUDE.md` and `docs/pipeline.md`. The file paths
> and step names below are the ones in use at the time.

> **Goal**: Implement the catalog UI, the authentication flow and the admin screens with
> Next.js 16, making the Phase 1 API operable from a browser

## 1. Prerequisites

- The Phase 1 API is complete (CRUD + CKAN compatibility + search + authentication)
- Better Auth email/password authentication + API key authentication work
- `apps/web` and `packages/ui` do not exist yet

## 2. Technology Stack

| Category         | Technology                         | Notes                                       |
| ---------------- | ---------------------------------- | ------------------------------------------- |
| Framework        | Next.js 16 (App Router)            | Server Components first                     |
| UI library       | shadcn/ui                          | Radix UI based, copied into `packages/ui`   |
| Styling          | Tailwind CSS 4                     | CSS-first config                            |
| State management | React Server Components + `nuqs`   | URL state management                        |
| Data fetching    | Server Components + Route Handlers | Clients use `fetch`                         |
| Forms            | React Hook Form + Zod              | Reuses the `@kukan/shared` validators       |
| Auth client      | `better-auth/react`                | Session cookie managed automatically        |
| i18n             | `next-intl`                        | Japanese/English; structure only in Phase 2 |
| Testing          | Vitest + Testing Library           | Components; E2E from Phase 3+               |

## 3. Directory Layout

### 3.1 `apps/web`

```
apps/web/
├── src/
│   ├── app/
│   │   ├── layout.tsx                  # root layout (header/footer)
│   │   ├── page.tsx                    # top page (search + stats)
│   │   ├── globals.css                 # Tailwind + CSS variables (theme)
│   │   │
│   │   ├── dataset/
│   │   │   ├── page.tsx                # dataset list (search/filters)
│   │   │   └── [nameOrId]/
│   │   │       └── page.tsx            # dataset detail
│   │   │
│   │   ├── organization/
│   │   │   ├── page.tsx                # organization list
│   │   │   └── [nameOrId]/
│   │   │       └── page.tsx            # organization detail (its datasets)
│   │   │
│   │   ├── group/
│   │   │   ├── page.tsx                # group list
│   │   │   └── [nameOrId]/
│   │   │       └── page.tsx            # group detail
│   │   │
│   │   ├── search/
│   │   │   └── page.tsx                # full-text search results
│   │   │
│   │   ├── auth/
│   │   │   ├── sign-in/
│   │   │   │   └── page.tsx            # sign-in form
│   │   │   └── sign-up/
│   │   │       └── page.tsx            # sign-up form
│   │   │
│   │   └── dashboard/
│   │       ├── layout.tsx              # admin layout (sidebar)
│   │       ├── page.tsx                # dashboard home
│   │       ├── datasets/
│   │       │   ├── page.tsx            # manage my datasets
│   │       │   ├── new/
│   │       │   │   └── page.tsx        # create a dataset
│   │       │   └── [nameOrId]/
│   │       │       └── edit/
│   │       │           └── page.tsx    # edit a dataset
│   │       ├── organizations/
│   │       │   ├── page.tsx            # manage organizations
│   │       │   └── new/
│   │       │       └── page.tsx        # create an organization
│   │       ├── groups/
│   │       │   ├── page.tsx            # manage groups
│   │       │   └── new/
│   │       │       └── page.tsx        # create a group
│   │       ├── api-tokens/
│   │       │   └── page.tsx            # manage API tokens
│   │       └── profile/
│   │           └── page.tsx            # profile settings
│   │
│   ├── components/
│   │   ├── layout/
│   │   │   ├── header.tsx              # site header (nav + search + user menu)
│   │   │   ├── footer.tsx              # site footer
│   │   │   └── sidebar.tsx             # admin sidebar
│   │   ├── dashboard/
│   │   │   ├── dataset/
│   │   │   │   ├── dataset-form.tsx    # create/edit form
│   │   │   │   ├── resource-list.tsx   # resource list table
│   │   │   │   └── resource-form.tsx   # resource add/edit form
│   │   │   ├── organization/
│   │   │   │   └── organization-form.tsx
│   │   │   ├── group/
│   │   │   │   └── group-form.tsx
│   │   │   ├── delete-confirm-dialog.tsx
│   │   │   ├── page-header.tsx
│   │   │   └── user-provider.tsx       # UserProvider context
│   │   ├── search/
│   │   │   ├── search-bar.tsx          # global search bar
│   │   │   ├── search-results.tsx      # search result list
│   │   │   └── search-filters.tsx      # filter sidebar
│   │   ├── tag/
│   │   │   └── tag-badge.tsx           # tag badge
│   │   └── auth/
│   │       ├── sign-in-form.tsx
│   │       ├── sign-up-form.tsx
│   │       └── user-menu.tsx           # user menu in the header
│   │
│   ├── lib/
│   │   ├── server-api.ts              # for Server Components (serverFetch, getCurrentUser)
│   │   ├── client-api.ts              # for Client Components (clientFetch)
│   │   ├── hono-app.ts                # Hono app singleton
│   │   ├── auth-client.ts              # Better Auth React client
│   │   └── utils.ts                    # utilities (cn() etc.)
│   │
│   └── hooks/
│       ├── use-session.ts              # auth session hook
│       └── use-pagination.ts           # URL-based pagination
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
│   │   └── ui/                         # shadcn/ui components
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
│   │   └── utils.ts                    # cn() helper
│   └── index.ts                        # re-export
├── package.json
└── tsconfig.json
```

## 4. Pages and Features

### 4.1 Public pages (no authentication)

| Page                | Path                       | Data source                            | Features                          |
| ------------------- | -------------------------- | -------------------------------------- | --------------------------------- |
| Top                 | `/`                        | `GET /api/v1/packages?limit=5` + stats | Latest datasets, search bar       |
| Dataset list        | `/dataset`                 | `GET /api/v1/packages`                 | Pagination, search, filters       |
| Dataset detail      | `/dataset/[nameOrId]`      | `GET /api/v1/packages/:nameOrId`       | Metadata, resource list, tags     |
| Organization list   | `/organization`            | `GET /api/v1/organizations`            | Card list                         |
| Organization detail | `/organization/[nameOrId]` | `GET /api/v1/organizations/:nameOrId`  | Org info + its datasets           |
| Group list          | `/group`                   | `GET /api/v1/groups`                   | Card list                         |
| Group detail        | `/group/[nameOrId]`        | `GET /api/v1/groups/:nameOrId`         | Group info                        |
| Search results      | `/search?q=...`            | `GET /api/v1/search`                   | Full-text search, org/tag filters |
| Sign in             | `/auth/sign-in`            | `POST /api/auth/sign-in`               | Email/password                    |
| Sign up             | `/auth/sign-up`            | `POST /api/auth/sign-up`               | Email/password                    |

### 4.2 Admin pages (authentication required)

| Page                 | Path                                  | Features                                      |
| -------------------- | ------------------------------------- | --------------------------------------------- |
| Dashboard            | `/dashboard`                          | My dataset count, recent changes              |
| Manage datasets      | `/dashboard/datasets`                 | List of my datasets                           |
| Create dataset       | `/dashboard/datasets/new`             | Form (Zod validation)                         |
| Edit dataset         | `/dashboard/datasets/[nameOrId]/edit` | Form + resource management                    |
| Manage organizations | `/dashboard/organizations`            | Organization list (only sysadmins can create) |
| Create organization  | `/dashboard/organizations/new`        | Form                                          |
| Manage groups        | `/dashboard/groups`                   | Group list                                    |
| Create group         | `/dashboard/groups/new`               | Form                                          |
| API tokens           | `/dashboard/api-tokens`               | Generate/list/delete tokens                   |
| Profile              | `/dashboard/profile`                  | Display user information                      |

## 5. API Client

### 5.1 API client (server-api.ts / client-api.ts)

Split into separate files for Server Components and Client Components. `server-api.ts` uses
`import 'server-only'` to keep it out of the client bundle.

```typescript
// apps/web/src/lib/server-api.ts — for Server Components (in-process Hono call)
import 'server-only'

export async function serverFetch(path: string, init?: RequestInit) {
  const { cookies } = await import('next/headers')
  const { getApp } = await import('./hono-app')
  const { SESSION_COOKIE_NAME } = await import('@kukan/shared')

  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(SESSION_COOKIE_NAME)

  const app = await getApp()
  const url = `http://localhost${path}`

  return app.request(url, {
    ...init,
    headers: {
      ...init?.headers,
      ...(sessionToken && { Cookie: `${SESSION_COOKIE_NAME}=${sessionToken.value}` }),
    },
  })
}

// apps/web/src/lib/client-api.ts — for Client Components (same origin, so fetch a relative path)
export async function clientFetch(path: string, init?: RequestInit) {
  return fetch(path, { ...init, credentials: 'include' })
}
```

**When to use which:**

- Public pages (SEO required) → `serverFetch` (SSR)
- Dashboard pages (auth required, interactive) → `clientFetch` (CSR)
- The auth guard in the dashboard layout → `getCurrentUser` (SSR, `server-api.ts`)

### 5.2 `apps/web/src/lib/auth-client.ts`

```typescript
import { createAuthClient } from 'better-auth/react'

// same origin, so no baseURL needed
export const authClient = createAuthClient()

export const { signIn, signUp, signOut, useSession } = authClient
```

## 6. Theme and Styling

Follows ADR-010. Phase 2 implements **Tier 1: CSS Variables** only.

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

## 7. Authentication Flow

### 7.1 Sign in

1. The user enters email/password at `/auth/sign-in`
2. `authClient.signIn.email()` → `POST /api/auth/sign-in/email`
3. Better Auth returns the session cookie via Set-Cookie
4. Redirect → `/dashboard`

### 7.2 Reading the auth state

- **Server Component**: read it with `getCurrentUser()` (`server-api.ts`). Deduplicated per
  request with React.cache.
- **Client Component**: the `useUser()` hook (via the `UserProvider` context) or `useSession()`
  (Better Auth React)

### 7.3 Auth guard

`/dashboard/*` routes check the session in `layout.tsx` (SSR). Unauthenticated users are
redirected to `/auth/sign-in`. The authenticated user's information is propagated to child Client
Components through `UserProvider`.

```typescript
// apps/web/src/app/dashboard/layout.tsx
import { getCurrentUser } from '@/lib/server-api'
import { UserProvider } from '@/components/dashboard/user-provider'

export default async function DashboardLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) redirect('/auth/sign-in')
  return <UserProvider user={user}>...</UserProvider>
}
```

## 8. Data Fetching Patterns

### 8.1 Public pages — Server Components (SSR)

List and detail pages use `serverFetch` from Server Components. Better for SEO and first paint.

```typescript
// apps/web/src/app/dataset/page.tsx
import { serverFetch } from '@/lib/server-api'

export default async function DatasetsPage({ searchParams }) {
  const params = new URLSearchParams(searchParams)
  const res = await serverFetch(`/api/v1/packages?${params}`)
  const data = await res.json()
  return <DatasetList data={data} />
}
```

### 8.2 Dashboard pages — Client Components (CSR)

Listing, creating, editing and deleting in the dashboard use `clientFetch` from Client Components.
User information comes from the `useUser()` hook.

```typescript
// submit handler
const onSubmit = async (values: CreatePackageInput) => {
  const res = await clientFetch('/api/v1/packages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(values),
  })
  if (!res.ok) {
    /* error handling */
  }
  router.push(`/dataset/${values.name}`)
}
```

## 9. i18n

Phase 2 sets up the `next-intl` structure with Japanese as the default. Translations are added
incrementally.

```
apps/web/
├── messages/
│   ├── ja.json          # Japanese (default)
│   └── en.json          # English (stub)
```

Initially only UI labels (navigation, buttons, form labels). Content (dataset names etc.) is not
translated.

## 10. Docker Compose Update

Add the `apps/web` dev server.

```yaml
# added to docker/compose.yml (Phase 2)
# Note: during development you run it directly with pnpm dev, so Docker is for production/CI
```

The Hono API is embedded in Next.js, so `pnpm dev` only needs to start Next.js (port 3000).

## 11. Environment Variables

The API has moved into `packages/api`. `next.config.ts` uses `dotenv` to load the monorepo root
`.env`. `NEXT_PUBLIC_API_URL` is not needed (same origin).

## 12. CORS Configuration

No CORS configuration is needed thanks to the single-origin setup. In standalone API mode it is
controlled by the `TRUSTED_ORIGINS` environment variable.

## 13. Implementation Order

### Step 1: Project skeleton

1. `packages/ui` — set up shadcn/ui, add the basic components
2. `apps/web` — initialize Next.js 16, Tailwind CSS 4, globals.css
3. turbo.json / pnpm-workspace are already handled
4. Environment variable setup

### Step 2: Layout and authentication

5. Root layout (header, footer)
6. Better Auth client (`auth-client.ts`)
7. Sign-in / sign-up pages
8. Dashboard layout (auth guard, sidebar)

### Step 3: Public pages

9. Top page (latest datasets + search bar)
10. Dataset list (pagination, search)
11. Dataset detail (metadata + resource list)
12. Organization list / detail
13. Group list / detail
14. Search results page (with filters)

### Step 4: Admin pages

15. Dashboard home
16. Dataset creation form
17. Dataset edit form (+ adding resources)
18. Organization / group management
19. API token management
20. Profile page

### Step 5: Finishing touches

21. i18n structure setup (ja.json / en.json)
22. Responsive support (mobile)
23. Loading UI (Skeleton)
24. Error pages (404, 500)
25. Tests (component unit tests)

## 14. Main dependencies (`apps/web`)

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
    "zod": "4.x"
  },
  "devDependencies": {
    "typescript": "5.x",
    "tailwindcss": "4.x",
    "@tailwindcss/postcss": "4.x",
    "postcss": "8.x"
  }
}
```

## 15. Phase 2 Completion Criteria

- [x] `pnpm build` succeeds across all packages including `apps/web`
- [x] `pnpm dev` starts the API and Web together
- [x] The top page, dataset list/detail, organization list/detail and group list/detail render
- [x] Full-text search works (enter a keyword → results displayed)
- [x] Sign-in / sign-up work
- [x] The dashboard is reachable after signing in
- [x] Datasets can be created/edited/deleted from forms
- [x] Organizations/groups can be created from the admin screens
- [x] API tokens can be generated/deleted from the UI
- [x] Responsive support (mobile layout does not break)
- [x] `pnpm test` passes everything (existing 194 + new = 361 tests)
