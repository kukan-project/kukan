> **Note**: This is a machine-translated version of the original Japanese implementation spec for reference purposes. The authoritative version is [`jp/phase3-pipeline.md`](../jp/phase3-pipeline.md).

# Phase 3a: Resource Processing & File Storage — Implementation Spec

> **This is a record of a completed phase.** Later ADRs have changed parts of the implementation,
> so for the current shape see the phase list in `CLAUDE.md` and `docs/pipeline.md`. The file paths
> and step names below are the ones in use at the time.

> **Goal**: Implement file upload (presigned URL), the resource processing pipeline (CSV/TSV +
> external URL support) and OpenSearch search, reaching a state where everything works end to end
> in the development environment (Docker Compose + ElasticMQ + MinIO)

## 1. Prerequisites

- The Phase 1 API is complete (CRUD + CKAN compatibility + search + authentication)
- The Phase 2 frontend is complete (Next.js 16 catalog UI + admin screens)
- The `urlType` column is defined on the `resource` table
- The StorageAdapter / QueueAdapter / SearchAdapter interfaces are defined
- S3StorageAdapter (MinIO / AWS S3 unified), SqsQueueAdapter (SQS / ElasticMQ) and
  PostgresSearchAdapter are implemented
- Docker Compose: PostgreSQL 16 + MinIO already run

### Phase 3a vs Phase 3b

| Item    | Phase 3a (this spec)                    | Phase 3b (separate)              |
| ------- | --------------------------------------- | -------------------------------- |
| Scope   | End-to-end in the dev environment       | AWS production infrastructure    |
| Storage | S3StorageAdapter (connected to MinIO)   | Same adapter (connected to S3)   |
| Queue   | SqsQueueAdapter (ElasticMQ)             | SqsQueueAdapter (AWS SQS)        |
| Search  | OpenSearch (Docker)                     | AWS OpenSearch Service           |
| Formats | CSV/TSV (preview), PDF (iframe display) | Excel and others added gradually |
| AI      | Implemented in Phase 5                  | Implemented in Phase 5           |

## 2. Technology Stack (additions for Phase 3a)

| Category           | Technology                            | Notes                                      |
| ------------------ | ------------------------------------- | ------------------------------------------ |
| Search engine      | OpenSearch 3.x                        | Docker Compose (profiles: search)          |
| Search client      | @opensearch-project/opensearch ^3.0.0 | Already installed                          |
| Japanese analysis  | kuromoji plugin                       | Bundled with OpenSearch 3.x by default     |
| CSV parsing        | PapaParse 5.x                         | Already installed (used by PreviewService) |
| Encoding detection | encoding-japanese 2.x                 | Already installed (used by PreviewService) |

## 3. Architecture Overview

### Processing flow

```
[browser]
  │
  ├─ POST /api/v1/packages/:packageId/resources
  │    → create the resource record
  │    ← { id, ... }
  │
  │  === presigned URL flow (file upload) ===
  │
  ├─ POST /api/v1/resources/:id/upload-url
  │    → prepareForUpload (updates urlType='upload') + issue a presigned PUT URL
  │    ← { upload_url }
  │
  ├─ PUT upload_url  ──→  [S3 / MinIO]
  │    → upload the file directly
  │
  ├─ POST /api/v1/resources/:id/upload-complete
  │    → update size/hash → create resource_pipeline → enqueue
  │    ← { pipeline_status: 'queued', job_id }
  │
  │  === server-side upload ===
  │
  ├─ POST /api/v1/resources/:id/upload  (multipart)
  │    → prepareForUpload + write to Storage → create resource_pipeline → enqueue
  │    ← { pipeline_status: 'queued', job_id }
  │
  │  === external URL resources ===
  │
  ├─ POST /api/v1/packages/:packageId/resources  { url: "https://..." }
  │  or PUT /api/v1/resources/:id                 { url: "https://..." } (when the URL changes)
  │    → create/update the resource → create resource_pipeline → enqueue
  │    * the pipeline downloads from the external URL (100MB limit)
  │
  │  ┌─────── SQS / ElasticMQ ──────────┐
  │  │ processResource(resourceId)              │
  │  │  1. Fetch    (retrieve the file)         │
  │  │  2. Extract  (parse CSV/TSV → Parquet)   │
  │  │  3. Index    (update OpenSearch)         │
  │  └────────────────────────────────────────┘
  │
  ├─ GET /api/v1/resources/:id/pipeline-status
  │    ← { status: 'complete', steps: [...] }
  │
  └─ GET /api/v1/resources/:id/preview
       ← Parquet (supports range reads)
```

## 4. Step 2: Docker Compose + OpenSearchAdapter ✅

### 4.1 Docker Compose additions

Add the following to `docker/compose.yml`:

```yaml
opensearch:
  image: opensearchproject/opensearch:3
  container_name: kukan-opensearch
  profiles: ['search']
  environment:
    - discovery.type=single-node
    - plugins.security.disabled=true
    - OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m
  ports:
    - '9200:9200'
  volumes:
    - opensearch-data:/usr/share/opensearch/data
  healthcheck:
    test: ['CMD-SHELL', 'curl -s http://localhost:9200 || exit 1']
    interval: 10s
    timeout: 5s
    retries: 5

opensearch-dashboards:
  image: opensearchproject/opensearch-dashboards:3
  container_name: kukan-opensearch-dashboards
  profiles: ['search']
  ports:
    - '5601:5601'
  environment:
    - OPENSEARCH_HOSTS=["http://opensearch:9200"]
    - DISABLE_SECURITY_DASHBOARDS_PLUGIN=true
  depends_on:
    opensearch:
      condition: service_healthy
```

Start with: `docker compose --profile search up -d`

### 4.2 OpenSearchAdapter

`packages/adapters/search/src/opensearch.ts` (stub → real implementation)

```typescript
export class OpenSearchAdapter implements SearchAdapter {
  constructor(config: OpenSearchConfig)
  async ensureIndex(): Promise<void> // create the index with the kuromoji mapping
  async index(doc: DatasetDoc): Promise<void>
  async search(query: SearchQuery): Promise<SearchResult>
  async delete(id: string): Promise<void>
  async bulkIndex(docs: DatasetDoc[]): Promise<void>
}
```

**Index mapping**:

- `title`: kuromoji_analyzer + a keyword subfield
- `notes`: kuromoji_analyzer
- `name`, `tags`, `organization`: keyword
- `resources`: nested type (for searching resource metadata)
  - `resources.name`: kuromoji_analyzer + a keyword subfield
  - `resources.description`: kuromoji_analyzer
  - `resources.id`: keyword
  - `resources.format`: keyword
- `created`, `updated`: date

**Search query**:

- `bool.should` combining a dataset-level `multi_match` (`title^3`, `name^2`, `notes`, `tags`) with
  a nested resource `multi_match` (`resources.name^2`, `resources.description`)
- The nested query returns matched resources via
  `inner_hits: { size: MAX_MATCHED_RESOURCES_PER_PACKAGE }`
- `bool.filter` for organization and tags (no effect on scoring, per ADR-013)

**Resource metadata search (already implemented in Step 2b)**:

- PostgresSearchAdapter: ILIKE search on resource.name/description via an EXISTS subquery
- PackageService.list(): the same EXISTS subquery plus a batched fetch of `matchedResources` when
  the `q` parameter is present
- pg_trgm GIN indexes added to `resource.name` and `resource.description` as well
- Upper bound of matched resources per package: `MAX_MATCHED_RESOURCES_PER_PACKAGE`
  (1000, defined in `@kukan/shared`)
- The frontend DatasetCard shows matched resources as indented sub-items

### 4.3 Adapter factory update

- `createAdapters()` becomes **async** (so it can call `ensureIndex()`)
- `packages/api/src/app.ts`: `await createAdapters(env, db)`

## 5. Step 3: File Upload API ✅

### 5.1 StorageAdapter extension

`getSignedUploadUrl` added to `adapter.ts` (implemented):

```typescript
export interface SignedUrlOptions {
  expiresIn?: number
  inline?: boolean // Content-Disposition: inline (PDF preview etc.)
  contentType?: string // sets the response Content-Type
  filename?: string // Content-Disposition: attachment; filename="..." (for downloads)
}

export interface StorageAdapter {
  upload(key: string, body: Buffer | Readable, meta?: ObjectMeta): Promise<void>
  download(key: string): Promise<Readable>
  delete(key: string): Promise<void>
  getSignedUrl(key: string, options?: SignedUrlOptions): Promise<string>
  getSignedUploadUrl(
    key: string,
    contentType: string,
    expiresIn?: number,
    meta?: ObjectMeta
  ): Promise<string>
}
```

| Implementation      | Approach                                                              |
| ------------------- | --------------------------------------------------------------------- |
| S3StorageAdapter    | `getSignedUrl(PutObjectCommand)` from `@aws-sdk/s3-request-presigner` |
| LocalStorageAdapter | A `local://{key}` sentinel URL                                        |

\* The old `MinIOStorageAdapter` (the minio package) and `S3StorageAdapter` have been consolidated
into `S3StorageAdapter` (based on `@aws-sdk/client-s3`). `STORAGE_TYPE` takes two values,
`'s3' | 'local'`. Whether `S3_ENDPOINT` is set decides MinIO vs AWS S3 automatically.

### 5.2 API endpoints

| Method | Path                                    | Auth        | Summary                                                                            |
| ------ | --------------------------------------- | ----------- | ---------------------------------------------------------------------------------- |
| POST   | `/api/v1/resources/:id/upload-url`      | org editor+ | Issue a presigned URL (same for new and replacement)                               |
| POST   | `/api/v1/resources/:id/upload-complete` | org editor+ | Upload completion notice → enqueue                                                 |
| POST   | `/api/v1/resources/:id/upload`          | org editor+ | Server-side upload (same for new and replacement)                                  |
| GET    | `/api/v1/resources/:id/pipeline-status` | public      | Get the processing state                                                           |
| GET    | `/api/v1/resources/:id/download-url`    | public      | Download URL (external URLs as-is; uploads get presigned + attachment disposition) |
| GET    | `/api/v1/resources/:id/preview-url`     | public      | Get the preview URL (see ADR-015)                                                  |
| GET    | `/api/v1/resources/:id/text`            | public      | Text preview (a stream with a charset header)                                      |
| POST   | `/api/v1/resources/:id/run-pipeline`    | org editor+ | Manually re-run the pipeline                                                       |
| GET    | `/api/v1/resources/formats`             | public      | List the registered formats                                                        |

### 5.3 Storage key convention

```
resources/{package_id}/{resource_id}
previews/{package_id}/{resource_id}.parquet
```

### 5.4 ResourceService extension (implemented)

```typescript
class ResourceService {
  // ... existing methods ...

  /** Sets urlType='upload'. The format is inferred from the filename extension */
  async prepareForUpload(
    id: string,
    input: { filename: string; contentType: string; format?: string },
    existing?: Resource
  ): Promise<Resource>

  /** Updates the size / hash metadata after an upload completes */
  async updateAfterUpload(id: string, input: { size?: number; hash?: string }): Promise<Resource>
}

/** storageKey is not a DB column; it is computed each time */
function getStorageKey(packageId: string, resourceId: string): string {
  return `resources/${packageId}/${resourceId}`
}
```

### 5.5 Shared types

```typescript
// packages/shared/src/adapter-types.ts
export type PipelineStatus = 'pending' | 'queued' | 'processing' | 'complete' | 'error'
```

## 6. Step 4: DB Schema Change + Resource Processing Pipeline

### 6.1 DB schema change

#### Separating processing-related fields out of the resource table

The `resource` table is limited to the **metadata only** of a resource, and processing state moves
to a dedicated table. This makes `resource.updated` reflect only user actions (renames, URL
changes and so on), unaffected by pipeline processing.

**Columns removed from the resource table**:

- `preview_key`
- `ingest_status`
- `ingest_error`
- `ingest_metadata`
- `ai_schema`
- `pii_check`
- `content_hash`
- `health_status` (kept. To be revisited when the Quality Monitor is implemented)
- `health_checked_at` (same)
- `quality_issues` (same)

**New table: `resource_pipeline`** (1:1 with resource)

```sql
CREATE TABLE resource_pipeline (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id   UUID NOT NULL UNIQUE REFERENCES resource(id) ON DELETE CASCADE,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending',
  error         TEXT,
  preview_key   TEXT,
  metadata      JSONB,
  created       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_resource_pipeline_resource_id ON resource_pipeline(resource_id);
CREATE INDEX idx_resource_pipeline_status ON resource_pipeline(status);
```

**New table: `resource_pipeline_step`** (N:1 with resource_pipeline)

```sql
CREATE TABLE resource_pipeline_step (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id   UUID NOT NULL REFERENCES resource_pipeline(id) ON DELETE CASCADE,
  step_name       VARCHAR(50) NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  error           TEXT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_pipeline_step_pipeline_id ON resource_pipeline_step(pipeline_id);
```

**Status values**:

- `resource_pipeline.status`: `'pending'` | `'queued'` | `'processing'` | `'complete'` | `'error'`
- `resource_pipeline_step.status`: `'pending'` | `'running'` | `'complete'` | `'error'` | `'skipped'`

#### ResourceService changes

- `updateIngestStatus()` → removed. Moved to `PipelineService` / `StepTracker`
- `prepareForUpload()` → no longer sets `ingestStatus` / `ingestError` (processing state lives in
  resource_pipeline)

### 6.2 Pipeline triggers

| Event                        | urlType    | Behavior                             |
| ---------------------------- | ---------- | ------------------------------------ |
| `upload-complete` API        | `'upload'` | Create `resource_pipeline` → enqueue |
| `upload` API (multipart)     | `'upload'` | Same                                 |
| Resource creation (with url) | `null`     | Create `resource_pipeline` → enqueue |
| Resource update (url change) | `null`     | Reset `resource_pipeline` → enqueue  |

### 6.3 Structure

The pipeline has been split out of the `packages/pipeline` package. Responsibilities are divided
between the API side (enqueue/status) and the Worker side (execution logic).

```
packages/api/src/services/
└── pipeline-service.ts     # PipelineService (enqueue, getStatus)

apps/worker/src/pipeline/
├── process-resource.ts     # pipeline orchestrator
├── step-tracker.ts         # StepTracker (step state management)
├── build-context.ts        # assembles the PipelineContext
├── types.ts                # PipelineContext, ResourceForPipeline
├── node-utils.ts           # encoding detection, buffer utilities
└── steps/
    ├── fetch.ts            # file retrieval (Storage or external URL)
    └── extract.ts          # encoding detection + CSV/TSV → Parquet generation
```

### 6.4 PipelineContext

`PipelineContext` provides the adapters and DB accessor methods. Rather than exposing the DB
directly, the queries the pipeline needs are defined as accessor functions.

```typescript
interface PipelineContext {
  storage: {
    download(key: string): Promise<Readable>
    upload(key: string, body: Buffer | Readable, meta?: Record<string, unknown>): Promise<void>
  }
  getResource(id: string): Promise<ResourceForPipeline | null>
  updateResourceHashAndSize(id: string, meta: { hash: string; size: number }): Promise<void>
}
```

The `PipelineContext` is assembled by `buildPipelineContext()` in
`apps/worker/src/pipeline/build-context.ts`. The accessors are implemented directly as Drizzle ORM
queries.

### 6.5 Pipeline steps

| Step | Name        | Input                                     | Output                        | Notes                                                                                      |
| ---- | ----------- | ----------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------ |
| 1    | **Fetch**   | resourceId                                | storageKey, format, packageId | upload: skipped; external URL: streamed straight into Storage (100MB limit), hash computed |
| 2    | **Extract** | resourceId, packageId, storageKey, format | previewKey, encoding          | CSV/TSV → converted to Parquet inline. Unsupported formats are skipped. Non-critical       |

**Note**: The Index step has been removed. Search index updates are performed directly in the API
route handlers (on CUD operations).

Success/failure of each step is recorded in `resource_pipeline_step`.

### 6.6 processResource()

```typescript
// apps/worker/src/pipeline/process-resource.ts
async function processResource(
  resourceId: string,
  ctx: PipelineContext,
  db: Database
): Promise<void> {
  const tracker = new StepTracker(db)
  const pipeline = await tracker.startPipeline(resourceId)

  try {
    // Step 1: Fetch
    const fetchResult = await runStep(tracker, pipeline.id, 'fetch', () =>
      fetchStep(resourceId, ctx)
    )

    if (fetchResult) {
      // Step 2: Extract (nonCritical)
      const extractResult = await runStep(
        tracker,
        pipeline.id,
        'extract',
        () =>
          extractStep(
            resourceId,
            fetchResult.packageId,
            fetchResult.storageKey,
            fetchResult.format,
            ctx
          ),
        true
      )

      if (extractResult) {
        await tracker.updateExtractResult(pipeline.id, extractResult.previewKey, {
          encoding: extractResult.encoding,
        })
      }
    }

    await tracker.updateStatus(pipeline.id, 'complete')
  } catch (err) {
    await tracker.updateStatus(pipeline.id, 'error', (err as Error).message)
  }
}
```

**Splitting the pipeline management classes:**

- `PipelineService` (API side: `packages/api/src/services/pipeline-service.ts`) — enqueue, getStatus
- `StepTracker` (Worker side: `apps/worker/src/pipeline/step-tracker.ts`) — startPipeline,
  startStep, completeStep, failStep, skipStep, updateStatus, updateExtractResult

### 6.7 The Fetch step

Streams external URL resources straight into Storage. Already-uploaded resources are skipped
because the file is already in Storage. No temporary files are used; it writes directly to Storage.

```typescript
interface FetchResult {
  storageKey: string
  format: string | null
  packageId: string
}

async function fetchStep(resourceId: string, ctx: PipelineContext): Promise<FetchResult | null> {
  const res = await ctx.getResource(resourceId)
  if (!res) throw new NotFoundError(`Resource ${resourceId} not found or deleted`)

  const storageKey = getStorageKey(res.packageId, res.id)

  if (res.urlType === 'upload') {
    // Already in Storage — skip download
    return { storageKey, format: res.format, packageId: res.packageId }
  }

  if (!res.url) throw new ValidationError('Resource has no URL')

  // Stream external URL directly to Storage (10MB limit) + compute hash
  const { hash, size } = await downloadToStorage(res.url, storageKey, ctx.storage)

  if (hash !== res.hash) {
    await ctx.updateResourceMeta(resourceId, { hash, size })
  }

  return { storageKey, format: res.format, packageId: res.packageId }
}

// defined in apps/worker/src/config.ts
const MAX_FETCH_SIZE = 100 * 1024 * 1024 // 100MB
```

### 6.8 The smart CSV parser

Phase 3a scope (CSV/TSV only):

- Parsed with PapaParse
- **Header row detection**: skips a title row (only a single non-empty cell)
- **Footer detection**: excludes rows starting with things like "合計" (total), "注" (note), "※",
  "出典" (source), "備考" (remarks)
- **Encoding detection**: auto-detected with encoding-japanese and converted to UTF-8
- Unsupported formats skip Extract/Preview (only Index runs)

### 6.9 Preview data (Parquet format)

The Extract step parses CSV/TSV and stores every row in Storage in Parquet format (see ADR-014).

- **Libraries**: `hyparquet-writer` (writing on the server), `hyparquet` (reading in the browser)
- **Compression**: SNAPPY (the hyparquet-writer default; hyparquet can decompress Snappy in the
  browser)
- **Row group size**: 5,000 rows
- **Column types**: all columns are STRING

Storage key: `previews/{packageId}/{resourceId}.parquet`

The frontend paginates by range using hyparquet's `asyncBufferFromUrl()` +
`parquetReadObjects({ rowStart, rowEnd })`.

## 7. Step 5: Queue Integration

### 7.1 Registering the queue handler

The handler is registered inside `createApp()` in `packages/api/src/app.ts`:

```typescript
import { registerPipelineHandler } from './queue/pipeline-handler'

// immediately after createAdapters()
await registerPipelineHandler(db, adapters.queue, adapters.storage, adapters.search)
```

`pipeline-handler.ts` assembles the PipelineContext with `buildPipelineContext()` and calls
`processResource()`:

```typescript
await queue.process<{ resourceId: string }>(
  PIPELINE_JOB_TYPE,
  async (job: Job<{ resourceId: string }>) => {
    const ctx = buildPipelineContext(db, storage, search)
    await processResource(job.data.resourceId, ctx, db)
  }
)
```

### 7.2 Preview URL

The unified `preview-url` endpoint (ADR-015) returns the appropriate URL per format:

- CSV/TSV: a presigned URL for the Parquet file from `resource_pipeline.preview_key`
- PDF: a presigned URL for the original file (with inline disposition)
- Anything else: `null`

### 7.3 Integrating resource CRUD with the processing trigger

Enqueuing is added to the resource creation API (when a url is given) and the resource update API
(when the url changes):

```typescript
// POST /api/v1/packages/:packageId/resources
if (input.url) {
  await pipelineService.enqueue(resource.id)
}

// PUT /api/v1/resources/:id
if (input.url && input.url !== existing.url) {
  await pipelineService.resetAndEnqueue(resource.id)
}
```

## 8. Step 6: Frontend Extensions

### 8.1 New components

| Component                   | Summary                                                                      |
| --------------------------- | ---------------------------------------------------------------------------- |
| `file-upload.tsx`           | Drag & drop + file picker, upload progress, polling of the processing status |
| `pipeline-status-badge.tsx` | A badge for pending/queued/processing/complete/error                         |

### 8.2 Updates to existing pages

- **Dataset edit page**: add the FileUpload component
- **Dataset detail page**: show a PipelineStatusBadge on each resource
- **Resource detail page**: processing state + step details + preview

### 8.3 i18n

Add upload- and processing-related translation keys to `ja.json` / `en.json`

## 9. Test Strategy

| Target               | Test kind                            | Tooling                  |
| -------------------- | ------------------------------------ | ------------------------ |
| OpenSearchAdapter    | Unit (mocked client)                 | Vitest                   |
| Smart CSV parser     | Unit (CSV fixtures)                  | Vitest                   |
| Each pipeline step   | Unit (mocked Storage/DB/Search)      | Vitest                   |
| processResource      | Integration (all steps, mocked)      | Vitest                   |
| Upload API endpoints | Integration (test DB + LocalStorage) | Vitest                   |
| Frontend             | Component                            | Vitest + Testing Library |

## 10. Implementation Order

### Step 1: Implementation spec ✅

This document

### Step 2: Docker Compose + OpenSearchAdapter ✅

1. ~~Add OpenSearch 3.x + Dashboards to `docker/compose.yml` (profiles: search)~~
2. ~~Implement `packages/adapters/search/src/opensearch.ts` (kuromoji + nested resources)~~
3. ~~`packages/api/src/adapters.ts` — make `createAdapters` async~~
4. ~~`packages/api/src/app.ts` — handle the await~~
5. ~~Update `.env.example`~~
6. ~~Tests~~
7. ~~Update the OpenSearch version in CLAUDE.md (2.x → 3.x)~~

### Step 3: File upload API ✅

1. ~~StorageAdapter consolidation: `minio.ts` + `s3.ts` → `S3StorageAdapter` (based on `@aws-sdk/client-s3`)~~
2. ~~Add `getSignedUploadUrl` to `adapter.ts`, implement the sentinel URL in `LocalStorageAdapter`~~
3. ~~Simplify `STORAGE_TYPE`: `'s3' | 'minio' | 'local'` → `'s3' | 'local'`~~
4. ~~`packages/shared/src/adapter-types.ts` — add the `PipelineStatus` type~~
5. ~~`packages/shared/src/validators/resource.ts` — add `uploadUrlSchema`, `uploadCompleteSchema`~~
6. ~~`resource-service.ts` — add `prepareForUpload`, `updateAfterUpload`, `getStorageKey`~~
7. ~~`resources.ts` — add 5 endpoints (upload-url, upload, upload-complete, pipeline-status, download-url, formats)~~
8. ~~Tests: 12 unit, 15 validation, 17 integration~~
9. ~~PDF preview: the `ResourcePreview` component (CSV/TSV + PDF), the `download-url` endpoint, the `useFetch` hook~~
10. ~~TSV format support: add TSV to `isCsvFormat()` in `preview-service.ts`~~

### Step 4: DB schema change + resource processing pipeline ✅

1. ~~DB migration: create the `resource_pipeline` + `resource_pipeline_step` tables, remove the processing fields from the resource table~~
2. ~~Create `PipelineService` + `StepTracker` (enqueue/status + step management)~~
3. ~~Remove `updateIngestStatus` from `ResourceService`, stop `prepareForUpload` from touching `updated`~~
4. ~~Update the existing API routes (`ingest-status` → `pipeline-status`, changed response shape)~~
5. ~~Set up the `packages/pipeline/` package~~
6. ~~Type definitions (types.ts — PipelineContext adopts the accessor-method approach)~~
7. ~~The Fetch step (Storage + external URL, 10MB limit, hash computation)~~
8. ~~The smart CSV parser (csv-parser.ts — PapaParse + encoding-japanese)~~
9. ~~The Extract step (parse CSV → generate Parquet → save to Storage, ADR-014)~~
10. ~~The Index step (calls SearchAdapter.index())~~
11. ~~The processResource orchestrator (3 steps, nonCritical flag)~~
12. ~~Rename `IngestStatus` → `PipelineStatus` (shared, API, tests)~~
13. ~~Tests (fetch, csv-parser, process-resource, pipeline-service, pipeline-handler)~~

### Step 5: Queue integration ✅

1. ~~`packages/api/src/queue/pipeline-handler.ts` — register the queue handler + assemble the PipelineContext~~
2. ~~`packages/api/src/app.ts` — add the `registerPipelineHandler()` call~~
3. ~~Add processing triggers to resource CRUD (upload-complete, creation with a url, update with a url change)~~
4. ~~`POST /api/v1/resources/:id/run-pipeline` — add the manual pipeline endpoint~~
5. ~~End-to-end check (external CSV URL → fetch/extract/index → Parquet in MinIO)~~

### Step 6: Frontend extensions ✅

1. ~~The `FileUploadZone` component (drag & drop + presigned URL upload + progress)~~
2. ~~The `PipelineStatusBadge` component (auto-refresh by polling)~~
3. ~~The `useFileUpload`, `usePipelineStatus`, `useParquetPreview` custom hooks~~
4. ~~Resource form integration: unify create/edit into an inline form inside `ResourceList`~~
5. ~~The shared `ResourceFormFields` component (Name, Source tabs, Description, Format)~~
6. ~~`ResourcePreview` improvements: use the unified `preview-url` endpoint (ADR-015)~~
7. ~~Tabs to switch between table and text display (badge-based)~~
8. ~~PDF preview (iframe, inline disposition)~~
9. ~~i18n (ja.json / en.json)~~
10. ~~Tests~~

## 11. Completion Criteria

- [x] `docker compose --profile search up` starts OpenSearch 3.x (Step 2)
- [x] `SEARCH_TYPE=opensearch pnpm dev` starts the app (Step 2)
- [x] Search results come back via OpenSearch (Step 2)
- [x] The PostgreSQL fallback search still works (Step 2)
- [x] The file upload API endpoints work (Step 3)
- [x] S3StorageAdapter unifies MinIO / AWS S3 (Step 3)
- [x] The `resource_pipeline` / `resource_pipeline_step` tables work (Step 4)
- [x] CSV file upload → processing completes → Parquet preview generated (Steps 4-5)
- [x] External URL resource → processing completes → Parquet preview generated (Steps 4-5)
- [x] Success/failure of each step is recorded in `resource_pipeline_step` (Step 4)
- [x] The frontend has an upload UI + processing status display (Step 6)
- [x] `pnpm typecheck` succeeds
- [x] `pnpm test` passes everything (52 files, 521 tests)
- [x] `pnpm lint && pnpm format` pass
