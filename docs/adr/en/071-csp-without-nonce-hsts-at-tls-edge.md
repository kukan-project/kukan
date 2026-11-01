# ADR-071: A CSP without a nonce, and HSTS from the TLS terminator

## Status

**Accepted** — 2026-11-01

Every page carries a Content-Security-Policy. Its `script-src` includes `'unsafe-inline'`, with no
nonce and no hashes. The policy arrives in report-only mode (`CSP_MODE`, default `report-only`) and
is switched to `enforce` once no violations show. The Office preview's `frame-src` (ADR-065) stays
enforced throughout. No violation-report endpoint. HSTS is sent only by what terminates TLS — CloudFront
on AWS, a Caddy TLS site block on Docker Compose — with `max-age` of one year, `includeSubDomains`
off by default and chosen per site, and never `preload`.

## Context

### 1. What was missing

A security audit found neither Content-Security-Policy nor Strict-Transport-Security in either the
AWS or the Docker Compose deployment. Around the same time a stored XSS was found and fixed. Had a
CSP been in place, the scripts that XSS could load and the places it could send what it stole would
have been limited. HSTS closes the first plain-HTTP connection to a site served over HTTPS, which is
where a man in the middle sits.

What exists today is the `Content-Security-Policy: frame-src …` that `apps/web/src/proxy.ts` sets
per request (ADR-065 decision 2, keeping the Office preview's sandboxed iframe in) and the four
headers in `next.config.ts` (`X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy`, `Permissions-Policy`).

### 2. The inline-script constraint

Next.js's App Router embeds inline scripts in the HTML for the RSC payload and hydration. Their
content changes with every render, so they cannot be allowed by hash. Next.js's documented route is
a nonce: one per request, with every page rendered dynamically.

KUKAN's public pages are served from CloudFront's HTML cache (ADR-027): the same HTML goes to every
viewer for 60–300 seconds. A nonce must match between header and HTML and must differ per request to
mean anything. A nonce in cached HTML is one everyone shares — no nonce at all. Using one means
giving up the HTML cache.

### 3. What the pages load

- With a brand's `gaMeasurementId`, gtag.js is loaded from `www.googletagmanager.com` and reports to
  `*.google-analytics.com` / `*.analytics.google.com` / `*.googletagmanager.com` (ADR-024)
- The GeoJSON map loads OpenStreetMap and GSI tiles as `<img>`
- Organizations and groups show an image at a URL their editors typed; a brand's logo may sit on its
  own host too
- A file upload is PUT by the browser straight to the presigned URL the API returns
  (`use-file-upload.ts`); that is MinIO or S3, not the site's origin
- Three Web Workers (DuckDB-WASM, the Office package check, the Ichitaro renderer), all loaded from
  the same origin's `_next/static`
- Every form submits through fetch; there is no HTML form submission. Sign-in is email and password,
  with no redirect to an IdP
- `next dev` uses `eval` for Fast Refresh; a production build does not

### 4. Where HSTS can be sent from

Only what terminates TLS may send HSTS. On AWS that is CloudFront (the origin speaks HTTP); on
Compose it is Caddy. Caddy's default is plain HTTP on `:80`, and sites on closed networks such as
LGWAN run without HTTPS.

## Options considered

### A) A nonce with `'strict-dynamic'` — rejected

The strongest form, which stops inline injection. But per §2 it cannot coexist with the HTML cache.
Dropping the cache sends every public page to the origin and gives up the responsiveness and load
tolerance ADR-027 bought.

### B) Hashes — rejected

The inline scripts change per render, so there is no list of hashes to write down.

### C) A policy with `'unsafe-inline'` — adopted

Injected inline scripts are not stopped. What is still bounded: where external scripts may be
loaded from, where data may be sent (`connect-src`), frames, `<object>`, `<base>`, form targets, and
who may embed the page (`frame-ancestors`). The value of this CSP is narrowing what an XSS can load
and where it can exfiltrate, not stopping the injection itself.

### D) Enforce from day one — rejected

The inventory in §3 came from reading the code and may miss what a brand or an environment adds.
Better to report first and confirm than to block and find out.

### E) Report-only first, through `CSP_MODE` — adopted

`Content-Security-Policy-Report-Only` blocks nothing and shows violations in the browser console. The
`securitypolicyviolation` event fires too, so an E2E test can catch them.

### F) A report endpoint (`report-to` / `report-uri`) — rejected

A report endpoint is a write surface open to anyone unauthenticated: it can be fed fake reports, it
costs storage, and browser extensions make it noisy. DevTools and the E2E test are enough.

### G) HSTS `preload` — rejected

Leaving the preload list takes months, so giving up a domain or HTTPS becomes irreversible.
`includeSubDomains` is off by default for the same reason — binding every host under the domain to
HTTPS is the operator's call, not the catalog's.

## Decision

### 1. The policy

Built by `buildContentSecurityPolicy` in `apps/web/src/lib/csp.ts`. For the default brand (no GA4,
production), where `<origin>` is the site's configured origin and the request's (as proxy.ts
already computes them):

```
default-src 'self';
script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https: http:;
font-src 'self' data:;
connect-src 'self';
worker-src 'self';
frame-src <origin>/vendor/ibis-office/boot.html <origin>/api/v1/resources/;
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'self'
```

- `connect-src` also names the upload destination: the origin of `S3_ENDPOINT` when set (MinIO, or
  S3 reached by name), otherwise the bucket's virtual-hosted address the SDK signs for,
  `https://<S3_BUCKET>.s3.<S3_REGION>.amazonaws.com` (for a bucket with a dot in its name the SDK signs
  path-style, so `https://s3.<S3_REGION>.amazonaws.com`; `uploadOrigin`)
- A brand with GA4 adds `https://www.googletagmanager.com` to `script-src` and
  `https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com` to
  `connect-src`
- Development (`NODE_ENV=development`) adds `'unsafe-eval'` to `script-src`, for Fast Refresh
- `img-src` admits any host: organization and group images are URLs their editors typed, and a
  brand's logo may be elsewhere. Exfiltration through `<img>` is therefore not prevented.
  `connect-src 'self'` still bounds fetch, XHR, WebSocket and beacons, which closes the main
  exfiltration path. Map tiles and GA4's measurement pixels pass under the same rule
- `worker-src 'self'`: all three workers load from the same origin, so no `blob:`
- `form-action 'self'`: every form submits via fetch, and sign-in is email and password. Revisit if
  OIDC with a redirect to an IdP arrives — when an HTML form submission is answered by a redirect,
  Chrome applies `form-action` to the redirect target too
- `frame-ancestors 'self'` means what `X-Frame-Options: SAMEORIGIN` means; both are sent
- `frame-src` is ADR-065 decision 2 unchanged; an `office-online` site adds Microsoft's viewer
- No `manifest-src` (there is no manifest)

### 2. How it is sent — `CSP_MODE`

Environment variable `CSP_MODE` (`report-only` / `enforce`, default `report-only`). Read per request
by the web like `OFFICE_PREVIEW_VIEWER`, so switching needs no image build. On AWS it is the site's
`cspMode`; on Compose, `.env` (`sites/<site>.env` for multi-site).

| `CSP_MODE`    | `Content-Security-Policy`               | `Content-Security-Policy-Report-Only` |
| ------------- | --------------------------------------- | ------------------------------------- |
| `report-only` | `frame-src …` (exactly as today)        | the full policy                       |
| `enforce`     | the full policy (`frame-src` inside it) | none                                  |

Report-only does not weaken the enforced `frame-src`. Keeping the Office preview's sandbox in is
ADR-065's decision, separate from this ADR's staged rollout. The ibisOffice boot page keeps its own
policy (`sandbox allow-scripts; default-src 'none' …`) whatever `CSP_MODE` says.

### 3. No report endpoint

Neither `report-to` nor `report-uri` (option F). Verification is the browser's DevTools console and
an E2E test that opens the main pages and asserts no `securitypolicyviolation` fires
(`apps/web/src/__tests__/e2e/csp.e2e.ts`). The event fires in report-only mode too.

### 4. Brand extension

`BrandConfig` gains `csp?: Partial<Record<string, string[]>>` (directive → extra sources), for a
brand that loads JS or CSS from its own host or calls an API on another domain. The default brand
adds nothing. Sources can only be added, never removed.

### 5. HSTS

- **AWS**: a CloudFront ResponseHeadersPolicy (`kukan-<env>[-<site>]-security-headers`) sends
  `Strict-Transport-Security: max-age=31536000`. `includeSubDomains` follows the site's
  `hstsIncludeSubDomains` (default `false`), `preload` is never set, and the origin's value is
  overridden. Attached to every behavior (pages, `/_next/static`, `/api`, `/auth`, `/odata`, the
  sitemap and robots.txt), so whichever path a browser sees first carries it
- The four headers in `next.config.ts` are not copied to CloudFront. The origin puts them on every
  response it makes; a second copy would be one more place for the two to drift apart, and a response
  the origin did not make (an ALB error) carries nothing they protect. HSTS alone is CloudFront's
  job — only the TLS terminator knows the viewer came over HTTPS; the origin does not
- **Compose**: `docker/Caddyfile` gains an `(hsts)` snippet as an example, imported from TLS site
  blocks. The default `:80` block does not send it and its behavior is unchanged

### 6. A note for closed networks

Browsers ignore a `Strict-Transport-Security` received over plain HTTP (RFC 6797 §8.1). A site on a
non-public domain served over HTTP only is unaffected by this ADR.

The one hazard: if a parent domain (say `example.lg.jp`) sends HSTS with `includeSubDomains`, an
HTTP-only site beneath it (`catalog.example.lg.jp`) is forced to HTTPS by the browser and stops
opening. This happens outside KUKAN and KUKAN cannot prevent it. The administrator guide notes it as
a caveat for operators.

## Consequences

- Public page responses gain `Content-Security-Policy-Report-Only`. Nothing is blocked; violations
  show in the browser console
- On AWS the distribution gains one ResponseHeadersPolicy, and every response carries
  `Strict-Transport-Security`. CloudFront already redirects HTTP to HTTPS, so viewers see no change
- On a site set to `enforce`, a brand that loads external JS or CSS is blocked until it lists them
  in `csp`
- A brand's `csp` can only loosen the policy; brand changes are reviewed with that in mind
- `pnpm test:e2e` gains csp.e2e.ts, run against the dev server (with `'unsafe-eval'`)

## Open issues

1. **Flip the default to `enforce`.** Run demo in report-only, confirm there are no violations, and
   change the default in a later release. Note it in the release notes as a breaking change; a site
   that wants to stay in report-only sets `CSP_MODE=report-only` explicitly. The default lives in
   one constant, `DEFAULT_CSP_MODE` in `@kukan/shared`, read by the web's default and by infra's
   "set the variable only away from the default" check alike
2. **Drop `'unsafe-inline'`.** Revisit when Next.js lets its inline scripts be allowed by hash, or
   when a nonce can be handed out in a way the HTML cache tolerates (edge injection)
3. **Narrow `img-src`.** Turning organization and group images into uploads, or making the allowed
   hosts a site setting, would let `https:` go. For now they stay editor-typed URLs
4. **`form-action` when OIDC arrives.** As in decision 1

## Related

- ADR-023 / ADR-042: brand override layer and multi-brand build (where `csp` lives)
- ADR-024: GA4 access analytics (gtag.js hosts)
- ADR-027: CloudFront reintroduction (the HTML cache — why no nonce)
- ADR-041: multi-site deploy (per-site `cspMode` / `hstsIncludeSubDomains`)
- ADR-065: Office originals in the browser (`frame-src` and the boot page's policy)
- ADR-070: name the product without the version (the same way a setting like `OFFICE_PREVIEW_VIEWER` is delivered)
