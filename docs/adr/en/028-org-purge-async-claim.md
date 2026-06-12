> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/028-org-purge-async-claim.md`](../jp/028-org-purge-async-claim.md).

# ADR-028: Asynchronous Organization Purge with a Durable Claim

## Status

**Accepted**

## Context

Organizations are soft-deleted (`state` = `active` / `deleted`). Permanently
deleting (purging) one from the trash must cascade to its packages **and** their
external resources — OpenSearch documents and S3 objects (raw files + previews).

`organization → package` is a one-to-many ownership (`package.owner_org` FK, no
cascade), so the packages must be deleted **before** the org row or the delete hits
an FK violation. A single org can own thousands of packages, which surfaced several
problems.

### Problems with the original (synchronous) purge

1. **Bulk deletion inside an HTTP request times out**
   - Deleting thousands of package rows plus cleaning their external resources in one
     request can exceed the ALB idle timeout (default 60s).

2. **"Commit the DB delete, then enqueue the cleanup job" splits the trust boundary**
   - If the SQS enqueue fails after the DB rows are gone, the org is already deleted
     (no retry possible) and the package IDs needed for external cleanup are lost —
     OpenSearch docs and S3 files leak permanently (deleted content can linger in search).

3. **Restore race during purge (TOCTOU)**
   - If a sysadmin restores the org, or an org admin restores a child package, after
     the external files are already gone, the restored entity is destroyed by the
     subsequent bulk DB delete while its files no longer exist (data loss). A "final
     state re-check" alone is insufficient: a late restore can still happen after the
     external files were deleted.

## Decision

**Move the destructive work into a worker job, and durably claim the org at the start.**

### 1. The route only validates and enqueues (`requestPurge`)

- `POST /organizations/:id/purge` checks the precondition (no active packages) and
  enqueues a `purge-organization` job. The org stays `deleted`.
- The destructive work and its trigger share one trust boundary, so a failed enqueue
  leaves the org fully intact and the user can simply retry (no delete-then-enqueue leak).

### 2. The worker performs the destruction (`OrganizationService.purgeDeletedOrg`)

The worker calls the API service layer directly (same shape as the `reindex` job;
`OrganizationService` is imported from `@kukan/api`). Order of operations:

1. **Durable claim**: `UPDATE organization SET state='purging' WHERE id=? AND state IN ('deleted','purging') RETURNING id`. No row returned → no-op (restored, already purged, or never deleted).
2. Fetch the child package IDs.
3. Clean external resources (OpenSearch + S3) with **bounded concurrency** (`purgePackageExternals`).
4. Delete all packages + the org row in a DB transaction.

### 3. How the claim closes the race

- `restore` (org) only un-deletes from **`state='deleted'`** → a `purging` org can't be restored.
- `PackageService.create` / `restore` require the **owner org to be `active`** → no package
  can be created under a `purging` org, and deleted packages can't be individually restored.
- So once claimed, the package set is frozen and a restored entity can never reappear after
  its files were deleted. The key is that the claim happens **before** any external deletion.

### 4. Idempotency and retry (fail-fast)

- External cleanup uses `Promise.all` (not `allSettled`): a single failure throws before the
  DB delete, leaving the org `purging` to be redelivered after the SQS visibility timeout.
- A retry re-claims its own `purging` org and proceeds (idempotent); external cleanup is itself
  idempotent.
- The irreversible DB delete is the **last** step, so any mid-run failure converges to "still
  `purging`, safe to retry."

### State model

`state` is `varchar(20)`; `purging` is stored as an additional value (**no migration**).
It is transient — `list()` / `getByNameOrId` only target `active` / `deleted`, so it never
appears in listings, fetches, or the UI; after purge the org row is gone entirely. A dedicated
column (`purging_at`, etc.) was considered but rejected to keep the single-`state`-column
lifecycle model intact.

## Alternatives considered

| Alternative                            | Why rejected                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| Synchronous purge inside the request   | ALB timeout for large orgs; delete-then-enqueue splits the trust boundary     |
| Final state re-check after DB delete   | External files are already gone, so a late restore still leaves inconsistency |
| Transactional outbox (dedicated table) | Putting the destructive work in the worker already gives "failed enqueue =    |
|                                        | org intact" without an extra table + relay (related to ADR-022)               |
| Dedicated `purging` column / boolean   | Adds schema and a second field to branch on; reusing `state` suffices         |

## Impact

- Changed: `packages/api/src/services/organization-service.ts` (`requestPurge` / `purgeDeletedOrg` / `restore` guard)
- Changed: `packages/api/src/services/package-service.ts` (`assertOwnerOrgActive` unifies create/update/restore)
- Changed: `apps/worker/src/index.ts` (`purge-organization` handler), `packages/shared/src/pipeline-types.ts` (`PURGE_ORG_JOB_TYPE` + payload schema)
- New: `packages/api/src/services/package-cleanup.ts` (`purgePackageExternals`: shared search + storage cleanup helper)
- Groups do **not** own packages (many-to-many; purge only detaches, packages survive), so this claim mechanism is unnecessary for them. Group purge is a single atomic statement.
- Search facets count only active packages, and an active package can never live under a `purging` org, so a `purging` org never leaks into facet buckets.

## Related

- ADR-022 (DB polling as an SQS alternative): `docs/adr/en/022-db-polling-queue.md`
- Implementation: `packages/api/src/services/organization-service.ts`, `apps/worker/src/index.ts`
