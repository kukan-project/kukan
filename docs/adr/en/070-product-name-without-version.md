# ADR-070: Name the product, and keep the version from anonymous callers

## Status

**Accepted** — 2026-10-27

Public pages carry `<meta name="generator" content="KUKAN">` in `<head>`: the product name only,
never the version, and a site can turn it off. Nothing an anonymous caller receives carries KUKAN's
version — pages, the API, headers, MCP, or the User-Agent the worker sends to other servers. The
version is shown only on the admin screen, to an authenticated system administrator.

## Context

### 1. Why name the product

We want to know who runs KUKAN. Being able to count public sites shows how far it has spread, and
gives a place to start when a bug or vulnerability has to be reported to the people running it. The
HTML `generator` meta is where CMSs and static site generators conventionally say this.

### 2. Why not the version

- **Vulnerability assessments report it.** The assessments that local-government sites go through
  list "version disclosure" as a finding. Installing KUKAN should not hand a site something to fix.
- **It singles out unpatched sites.** Once a vulnerability is published, a site that names its
  version can be judged from outside with a single request: is it stuck on an affected release or
  not. With the product name alone, that takes trying the attack.

The product and the version can be handled apart. The name tells only that this is KUKAN, which the
page structure and paths give away anyway. The version is what helps an attacker pick targets.

### 3. Paths surveyed (2026-10-27, develop `ac20d9d8`)

| Path                         | As surveyed                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Next.js `X-Powered-By`       | Pages carry `X-Powered-By: Next.js` (no version)                                                                   |
| Hono, Caddy, CloudFront, ALB | `Server: Caddy`, `Via: … (CloudFront)`, `Server: awselb/2.0` on errors the ALB generates. None is KUKAN's version  |
| CKAN-compatible API          | `status_show` (the action where CKAN returns `ckan_version`) is not implemented. No other action carries a version |
| Public API                   | `/api/health` is `{status, timestamp}`; `/api/v1/site/settings` has no version. No OpenAPI is published            |
| Client bundle                | No version passed through `NEXT_PUBLIC_*`. Only a `server-only` module reads it                                    |
| Error responses              | An unexpected exception is a 500 with fixed wording. No stack, driver message or OpenSearch detail                 |
| MCP `serverInfo.version`     | A fixed `1.0.0`, not tied to the release                                                                           |
| **Worker User-Agent**        | **Sent `KUKAN/<version> (+<site>)` to other servers**                                                              |
| Next.js itself               | The client chunks contain `window.next={version:"16.x.y"}`                                                         |

Anyone who can register a resource URL can read the worker's User-Agent: point the URL at a server of
their own and have the worker fetch it. On a site with `nameSiteInUserAgent`, the site URL and the
version sat in the same header, telling directly which site runs which release.

## Options considered

### A) Name neither the product nor the version — rejected

The safest for an assessment, but it defeats the purpose of knowing who runs KUKAN. The name can be
inferred from the page structure, so hiding it gains little.

### B) Name both (`KUKAN 0.39.0`) — rejected

The shape WordPress and others have used by default. It carries both points of §2 as they are.

### C) Name the product, not the version, and let a site turn the name off — adopted

Counting sites needs only the name; assessments object only to the version. A site that wants not to
name even the product (an assessment flagged it too, or a closed deployment has no reason to) gets a
setting to turn it off.

## Decision

### 1. The generator meta

- The root layout's `generateMetadata` returns `generator: 'KUKAN'`: the product, never the version
- The environment variable `GENERATOR_META_ENABLED` (default `true`) turns it off. The web reads it
  per request, so switching it needs no image build
- On AWS it is `generatorMeta` in the environment definition (default `true`): a per-site field like
  `nameSiteInUserAgent`, written on each site entry in a multi-site environment. Only `false` passes
  `GENERATOR_META_ENABLED=false` to the task, so a site left on keeps the task definition it had
- On Docker Compose it goes in `.env` (`sites/<site>.env` for multi-site)
- Not in the brand configuration (`brandConfig`): a brand is fixed at build time, and sites sharing a
  brand could not differ

After a switch, pages the CDN has cached keep the old value until they expire. Invalidate them to
apply it at once.

### 2. No version to anonymous callers

- Next.js `poweredByHeader: false`. It carries no version, but it names the framework to no reader
- The worker's User-Agent drops the version: `KUKAN (+<site>)`. The product token a `robots.txt`
  names is still `KUKAN`. The root `package.json`, copied into the worker image only to read the
  version, is no longer copied
- No `status_show` in the CKAN-compatible API. A CKAN client calling it gets a 400
- Tests pin this down. They call the main APIs anonymously (health check, site settings, datasets,
  the CKAN-compatible actions, the sitemap, MCP `initialize`, and several errors) and check that
  neither headers nor bodies contain the root `package.json` version. Only Next.js sends
  `X-Powered-By`, so a test pins its setting (`poweredByHeader: false`)

### 3. MCP `serverInfo.version`

The MCP specification requires the field. It is detached from KUKAN's release and treated as **the
version of the MCP surface** (`MCP_SERVER_VERSION`): a major for a tool removed or a result reshaped,
a minor for a tool added, unchanged across releases that leave the tools alone. A client can judge
what it is talking to from it, and an anonymous caller learns nothing about the release.

### 4. How administrators check the version

The existing mechanism. "Running version" under `/dashboard/admin/site` shows the release and the
Node version. `next build` embeds the root `package.json` version, read only by a `server-only`
module, and the page checks on the server that the user is a sysadmin. No new authenticated API is
added: the admin screen is enough, and every extra endpoint that returns the version is another path
that could be opened to anonymous callers by mistake.

## Consequences

- Public pages gain `<meta name="generator" content="KUKAN">` (by default)
- The User-Agent other servers receive changes from `KUKAN/<version> …` to `KUKAN …`. A server that
  told KUKAN apart by the version in the User-Agent has to use the product token
- Page responses no longer carry `X-Powered-By: Next.js`

## Open issues

1. **The version Next.js embeds.** The client chunks contain `window.next={version:"16.x.y"}`.
   Next.js writes it into its code, and no setting removes it. It is the framework's version, not
   KUKAN's, and removing it with a pnpm patch would mean reapplying the patch on every update.
   Assessments look mainly at headers and meta, so it stays for now. The defence against Next.js
   vulnerabilities is applying updates quickly, not hiding the version
2. **The `Server` header from CloudFront and the ALB.** Errors the ALB generates carry
   `Server: awselb/2.0`. A CloudFront response headers policy could remove it, but not
   `Server: CloudFront` on errors CloudFront generates itself. With only half the effect, it is left
   alone for now

## Related

- ADR-012: API as a library, single origin (the web and the API that read the version share a process)
- ADR-027: CloudFront reintroduction (delay before cached pages reflect a change)
- ADR-032: MCP data query
- ADR-035: Semantic versioning and release notes (the root `package.json` is the version of record)
- ADR-041: Multi-site deployment (per-site settings)
- ADR-060: CKAN-compatible API matches CKAN 2.12 reads
