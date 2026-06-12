> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/026-api-cache-control.md`](../jp/026-api-cache-control.md).

# ADR-026: API Cache-Control Header Strategy

## Status

**Accepted**

## Context

Hono API responses had no `Cache-Control` headers set
(except for resource file stream endpoints). When headers are unset,
caching behavior depends on the browser or CDN/proxy implementation,
risking unintended caching or authentication data leakage.

Regardless of whether CloudFront is used, the origin should explicitly
declare cache control.

## Decision

**Set defaults via Hono middleware, and override with `publicCache()` only for public routes.**

### Default Middleware (`cacheControl`)

Applied to all API routes. Sets `Cache-Control` only if not already present on the response.

| HTTP Method                 | Default Value       | Reason                                                      |
| --------------------------- | ------------------- | ----------------------------------------------------------- |
| GET / HEAD                  | `private, no-cache` | Results may vary by authentication, so err on the safe side |
| POST / PUT / PATCH / DELETE | `private, no-store` | Requests with side effects                                  |

- `private` — Do not store in shared caches (CDN / proxy)
- `no-cache` — May store in browser cache, but must revalidate with origin before use
- `no-store` — Do not store in any cache

Responses that already have `Cache-Control` set by route handlers
(e.g., file downloads returning `new Response()` with a stream) are skipped.

### Public Route Middleware (`publicCache()`)

Applied to fully public GET routes (the response data itself does not vary by authentication).

```
publicCache(maxAge = 60, swr = 300)
→ Anonymous: public, max-age={maxAge}, stale-while-revalidate={swr}
→ Authenticated: no header set; falls through to the default (private, no-cache)
```

- `public` — Allow caching by CDN / proxy
- `max-age` — Cache validity period (seconds)
- `stale-while-revalidate` — Period during which stale cache is served while revalidating in the background

Not applied to error responses (status 400 or above).
This prevents temporary DB errors or other failure responses from being cached by CDNs.

#### Authenticated requests are not cached (auth-aware)

When `c.get('user')` is present (i.e. authenticated), `publicCache()` **skips** setting
the `public` header and lets the default middleware's `private, no-cache` take effect.

The data itself does not vary by authentication, but a signed-in user's own
create/delete/restore actions could appear stale for up to `max-age` seconds in
**their own browser's private cache**. Note that `public, max-age=60` is honored not
only by CDNs but also by the browser's local cache.

This aligns the **two cache layers**:

- **CloudFront (shared cache)**: injects `x-cache-bypass` for requests carrying a
  `.session_token` cookie, bypassing the edge cache (ADR-027 / `viewer-request.js`).
- **Origin `Cache-Control` (browser private cache)**: this ADR's `publicCache()` skips
  auth-aware, requiring authenticated users to revalidate every time.

In local development / on-premises (no CloudFront), there is no edge bypass, so this
origin-side auth-aware skip is the only layer guaranteeing immediate freshness for
authenticated users.

### Route Classification

| Category                                                       | Cache-Control                                                                          | Application Method                     |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------- |
| GET where results vary by auth (packages, announcements, etc.) | `private, no-cache`                                                                    | Default (no change needed)             |
| Auth-required GET (users/me, admin, etc.)                      | `private, no-cache`                                                                    | Default (no change needed)             |
| Writes (POST/PUT/DELETE)                                       | `private, no-store`                                                                    | Default (no change needed)             |
| Fully public GET (organizations, groups, tags, etc.)           | Anon: `public, max-age=60, stale-while-revalidate=300` / Auth: `private, no-cache`     | Apply `publicCache()`                  |
| Static public data (license_list)                              | Anon: `public, max-age=3600, stale-while-revalidate=86400` / Auth: `private, no-cache` | Apply `publicCache(3600, 86400)`       |
| File streams (download, preview, text)                         | `private, max-age=0` / `private, max-age=300`                                          | Keep existing                          |
| Health check                                                   | `no-cache`                                                                             | Individual setting (no sensitive data) |

### publicCache() Applied Routes

| Route File       | Endpoint                                 | Setting                    |
| ---------------- | ---------------------------------------- | -------------------------- |
| tags.ts          | Entire router (`tagsRouter.use`)         | `publicCache()`            |
| organizations.ts | `GET /`, `GET /:nameOrId`                | `publicCache()`            |
| groups.ts        | `GET /`, `GET /:nameOrId`                | `publicCache()`            |
| resources.ts     | `GET /formats`                           | `publicCache()`            |
| app.ts           | `GET /api/v1/site/settings`              | `publicCache()`            |
| ckan-compat.ts   | `organization_list`, `organization_show` | `publicCache()`            |
| ckan-compat.ts   | `group_list`, `group_show`               | `publicCache()`            |
| ckan-compat.ts   | `tag_list`, `tag_show`                   | `publicCache()`            |
| ckan-compat.ts   | `license_list`                           | `publicCache(3600, 86400)` |

## Impact

- New: `packages/api/src/middleware/cache-control.ts` (`cacheControl`, `publicCache`)
- Changed: `packages/api/src/app.ts` (middleware registration)
- Changed: Above route files (`publicCache()` applied)
- On-premises: Caddy has no caching functionality, so this functions as browser cache control
- CloudFront: Functions defensively as origin headers (see ADR-027)
- The auth-aware skip in `publicCache()` means authenticated users never receive `public`.
  Dashboard create/delete/restore actions reflect immediately (resolving staleness from
  the browser's private cache), while anonymous caching efficiency and SEO are preserved.

## Related

- ADR-027 (CloudFront reintroduction): `docs/adr/en/027-cloudfront-reintroduction.md`
- Implementation: `packages/api/src/middleware/cache-control.ts`
