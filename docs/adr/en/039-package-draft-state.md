# ADR-039: Separating Creation from Publication with a Package Draft State

## Status

**Accepted**

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
  therefore never squat meaningful slugs. A previously set `name` can be
  reset by sending an explicit `null` to the update API, which regenerates
  a fresh placeholder and returns the draft to the "unnamed" state (the
  publish gate blocks it again)
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
- A `PUT` to a draft is a **partial update**: only the keys present in the
  request are applied (an explicit `null` still clears a field), so a
  partial save cannot wipe a draft's tags or extras. A `PUT` to an active
  package keeps the full-replacement semantics as before

### 2. Visibility

- Public listings and search go through the search index (ADR-013). Drafts
  are never indexed and are therefore automatically invisible
- Direct DB queries are invisible via the default `state = 'active'` filter
  (existing implementation, unchanged)
- The dashboard shows drafts to their creator (and, once `ownerOrg` is set,
  to that organization's editors — editor role or higher) as "drafts"
- **The worker's Index step (ADR-021) must check the package state and skip
  content indexing for drafts** (it currently does not look at state and
  needs fixing). Embeddings (ADR-034) are also not generated for drafts

### 3. Publication transition

- Add `POST /api/v1/packages/{id}/publish`. Only `draft` → `active` is
  allowed (same shape as the transition guards in ADR-028). Permission is
  identical to package update permission; in addition, when `ownerOrg` is
  set, editor rights in that organization are re-verified at publish time
  (a creator who has left the organization cannot publish in its name)
- Publish-time validation: in addition to `name` (no placeholder, §1) and
  `ownerOrg`, **`licenseId` must be set** (400 if missing). The web form has
  always required a license, so the invariant "datasets published through the
  UI always carry a license" is preserved on the draft publication path
- Synchronization performed at publication:
  1. Index the metadata into the search index
  2. Index the content of all active resources
  3. Enqueue the embedding job
- Re-publishing an already-published package is **allowed and re-runs the
  synchronization above (idempotent)**: if the publish-time search sync
  fails, re-issuing the same publish request serves as the retry
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
- **No automatic deletion (GC).** A TTL-based GC (a daily worker job with a
  `DRAFT_RETENTION_DAYS` retention period) was implemented and evaluated,
  but the product decision was that the anxiety of work-in-progress data
  disappearing automatically outweighs the benefit (storage savings), so it
  was removed. Abandoned drafts remain visible in the dashboard's drafts tab
  and are cleaned up by manual deletion; this will be revisited if storage
  growth becomes a problem
- Deletion atomically transitions the state with a **durable claim**
  (`UPDATE ... SET state='purging' WHERE state IN ('draft','purging') RETURNING`)
  before destructive work (applying the ADR-028 scheme to
  packages as well: a draft published moments earlier is never deleted by a
  race). If external-resource cleanup crashes partway and leaves the row
  `purging`, **re-running the DELETE re-claims it and completes the purge**.
  A row left `purging` stays visible in the drafts list flagged as
  "deletion incomplete" (not editable), so the user can retry the deletion
  from the list to recover it. As a result, package `state` also takes
  `purging` as a transient in-transition value
- A draft occupies its name slug until it is manually deleted (same behavior
  as CKAN; accepted — the placeholder name is random)

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
