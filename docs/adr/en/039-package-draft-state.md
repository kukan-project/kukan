# ADR-039: Separating Creation from Publication with a Package Draft State

## Status

**Proposed**

## Context

Dataset creation currently proceeds in this order:

1. Submit the metadata form → package is created (and is public from that
   moment — exposed to search and listings)
2. Add resources on the edit page → upload via presigned URL → pipeline starts

This structure has three problems.

- **Creation = publication**: a half-written dataset is public before its
  resources are in place. If the user abandons the flow, the incomplete
  dataset stays published
- **File-first is impossible**: issuing a presigned URL requires a resourceId,
  and creating a resource requires a packageId, so the user is forced to
  finalize metadata before seeing the file. A UX where metadata is written
  after looking at the data (including future AI metadata suggestions) cannot
  be built on this ordering
- **Upload and publication happen at the same time**: resource operations take
  effect immediately, so "assemble everything, then publish" is not possible

Note that the technical ordering package → resource → upload is a premise of
the FK design and the presigned flow, and is not what this ADR changes.

## Options Considered

### A) Decouple resources from packages (staging uploads)

Allow files to be uploaded before the package exists.

- Problems:
  - Requires making `resource.packageId` nullable, or introducing a separate
    staging-object concept and a presigned flow without a resourceId
  - The pipeline cannot run because `resource_pipeline` is keyed on
    resourceId, so previews and column schemas are unavailable before
    publication
  - No DB record means no resume after interruption; managing resume in the
    DB amounts to reinventing a draft table under another name
  - Requires new TTL cleanup for storage objects with no DB record

### B) Hold everything client-side until save

Keep files in the browser and create package + resources in one shot on save.

- Problems: the save button blocks on uploading all files (up to 100 MB × N),
  a page reload loses everything, and no pipeline material is available
  before publication

### C) Add `draft` to package.state (same as CKAN) — adopted

- Existing read paths (public listings, search-index sync, aggregate counts)
  already filter on `state = 'active'` by default, so drafts become mostly
  invisible with no additional code
- The organization `purging` state (ADR-028) is an existing precedent for a
  third state value, and its transition-guard pattern can be reused

## Decision

**Add `draft` to package `state` (`draft` / `active` / `deleted`), start new
datasets as drafts, and make publication an explicit state transition.**

### 1. Creation flow

- The creation wizard **auto-creates** the draft package. The trigger is the
  first file attachment or the first save action, to avoid empty drafts from
  merely opening the page
- Because `name` (the URL slug) is `unique().notNull()`, draft auto-creation
  generates a placeholder of the form `untitled-<random suffix>` (making the
  column nullable is avoided, as it would ripple into nameOrId lookups and
  indexes). `name` is already mutable via the existing update API, and drafts
  are not externally referenced, so pre-publication renames carry no
  link-breakage risk. **Publishing with the placeholder still in place is not
  allowed** (publish-time validation requires an explicit name, preventing
  datasets with random URLs from going public). Placeholders are random and
  therefore never squat meaningful slugs
- `ownerOrg` is nullable in the DB (it is required only by the creation API's
  validation), so drafts **may leave it unset**. Draft edit permission is
  granted to the `creatorUserId` (the creator) and sysadmins, and — once
  `ownerOrg` is set — also to editors of that organization. Like `name`,
  **`ownerOrg` becomes required at publication**, so the effective constraint
  on published packages is unchanged
- Operations within a draft use the UUID (`nameOrId` lookups accept UUIDs),
  so the placeholder name is never exposed in the UI
- Resource addition, uploads (the 3-step presigned flow), and the pipeline
  (Fetch / Extract) during draft **reuse the existing flows unchanged**.
  Preview generation and column-schema persistence (ADR-029 / ADR-032) also
  run as usual, so preview checks and AI metadata suggestions (follow-up ADR)
  have their material before publication

### 2. Visibility

- Public listings and search go through the search index (ADR-013). Drafts
  are never indexed and are therefore automatically invisible
- Direct DB queries are invisible via the default `state = 'active'` filter
  (existing implementation, unchanged)
- The dashboard shows drafts to their creator (and, once `ownerOrg` is set,
  to members of that organization) as "drafts"
- **The worker's Index step (ADR-021) must check the package state and skip
  content indexing for drafts** (it currently does not look at state and
  needs fixing). Embeddings (ADR-034) are also not generated for drafts

### 3. Publication transition

- Add `POST /api/v1/packages/{id}/publish`. Only `draft` → `active` is
  allowed (same shape as the transition guards in ADR-028). Permission is
  identical to package update permission
- Synchronization performed at publication:
  1. Index the metadata into the search index
  2. Index the content of all active resources
  3. Enqueue the embedding job
- The transition is **one-way**. There is no operation to revert a published
  dataset to draft (unpublishing is the domain of the `private` flag;
  revision management for editing published datasets is out of scope — CKAN
  does not have it either)

### 4. Lifecycle

- Manual deletion happens from the drafts list (card). Since a draft has
  never been public, it is **purged directly with a confirmation dialog,
  without passing through the trash (`deleted`)** (reusing the existing purge
  CASCADE — DB / storage / pipeline-record cleanup; drafts are not
  restorable)
- Abandoned drafts are **purged automatically by a periodic worker job**. A
  daily job is added to the existing croner scheduler (same shape as the
  health check) that CASCADE-deletes drafts whose last activity (the greater
  of `package.updated` and the max of child `resource.updated`) exceeds the
  retention period. CKAN accumulates drafts indefinitely, and abandoned-draft
  buildup is a known operational problem — uploaded files (up to 100 MB × N)
  would otherwise linger in storage, so this is enabled by default
- The retention period is a runtime system setting `draft-retention-days`
  (an application of ADR-036; default 30 days, `0` disables it — deployments
  where deletion is unacceptable, e.g. closed networks, can turn it off from
  the admin screen)
- Deletion atomically re-verifies the state with
  `UPDATE ... WHERE state = 'draft' AND <stale condition> RETURNING` before
  destructive work (same shape as the durable claim in ADR-028; a draft
  published moments earlier is never deleted by a race) and is recorded in
  the `audit_log`
- The drafts list shows the last-updated time and the scheduled deletion
  date, so users can anticipate the GC
- A draft occupies its name slug (same behavior as CKAN; accepted — the
  placeholder name is random, and user-chosen names are not squatted
  indefinitely thanks to the GC)

### Audit items (verify during implementation)

- Download / preview URLs (ADR-017): restrict draft resources to users with
  edit permission
- Confirm that the sitemap, the CKAN-compatible API, and the MCP tools
  (ADR-032) go through the active filter
- Organization / group dataset counts (already aggregated with
  `state = 'active'`, expected to be unaffected)

## Consequences

- Upload/save and publication are separated: users can assemble resources and
  review metadata before publishing
- Interruption and resumption work naturally (the draft persists in the DB)
- A file-first UX — writing metadata after looking at the file content —
  becomes possible, providing the foundation for AI metadata suggestions
  (planned follow-up ADR)
- Impact on existing deployments: all existing packages are `active` /
  `deleted`, so no data migration is needed. API clients must be prepared for
  the new state value `draft`, but public API responses are unchanged thanks
  to the default filter

## Related

- ADR-013: Separation of full-text search and DB filtering (foundation of
  draft invisibility)
- ADR-017: Server-proxied download / preview URLs (draft permission
  restriction)
- ADR-021: Resource content full-text search (draft skip in the Index step)
- ADR-028: Async organization purge with durable claim (precedent for a third
  state and transition guards)
- ADR-034: Metadata vector search (embedding enqueue at publication)
- ADR-036: Runtime system settings backed by the DB (`draft-retention-days`
  is an application of it)
