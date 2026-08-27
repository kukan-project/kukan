> **Note**: This is a machine-translated version of the original Japanese implementation spec for reference purposes. The authoritative version is [`jp/phase-versioning-1-file-retention.md`](../jp/phase-versioning-1-file-retention.md).

# Phase Versioning-i: Canonical Version File Retention & Purge — Implementation Spec

> **Implementation complete (2026-07-25). This is a record.** After implementation, ADR-043 §1
> changed the relationship between versions and objects, and ADR-046 changed the order of the
> steps and who does the interpreting. A version is not a copy — it owns the object it was
> created from — and there is only one kind of key for the canonical copy (`resources/…`).
> For the current shape see `docs/pipeline.md`. The file paths, key shapes and step names below
> are the ones in use at the time.

> 🔴 **The semantics of purge have been replaced.** This document calls purge "**legal deletion**"
> throughout, but **that phrase is no longer used**. ADR-043 §5 and
> `phase-versioning-2-ducklake.md` §9 narrow the claim, and **all that is guaranteed is "making
> it immediately unfetchable from the product". That holds regardless of whether layer 2 exists.**
>
> **The behavior itself is as written here.** What disappears, and when:
>
> - **Version files are deleted** (layer 1). But **the bytes do not disappear on the spot** —
>   as in §8.3, noncurrent versions under S3 versioning remain until the lifecycle rule (30 days)
>   fires, and AWS Backup recovery points remain for the retention period
> - **Previews and the search index are discarded only when the target is the live version**
>   (§8.2). Purging an intermediate version leaves them alone — they represent the content
>   currently being served, and purging an intermediate version does not change that
> - **Rows can remain in layer 2 (DuckLake, added in Phase ii).** Because snapshots are
>   catalog-wide, history retained for another resource can hold on to the same file.
>   **There is no deadline on this side**
>
> In other words, there is no configuration in which we can say "erased completely".
> **All we can say is that it has been made unfetchable. Physical disappearance in layer 1
> follows the storage/backup retention periods, and physical disappearance in layer 2 is not
> guaranteed.**

> **Goal**: Retain the canonical data of a resource immutably as versions (all formats), and
> implement listing/fetching/downloading versions plus purging of past versions by a sysadmin.
> Build the minimal versioning foundation that can be released on its own, with no dependency on
> DuckLake (row-level diffs). ADR-043 is authoritative for the design decisions.

## 1. Prerequisites

- Phase 3 complete (upload + Fetch → Extract → Index pipeline + Worker + Queue)
- ADR-043 agreed (proposed → layer 1 settled by this spec)
- Current state of storage and DB:
  - The canonical file is saved by **overwriting** the fixed key
    `resources/{packageId}/{resourceId}` (`getStorageKey()`)
  - Uploads are written once to the current key via presigned PUT; no old version survives
  - For external URLs the Fetch step downloads to the current key and updates `resource.hash` /
    `size` only when `hash !== res.hash`
    ([fetch.ts](../../../apps/worker/src/pipeline/steps/fetch.ts), the existing hash gate)
  - The `resource` table has `hash` (`sha256:...`) / `size` / `urlType` (`upload` | external) /
    `state`
  - `resource_pipeline` (1:1 with resource) has `previewKey` / `metadata.schema`
    (latest version only, ADR-032)
  - The `audit_log` table exists (`entityType` / `entityId` / `action` / `userId` / `changes`)
  - The StorageAdapter has **no** `copy`
    (`upload` / `download` / `delete` / `head` / `downloadRange` / `deleteByPrefix` / presigned)

## 2. Implementation Refinements on Top of ADR-043

ADR §1-2, "on upload, write to both the current key and the version key", **cannot be realized
as written** because a presigned PUT can only write once, to the current key. Instead we take the
following approach (settled by this spec).

- **Versions are captured not at upload time but in the "Version step" of the Worker pipeline.**
  After the hash is settled by Fetch, the contents of the current key are **server-side copied**
  to the version key.
- This unifies both the upload and external-URL paths on the Worker side, and lets us reuse the
  existing hash gate in fetch.ts as the trigger for a version.
- **How immutability is guaranteed**: the copy of version vN is made during the pipeline run for
  vN (i.e. while the current key still holds vN's content). Even if a later v(N+1) upload
  overwrites the current key, the already-created `versions/.../vN` object is unaffected.
- **Known limitation**: versions are captured at the moment the pipeline runs. If the same
  resource is uploaded to repeatedly before pipeline processing, intermediate versions may not be
  captured (accepted; stated in the completion criteria).

## 3. Architecture Overview

```
Layer 1 (this spec): canonical version files (all formats)
  current key   resources/{packageId}/{resourceId}         ← latest version (existing path unchanged)
  version key   versions/{packageId}/{resourceId}/v{n}     ← immutable copy
  ledger        resource_version table

  === capturing a version (Worker) ===
  [upload-complete / external URL] → Queue → processResource
    Fetch    settle at the current key (compute the hash)
    Version  ← new. If the hash differs from the latest version, copy current key → version key + add resource_version
    Extract  generate Parquet/schema (latest version, existing)
    Index    feed content search (existing)

  === referencing versions (API) ===
  GET  /resources/:id/versions              version list (visibility check)
  GET  /resources/:id/versions/:v           version metadata
  GET  /resources/:id/versions/:v/download  version download (via the server, following ADR-017)

  === purge (API + Worker) ===
  POST /resources/:id/versions/:v/purge     sysadmin only, reason required
    → resource_version.state: active → purging → purged (asynchronous, the ADR-028 pattern)
    → delete the version file + propagate to derivatives (complete within layer 1; layer 2 comes in Phase ii)
```

## 4. Step 1: DB Schema — `resource_version`

Add `packages/db/src/schema/resource-version.ts`.

```typescript
export const resourceVersion = pgTable(
  'resource_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    resourceId: uuid('resource_id')
      .notNull()
      .references(() => resource.id, { onDelete: 'cascade' }),
    // Sequential per resource, assigned at capture time (max+1).
    version: integer('version').notNull(),
    storageKey: text('storage_key').notNull(), // versions/{pkg}/{res}/v{n}
    size: bigint('size', { mode: 'number' }),
    hash: text('hash'), // sha256:...
    // 'upload' = explicit replacement, 'fetch' = observed at fetch time (external URL).
    origin: varchar('origin', { length: 10 }).notNull(),
    // active → purging → purged (ADR-028 durable-claim pattern).
    state: varchar('state', { length: 10 }).notNull().default('active'),
    // Column schema snapshot for this version (ADR-032 shape), best-effort.
    // Null for non-tabular formats or when Extract produced none.
    schema: jsonb('schema').$type<ResourceSchema | null>(),
    // Purge audit trail (kept on the tombstone row).
    purgedAt: timestamp('purged_at', { withTimezone: true }),
    purgedBy: text('purged_by').references(() => user.id),
    purgeReason: text('purge_reason'),
    createdBy: text('created_by').references(() => user.id),
    created: timestamp('created', { withTimezone: true }).defaultNow().notNull(),
    updated: timestamp('updated', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_resource_version_res_ver').on(table.resourceId, table.version),
    index('idx_resource_version_state').on(table.state),
  ]
)
```

- The FK to `resource` is `onDelete: 'cascade'` (deleting the resource removes the version ledger
  too). However **the version files themselves (S3) and DuckLake are not removed by the cascade** →
  they are cleaned up explicitly on the resource purge side (open issue, handled by the resource
  purge extension in Phase ii. In this phase resource delete is a logical delete, so version files
  stay).
- `ResourceSchema` reuses the existing Zod type in `@kukan/shared` (ADR-032).
- Migrations via Drizzle Kit (`pnpm db:generate`). This only adds the DB schema; the migration
  does not automatically create version records (migrate) for existing resources.

### 4.1 Migrating existing resources (assigning v1)

The Version step captures the current content as **v1** when the pipeline runs for a resource that
has no versions yet. Migration of existing resources therefore **adds no dedicated code: running
"reindex including content" from the admin screen
(`POST /admin/reindex-metadata { includeContent: true }`) reprocesses every resource and issues v1
in bulk** (`enqueueAll()` feeds all active resources into the pipeline). Migration happens once at
introduction; from then on new creations and replacements get versions automatically.

Caveats (to state explicitly in the administrator documentation):

- **External URL resources involve a re-fetch** (rate-limited per FQDN). Whatever content is
  retrieved becomes v1 with `origin: fetch`. If the upstream is down at reprocess time, no v1 is
  created.
- Because this operation clears the content search index and rebuilds it (existing behavior),
  full-text search is temporarily degraded while it runs.
- For uploaded resources Fetch is skipped and the current key's content becomes v1 as-is
  (no re-fetch).
- A lighter migration (copy + row insert for uploads only, without running the pipeline) is not
  adopted because it is hard for ordinary users to operate. We consolidate on the existing admin
  feature.

## 5. Step 2: Add `copy` to the StorageAdapter

Add a server-side copy (S3 CopyObject / the MinIO equivalent) so the Worker can create version
keys without streaming bytes.

```typescript
// packages/adapters/storage/src/adapter.ts
export interface StorageAdapter {
  // ...existing...
  /** Server-side copy within the same bucket (no data streamed through the app). */
  copy(sourceKey: string, destKey: string): Promise<void>
}
```

- S3 implementation: `CopyObjectCommand` (`CopySource = bucket/sourceKey`).
- MinIO uses the same implementation via S3-compatible `CopyObject`.
- Add a version-key helper to `@kukan/shared`:
  ```typescript
  export function getVersionKey(packageId: string, resourceId: string, version: number): string {
    return `versions/${packageId}/${resourceId}/v${version}`
  }
  ```

## 6. Step 3: The Version Step (Worker)

Add `apps/worker/src/pipeline/steps/version.ts` and insert it **after Extract** in
`processResource` (it runs after Extract completes so the schema snapshot can be attached to the
version).

### 6.1 Logic

```
executeVersion(resourceId, packageId, currentStorageKey, schema, ctx):
  res = ctx.getResource(resourceId)                    // latest hash/size/urlType (after Fetch settles)
  if !res or !res.hash: return { captured: false }     // no hash → cannot make a version
  { maxVersion, latestActiveHash } = ctx.getVersionCaptureInfo(resourceId)
  if latestActiveHash === res.hash:
    return { captured: false }                          // content unchanged → do not create a version
  next = (maxVersion ?? 0) + 1
  versionKey = getVersionKey(packageId, resourceId, next)
  await ctx.storage.copy(currentStorageKey, versionKey)   // immutable copy
  await ctx.insertResourceVersion({
    resourceId, version: next, storageKey: versionKey,
    size: res.size, hash: res.hash,
    origin: res.urlType === 'upload' ? 'upload' : 'fetch',
    schema: schema ?? null,
  })
  return { captured: true, version: next }
```

- **Numbering and gating are separate** (for consistency with purge/rollback; settled during
  implementation):
  - **Numbering** `next = maxVersion + 1` is based on the **maximum version across all states**
    (including purged tombstones). Purged rows stay in the ledger, so numbering from the
    non-purged rows only would collide with the unique `(resource_id, version)`.
  - **The change gate** is decided on **the hash of the latest active version** (not the maximum
    version). This is so that when a rollback after purging the latest version restores the
    previous version's content to the current key, the regeneration pipeline **does not version
    the same content again**. Even with a purged tombstone at the top, the gate is decided on the
    active version just below it.
- **origin**: `urlType === 'upload'` → `'upload'`, otherwise (external URL) → `'fetch'`.
- **schema**: the column schema returned by Extract (non-null only for CSV/TSV) is attached to the
  version as-is.
- `createdBy` is null because this is a pipeline run (queue-triggered, actor unknown).
- The Version step is treated as **non-critical** (like Extract/Index). Failures are recorded on
  the step but the pipeline as a whole continues (serving the latest version still works even if a
  version cannot be created).
- `createdBy` (the user who caused the version) is set only when an actor can be passed into the
  pipeline context. It is null when the actor is unknown, e.g. a scheduled re-fetch of an external
  URL.

### 6.2 Wiring into process-resource.ts

After `extractResult` (`previewKey` / `schema`) is settled and before the Index step, add the
Version step. Register a `'version'` step with `StepTracker` and record
`startStep` / `completeStep` / `skipStep` as with the existing steps.

## 7. Step 4: Version Reference API

Added to `packages/api/src/routes/resources.ts`. The service is `ResourceVersionService` (new).

| Method and path                           | Permission                                 | Content                                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /resources/:id/versions`             | resource visibility (same path as ADR-017) | Versions with `state != purged`, newest first. Purged versions are returned **as tombstones with only version/timestamp/reason** (no content, no download) |
| `GET /resources/:id/versions/:v`          | same                                       | Metadata for a single version (size/hash/origin/schema/created/state)                                                                                      |
| `GET /resources/:id/versions/:v/download` | same                                       | Streams the version key via the server (reusing the ADR-017 download implementation with the version key)                                                  |

- The visibility check goes through the existing `getByIdWithAccessCheck` (same as ADR-017/032).
- Downloading a purged version is 410 Gone (`type` / `title` per RFC 9457).
- The version list response includes `origin` so the frontend can make "a snapshot at fetch time"
  (fetch) explicit.

## 8. Step 5: Purge

### 8.1 API

```
POST /resources/:id/versions/:v/purge
  body: { reason: string }   // required, Zod validated (min length)
```

- **Permission is sysadmin only** (`user.sysadmin`). Editor rights are not enough.
- `reason` is required. Recorded in the audit log.
- Idempotent: if already `purged` / `purging`, return the current state (no double execution).
- Response: `202 Accepted` (asynchronous processing) plus the current version state.

### 8.2 State transitions (following the ADR-028 durable-claim pattern)

```
active → purging → purged
```

1. The API updates `active → purging` (the durable claim. `purgedBy` / `purgeReason` are recorded
   on the row at this point too. Audit log `action='purge_request'`)
2. A Worker job (new queue job `PURGE_VERSION_JOB_TYPE = 'purge-resource-version'`) performs the
   propagation:
   - **Layer 1**: delete the version file `versions/.../v{n}` from storage
   - **Handling the latest (live) version — roll back to the previous version** (the settled
     behavior of this phase):
     If the purge target is the **live version** (no active version above it), deleting the version
     file alone leaves the same content at the current key `resources/.../`, still being served.
     So:
     1. **Copy the previous active version** (the largest active row with a smaller version) to the
        current key, **rolling the content back**. Update `resource.hash` / `size` to the values of
        the rollback target
     2. **Invalidate the derivatives** (preview Parquet and OpenSearch content) immediately (delete
        and clear the `previewKey` object, `deleteContent`). This is so purged content is not kept
        in circulation
     3. Re-enqueue the pipeline and regenerate the preview and search index from the rolled-back
        content. The Version step's change gate detects "latest active version hash = rollback
        target" and **does not create a new version**
     - **When there is nothing to roll back to** (e.g. all past versions are purged too), the
       current key and the derivatives are deleted too, leaving the resource in a **contentless
       state** (`resource.hash` / `size` become null)
   - **Purging a past (non-live) version**: unrelated to the current key. Only the version file is
     deleted; no rollback and no derivative handling
   - **Layer 2 (DuckLake)**: out of scope for this phase (compaction rewrite is added in Phase ii)
3. After all propagation completes, `purging → purged`. `purgedAt` is settled and the audit log
   records `action='purge'` (with version, reason and rolledBack in `changes`).
   **The ledger row is kept (a tombstone).**

### 8.3 Physical-disappearance timeline (stated explicitly as spec)

- Running a purge makes it **immediately invisible** from the application layer (all roles: the
  version file is deleted and purged downloads return 410).
- AWS: noncurrent versions under S3 versioning expire automatically via the lifecycle rule
  (30 days, ADR-037). AWS Backup recovery points disappear when the retention period ends →
  state **"physical disappearance at most 30 days after purge plus the backup retention period"**
  in the purge UI and documentation.
- During the retention window there is no code path in the application to the noncurrent versions,
  and they are unreachable from any KUKAN role (only AWS IAM holders can reach them).
- On-premises (MinIO, versioning not configured) deletion is immediate. No retention problem.

## 9. Step 6: Web UI (`apps/web`)

- Add a **version history** section to the resource detail page (dashboard side, editor view):
  version number, created timestamp, size, origin (upload / fetch), download link.
- Sysadmins get a **purge button** on each version (a reason-entry modal + a note about the
  physical-disappearance timeline + confirmation).
- The public resource detail page (for viewers) **does not show version history** in this phase
  (presenting a diff summary is Phase ii/iii; viewer-facing exposure is designed there).
  - **Addendum (implemented after ii-b)**: a viewer-facing version history (list +
    per-version download) was added to the public resource detail page. It is a
    collapsible section fetched on first open, showing the latest 10 versions by
    default with a "show all" control. Deleted versions appear as tombstones
    (deleted badge + created timestamp). The API keeps its visibility-only check,
    with `publicCache()` applied to the anonymous response (ADR-026). **Public
    diffs remain Phase iii** (diagnostics and purge stay dashboard-only).
- i18n: add version-history and purge labels in ja/en.

## 10. Test Strategy

- **Unit**:
  - The Version step's hash gate (same hash → no version, difference → version increments, origin
    determination)
  - `getVersionKey` / StorageAdapter `copy` (mocked)
  - Purge state transitions (active→purging→purged, idempotency, no double execution)
- **Integration** (test DB + MinIO):
  - upload → pipeline → v1 is created in resource_version
  - content replaced → v2 created, v1's version file remains unchanged
  - re-fetching identical content → no new version
  - version download returns the content of the version key
  - purge: version file deleted, tombstone remains, purged download 410, audit log recorded
  - purge by a non-sysadmin is rejected (403)
- **E2E** (Playwright, optional): version history display + the sysadmin purge flow.

## 11. Implementation Order

1. Step 1: `resource_version` schema + migration
2. Step 2: StorageAdapter `copy` + `getVersionKey`
3. Step 3: Version step (Worker) + wiring into process-resource + StepTracker extension
4. Step 4: Version reference API + `ResourceVersionService`
5. Step 5: Purge API + Worker job + new queue job type
6. Step 6: Web UI + i18n
7. Tests

## 12. Completion Criteria

- For both upload and external URL, a pipeline run creates a version in `resource_version`
- Replacement increments the version and the old version file remains immutable (unaffected by
  overwriting the current key)
- Reprocessing with the same hash does not add a version
- Version list / fetch / download work including the visibility check
- A sysadmin purge removes the version file, leaves a tombstone row + audit log, and blocks
  further downloads
- Non-sysadmins cannot purge
- The existing download, preview and pipeline paths work unchanged (backwards compatible)
- **Known limitation** (accepted): repeated uploads before pipeline processing may not capture
  intermediate versions

## 13. Out of Scope (later phases)

- **Phase ii (DuckLake)**: layer-2 ingest for tabular resources, the row-level diff API
  (three-stage fallback), the admin-facing diff summary, layer-2 propagation of purge
  (compaction rewrite)
- **Phase iii**: viewer-facing "changes from the previous version" UI, version-pinned queries,
  DuckLake export integration for preview Parquet, an MCP version-diff tool
- Runtime configuration of the number of retained generations (ADR-036), explicit IAM Deny
  (ADR-043 open issue 7), and scheduled re-fetching of external URLs (riding along with the
  quality package) are added when they become necessary
