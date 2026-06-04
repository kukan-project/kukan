> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/012-api-as-library-single-origin.md`](../jp/012-api-as-library-single-origin.md).

# ADR-012: Embed API as a Library in Next.js (Single-Origin + Headless Support)

## Status

Accepted (2026-03-15)

## Context

In Phase 1, `apps/api` (Hono, port 3000) and `apps/web` (Next.js, port 3001) were running as separate processes on different ports. This setup had the following issues:

- CORS configuration management required
- Duplicate management of the `NEXT_PUBLIC_API_URL` environment variable
- Complex Cookie `SameSite` / `Domain` configuration
- Two processes needed during development

On the other hand, CKAN use cases include demand for running the API independently as a **Headless CMS**, where third-party frontends or external systems call the API directly.

## Options Considered

### A) Status Quo (apps/api + apps/web separation)

- Pros: Independent deployment units, ability to scale separately
- Cons: High management cost for CORS, cookies, and environment variables

### B) Convert API to packages/api as a library — Adopted

- Pros:
  - Single origin when embedded in Next.js (no CORS needed, simple cookie configuration)
  - Standalone startup still possible via `server.ts` (Headless mode)
  - Direct invocation from Server Components via `app.request()` with no HTTP hop
  - Only one Next.js process needed during development with `pnpm dev`
- Cons: API scaling is coupled with Next.js (separation may be needed in large-scale environments)

### C) Rewrite API using Next.js API Routes

- Cons: Discards Hono middleware and routing assets. Standalone operation not possible

## Decision

Move `apps/api` to `packages/api` and convert it to a library. Export `createApp()` to support two operational modes.

## Operational Modes

### 1. Embedded Mode (default)

The Hono app is invoked from a Next.js catch-all Route Handler (`app/api/[...path]/route.ts`). The frontend and API run in the same process on the same origin.

```
Browser → Next.js (port 3000) → Route Handler → app.fetch(req) → Hono
                               → Server Component → app.request(path) → Hono (no HTTP hop)
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

Server Components invoke `app.request()` directly via `serverFetch()`, completely eliminating HTTP hops:

```typescript
// apps/web/src/lib/server-api.ts
export async function serverFetch(path: string, init?: RequestInit) {
  const app = await getApp()
  return app.request(`http://localhost${path}`, { ...init, headers: { ... } })
}
```

### 2. Standalone Mode (Headless KUKAN)

Start the Hono app directly as a Node.js HTTP server via `packages/api/src/server.ts`. Provides the API without the Next.js frontend.

```bash
# Development
cd packages/api && pnpm dev:standalone

# Production
cd packages/api && pnpm start
```

**Use cases:**

- **Headless KUKAN**: Use only the API from a custom frontend or SPA
- **External system integration**: CKAN-compatible API access from ETL tools, BI tools, or other systems
- **Microservice separation**: Scale API and Web as separate instances in large-scale environments

In standalone mode, allowed CORS origins are configured via the `TRUSTED_ORIGINS` environment variable (comma-separated).

## Rationale

- 90% of use cases (municipality portals) work fine with a single origin → Embedded mode as default
- Headless demand is supported by simply keeping `server.ts` → Minimal cost
- In-process invocation via `app.request()` is optimal for latency and resource efficiency
- Hono code requires no changes (`createApp()` returns the same app for both modes)

## Impact

- `apps/api/` no longer exists (moved to `packages/api/`)
- `pnpm dev` starts only Next.js (port 3000)
- `NEXT_PUBLIC_API_URL` environment variable is removed
- CORS middleware is removed from `app.ts` (controlled by `TRUSTED_ORIGINS` in standalone mode)
- `vitest.workspace.ts` API test paths updated to `./packages/api`
- Server Components use `serverFetch()` (`server-api.ts`) → `app.request()` with no HTTP hop
- Client Components use `clientFetch()` (`client-api.ts`) with same-origin relative path fetch
- Dashboard pages use CSR (`clientFetch` + `UserProvider` context), public pages use SSR (`serverFetch`)
