# ADR-036: DB-Backed Runtime System Settings

## Status

**Accepted**

## Context

Until now every KUKAN setting was an environment variable, fixed at startup;
changing a value required a redeploy. For most settings that is correct
(inseparable from infrastructure, rarely changed), but it fits poorly for
**settings that are tuned iteratively during operation**.

The first concrete case is the vector-search similarity floor (ADR-034):

- It is model- and data-dependent, tuned iteratively while running the
  golden-set evaluation (`pnpm eval:search`)
- In environments like demo, where the deploy pipeline lives outside this
  repository, a redeploy per env change makes tuning turnaround painfully slow

An admin UI (sysadmin-only) already exists, but there was no mechanism for
runtime-adjustable settings (no settings table, no settings API).

## Decision

### Runtime settings backed by a `system_setting` table

Add a generic key/value table (`key` varchar UNIQUE + `value` jsonb), accessed
through `SystemSettingService`.

- Reads go through an **lru-cache (30 s TTL)**. The writing instance refreshes
  immediately; other instances (multiple ECS tasks) converge within the TTL
- Every setting is declared in an in-service **registry** (key + Zod schema +
  default) and accessed through typed generic `getSetting` / `setSetting`.
  Invalid or missing values **degrade to the default** (never a 500); adding a
  setting is one registry entry
- Writes happen only through a sysadmin-only **generic API** and are recorded
  in `audit_log` (entityType `system_setting`, `{ key, value, previous }` shape):
  - `GET /api/v1/admin/settings` — current value of every setting
  - `PUT /api/v1/admin/settings/:key` — validated by the registry schema.
    **Adding a setting requires no API change** (one registry entry + admin UI)
  - The only exception is the read-only `GET /api/v1/admin/settings/vector-search`
    context endpoint (its fusion of env + AI adapter + search capability cannot
    be derived from the registry)

### When env, when runtime setting

Not every setting moves to the DB. The criterion:

| Nature of the setting                                                     | Where it lives              |
| ------------------------------------------------------------------------- | --------------------------- |
| Inseparable from infrastructure (endpoints, IAM-coupled, model selection) | env / CDK (as before)       |
| Tuned iteratively during operation, cheap to revert                       | `system_setting` + admin UI |

When a setting has an env/code-side base, the runtime setting **layers on top
of that base** rather than replacing it, avoiding precedence conflicts (e.g.
the threshold notch offset). Pure content settings with no underlying base
(e.g. the example queries) live in the runtime setting alone. Future candidates
(e.g. moving `registrationEnabled` to the DB) reuse the same table and service.

## First applications

Three search-related settings became adjustable from the admin UI
(`/dashboard/admin/site`).

### Semantic search on/off (`semantic-search-enabled`)

A global kill switch for the vector leg of hybrid search (default on). During
an embedding-provider outage or a quality investigation, searches fall back to
keyword-only without a redeploy. When off, the query embedding itself is
skipped, so no provider cost is incurred.

### Example search queries (`search-example-queries`)

The example-query chips under the search box. They are content that evolves
with the catalog — closer to announcements than to brand identity.
Consequently `brandConfig.searchExampleQueries` (ADR-023) is **removed** and
the admin UI becomes the single home for this content (no dual sources; forks
move their values from the brand config to the admin UI on the next upgrade).
Unset or an empty list hides the chips.

### Notch-based threshold adjustment (`vector-similarity-notches`)

Adjusts the similarity floor near its base — a concrete instance of the
layering principle.

- Only an integer notch offset from the base is stored (**±4, one notch =
  0.025**). The effective floor is computed at query time as
  `base + notches × 0.025`, clamped to [0, 1]. The base resolution order is
  unchanged (env `SEARCH_VECTOR_MIN_SIMILARITY` > model's measured
  recommendation > 0.45)
- **Safe across model changes**: floors are distribution-specific per model
  (ADR-034: Titan v2 = 0.15 / Cohere v4 = 0.3 / bge-m3 = 0.45); a stored
  absolute value would silently misapply after a model switch. "One notch
  looser than the base" keeps its meaning across models, so no invalidation
  logic is needed
- **Structurally bounded range**: free input allows 0.9 (kills all hits) or 0
  (no filtering); ±4 notches (±0.10) caps the damage at "slightly looser /
  stricter". Each model's recommendation was chosen as the point retaining
  97–99% of peak retrieval (ADR-034), so operational tuning stays nearby
- The offset is applied as a per-call argument to `searchByVector`, keeping the
  adapter stateless. Notch 0 (unset) behaves exactly as before

**Embedding model selection stays out of the admin UI.** IAM scopes
`bedrock:InvokeModel` to the configured model's ARN (deliberate, to keep env
and IAM from diverging), Marketplace models need a subscription step, and a
switch stalls vector search until all packages are re-embedded — all marks of
an infrastructure-side setting. The admin UI only displays model information
(embeddingKey, base value, its source).

## Consequences

- The runtime-settings foundation (table, service, audit) is in place; adding a
  future setting only requires a registry entry (key + schema + default)
- Sysadmins adjust the similarity floor within ±0.10 without a redeploy
  (effective within 30 s). Serious tuning still happens via `pnpm eval:search`;
  the UI's role is limited to applying an evaluated value immediately

## Related

- ADR-034: Metadata vector search (measured floors and resolution order)
- Implementation spec: `docs/specs/en/phase5-vector-search.md`
