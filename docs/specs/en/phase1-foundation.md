> **Note**: This is a machine-translated version of the original Japanese implementation spec for reference purposes. The authoritative version is [`jp/phase1-foundation.md`](../jp/phase1-foundation.md).

# Phase 1: Foundation — Implementation Spec

> **This is a record of a completed phase.** Later ADRs have changed parts of the implementation,
> so for the current shape see the phase list in `CLAUDE.md` and `docs/pipeline.md`. The file paths
> and step names below are the ones in use at the time.

> **Goal**: Set up the monorepo, the DB schema, the four adapter interfaces, the core CRUD API, the
> CKAN-compatible API (P1), the authentication foundation, and the Docker Compose development
> environment

## 1. Project Setup

### 1.1 Initializing Turborepo + pnpm workspaces

```
KUKAN/
├── apps/
│   └── web/              # Next.js frontend + Hono API (single origin)
├── packages/
│   ├── db/               # Drizzle schema + migrations
│   ├── shared/           # type definitions, Zod, lru-cache, error classes
│   ├── search/           # SearchAdapter
│   ├── storage/          # StorageAdapter
│   ├── queue/            # QueueAdapter
│   └── ai/              # AIAdapter
├── docker/
│   └── compose.yml
├── docs/                 # ← the current documentation set
├── turbo.json
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
├── .env.example
└── CLAUDE.md
```

**Note**: `apps/web`, `apps/worker`, `apps/editor`, `packages/quality`, `packages/pipeline`,
`packages/editor-core` and `packages/ui` are not created in Phase 1. There is no need to reserve
the directories either.

### 1.2 TypeScript configuration

```jsonc
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "paths": {
      "@kukan/*": ["../packages/*/src"],
    },
  },
}
```

Each package inherits it with `extends: "../../tsconfig.base.json"`.

### 1.3 Main devDependencies (root)

- `turbo`
- `typescript` 5.x
- `vitest`
- `eslint` + `@typescript-eslint/*`
- `prettier`

---

## 2. packages/shared

The shared package built first. Every other package depends on it.

### 2.1 Error classes

```typescript
// packages/shared/src/errors.ts
export class KukanError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number = 500,
    public readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'KukanError'
  }
}

export class NotFoundError extends KukanError {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`, 'NOT_FOUND', 404)
  }
}

export class ValidationError extends KukanError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', 400, details)
  }
}

export class ForbiddenError extends KukanError {
  constructor(message = 'Forbidden') {
    super(message, 'FORBIDDEN', 403)
  }
}
```

### 2.2 lru-cache utility

```typescript
// packages/shared/src/cache.ts
import { LRUCache } from 'lru-cache'

export function createCache<V>(options?: { max?: number; ttlMs?: number }) {
  return new LRUCache<string, V>({
    max: options?.max ?? 500,
    ttl: options?.ttlMs ?? 5 * 60 * 1000,
  })
}
```

### 2.3 Environment variable validation

```typescript
// packages/shared/src/env.ts
import { z } from 'zod'

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().default(3000),

  // Storage
  STORAGE_TYPE: z.enum(['s3', 'minio', 'local']).default('minio'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('ap-northeast-1'),
  MINIO_ENDPOINT: z.string().default('http://localhost:9000'),
  MINIO_ACCESS_KEY: z.string().default('minioadmin'),
  MINIO_SECRET_KEY: z.string().default('minioadmin'),

  // Search
  SEARCH_TYPE: z.enum(['opensearch', 'postgres']).default('postgres'),
  OPENSEARCH_URL: z.string().optional(),

  // Queue
  QUEUE_TYPE: z.enum(['sqs']).default('sqs'), // SQS-compatible (AWS SQS / ElasticMQ)
  SQS_QUEUE_URL: z.string().optional(),

  // AI
  AI_TYPE: z.enum(['bedrock', 'openai', 'ollama', 'none']).default('none'),

  // Auth
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url().default('http://localhost:3000'),
})

export type Env = z.infer<typeof envSchema>

export function loadEnv(): Env {
  return envSchema.parse(process.env)
}
```

### 2.4 Zod validation schemas (API input)

```typescript
// packages/shared/src/validators/package.ts
import { z } from 'zod'

export const createPackageSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(100)
    .regex(/^[a-z0-9-_]+$/),
  title: z.string().optional(),
  notes: z.string().optional(),
  ownerOrg: z.uuid(),
  private: z.boolean().default(false),
  licenseId: z.string().optional(),
  extras: z.record(z.unknown()).default({}),
  tags: z.array(z.object({ name: z.string() })).default([]),
  resources: z
    .array(
      z.object({
        url: z.string().url().optional(),
        name: z.string().optional(),
        format: z.string().optional(),
        description: z.string().optional(),
      })
    )
    .default([]),
})

export const updatePackageSchema = createPackageSchema.partial()
export const patchPackageSchema = createPackageSchema.partial()
```

`organization.ts`, `resource.ts`, `group.ts` and `user.ts` are created the same way.

### 2.5 Shared type definitions

```typescript
// packages/shared/src/types.ts
export interface PaginationParams {
  offset?: number
  limit?: number
}

export interface PaginatedResult<T> {
  items: T[]
  total: number
  offset: number
  limit: number
}

export interface ProblemDetail {
  type: string
  title: string
  status: number
  detail?: string
  instance?: string
}
```

---

## 3. packages/db

### 3.1 Drizzle schema definitions

The SQL schema in section 6.2 of the design document is converted into Drizzle TypeScript
definitions. Tables created in Phase 1:

| Table                 | Summary                                        |
| --------------------- | ---------------------------------------------- |
| organization          | Organizations                                  |
| group                 | Groups                                         |
| user                  | Users (integrated with the Better Auth tables) |
| api_token             | API tokens                                     |
| package               | Datasets                                       |
| resource              | Resources                                      |
| vocabulary            | Vocabularies                                   |
| tag                   | Tags                                           |
| package_tag           | Package–tag association                        |
| user_org_membership   | User–organization membership                   |
| user_group_membership | User–group membership                          |
| package_group         | Package–group association                      |
| audit_log             | Audit log                                      |
| activity              | Activity stream                                |

**Better Auth tables**: `user`, `session`, `account`, `verification` — generated automatically by
the Better Auth Drizzle plugin. The `user` table is extended with KUKAN-specific columns.

Tables from Phase 3 onwards (`quality_check`, `quality_score_history`, `harvest_source` etc.) are
not created in Phase 1.

### 3.2 File layout

```
packages/db/
├── src/
│   ├── schema/
│   │   ├── organization.ts
│   │   ├── group.ts
│   │   ├── user.ts
│   │   ├── package.ts
│   │   ├── resource.ts
│   │   ├── tag.ts
│   │   ├── membership.ts
│   │   ├── audit.ts
│   │   ├── activity.ts
│   │   └── index.ts       # re-exports every schema
│   ├── client.ts           # creates the Drizzle DB client
│   ├── migrate.ts          # migration runner script
│   └── index.ts            # entry point
├── drizzle/                # migration files (generated)
├── drizzle.config.ts
├── package.json
└── tsconfig.json
```

### 3.3 Drizzle schema example (the package table)

```typescript
// packages/db/src/schema/package.ts
import { pgTable, uuid, varchar, text, boolean, jsonb, timestamp, index } from 'drizzle-orm/pg-core'
import { organization } from './organization'
import { user } from './user'

export const packageTable = pgTable(
  'package',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 100 }).unique().notNull(),
    title: text('title'),
    notes: text('notes'),
    url: text('url'),
    version: varchar('version', { length: 100 }),
    licenseId: varchar('license_id', { length: 100 }),
    author: text('author'),
    authorEmail: text('author_email'),
    maintainer: text('maintainer'),
    maintainerEmail: text('maintainer_email'),
    state: varchar('state', { length: 20 }).default('active'),
    type: varchar('type', { length: 100 }).default('dataset'),
    ownerOrg: uuid('owner_org').references(() => organization.id),
    private: boolean('private').default(false),
    creatorUserId: uuid('creator_user_id').references(() => user.id),
    extras: jsonb('extras').default({}),

    // fields for new features (nullable in Phase 1, used in later phases)
    qualityScore: text('quality_score'), // planned to become FLOAT in Phase 4
    aiSummary: text('ai_summary'),
    aiTags: text('ai_tags'),

    created: timestamp('created', { withTimezone: true }).defaultNow(),
    updated: timestamp('updated', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_package_name').on(table.name),
    index('idx_package_owner_org').on(table.ownerOrg),
    index('idx_package_state').on(table.state),
    index('idx_package_creator_user_id').on(table.creatorUserId),
  ]
)
```

**Note**: `search_vector` (tsvector) and `spatial_coverage` (geometry) are hard to express with
Drizzle's standard types, so they are defined directly in the migration SQL (using drizzle-kit's
custom SQL feature).

### 3.4 DB client

```typescript
// packages/db/src/client.ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString })
  return drizzle(pool, { schema })
}

export type Database = ReturnType<typeof createDb>
```

---

## 4. Adapter Interfaces

Phase 1 covers only the interface definitions and minimal development implementations.

### 4.1 packages/adapters/storage (@kukan/storage-adapter)

```
packages/adapters/storage/src/
├── adapter.ts          # the StorageAdapter interface
├── minio.ts            # MinIOStorageAdapter (for development, implemented in Phase 1)
├── local.ts            # LocalStorageAdapter (for tests, implemented in Phase 1)
├── s3.ts               # S3StorageAdapter (implemented in Phase 3, stub only for now)
└── index.ts
```

Implemented in Phase 1: **MinIOStorageAdapter** + **LocalStorageAdapter** (for tests)

### 4.2 packages/adapters/search (@kukan/search-adapter)

```
packages/adapters/search/src/
├── adapter.ts          # the SearchAdapter interface
├── postgres.ts         # PostgresSearchAdapter (implemented in Phase 1)
├── opensearch.ts       # OpenSearchAdapter (implemented in Phase 3)
└── index.ts
```

Implemented in Phase 1: **PostgresSearchAdapter** (tsvector-based fallback search)

### 4.3 packages/adapters/queue (@kukan/queue-adapter)

```
packages/adapters/queue/src/
├── adapter.ts          # the QueueAdapter interface
├── sqs.ts              # SqsQueueAdapter (SQS / ElasticMQ unified)
└── index.ts
```

Implemented in Phase 1: **SqsQueueAdapter** (runs against ElasticMQ in development)

### 4.4 packages/adapters/ai (@kukan/ai-adapter)

```
packages/adapters/ai/src/
├── adapter.ts          # the AIAdapter interface
├── noop.ts             # NoOpAIAdapter (implemented in Phase 1; every method returns a dummy value)
├── bedrock.ts          # Phase 5
├── openai.ts           # Phase 5
├── ollama.ts           # Phase 5
└── index.ts
```

Implemented in Phase 1: **NoOpAIAdapter** (every method returns a default value)

### 4.5 Adapter factory

```typescript
// apps/api/src/adapters.ts
import { loadEnv } from '@kukan/shared'
import { MinIOStorageAdapter } from '@kukan/storage-adapter'
import { PostgresSearchAdapter } from '@kukan/search-adapter'
import { SqsQueueAdapter } from '@kukan/queue-adapter'
import { NoOpAIAdapter } from '@kukan/ai-adapter'

export function createAdapters(env: Env) {
  return {
    storage:
      env.STORAGE_TYPE === 'minio' ? new MinIOStorageAdapter(env) : new MinIOStorageAdapter(env), // the S3 branch is added in Phase 3
    search: new PostgresSearchAdapter(env.DATABASE_URL),
    queue: new SqsQueueAdapter(env.SQS_QUEUE_URL),
    ai: new NoOpAIAdapter(),
  }
}
```

---

## 5. packages/api — the Hono API Server (library)

### 5.1 File layout

```
packages/api/
├── src/
│   ├── app.ts               # creates the Hono app, registers middleware
│   ├── server.ts             # starts the Node.js server
│   ├── adapters.ts           # adapter factory
│   ├── context.ts            # Hono Context type extension
│   ├── middleware/
│   │   ├── error-handler.ts  # RFC 7807 error responses
│   │   ├── auth.ts           # Better Auth session verification
│   │   └── logger.ts
│   ├── routes/
│   │   ├── packages.ts       # /api/v1/packages
│   │   ├── resources.ts      # /api/v1/resources
│   │   ├── organizations.ts  # /api/v1/organizations
│   │   ├── groups.ts         # /api/v1/groups
│   │   ├── users.ts          # /api/v1/users
│   │   ├── tags.ts           # /api/v1/tags
│   │   └── ckan-compat.ts    # /api/3/action/* (CKAN compatibility)
│   ├── services/             # business logic
│   │   ├── package-service.ts
│   │   ├── resource-service.ts
│   │   ├── organization-service.ts
│   │   ├── group-service.ts
│   │   ├── user-service.ts
│   │   └── tag-service.ts
│   └── auth/
│       ├── auth.ts           # the Better Auth instance
│       └── permissions.ts    # permission check helpers
├── package.json
└── tsconfig.json
```

### 5.2 Core CRUD API endpoints

**Native REST API (`/api/v1/`)**

| Method | Path                            | Summary                              |
| ------ | ------------------------------- | ------------------------------------ |
| GET    | /api/v1/packages                | List (pagination + search)           |
| POST   | /api/v1/packages                | Create                               |
| GET    | /api/v1/packages/:nameOrId      | Fetch                                |
| PUT    | /api/v1/packages/:nameOrId      | Full update                          |
| PATCH  | /api/v1/packages/:nameOrId      | Partial update                       |
| DELETE | /api/v1/packages/:nameOrId      | Delete (state=deleted)               |
| GET    | /api/v1/packages/:id/resources  | List a package's resources           |
| POST   | /api/v1/packages/:id/resources  | Add a resource                       |
| GET    | /api/v1/resources/:id           | Fetch a resource                     |
| PUT    | /api/v1/resources/:id           | Update a resource                    |
| DELETE | /api/v1/resources/:id           | Delete a resource                    |
| GET    | /api/v1/organizations           | List                                 |
| POST   | /api/v1/organizations           | Create                               |
| GET    | /api/v1/organizations/:nameOrId | Fetch                                |
| PUT    | /api/v1/organizations/:nameOrId | Update                               |
| GET    | /api/v1/groups                  | List                                 |
| POST   | /api/v1/groups                  | Create                               |
| GET    | /api/v1/groups/:nameOrId        | Fetch                                |
| GET    | /api/v1/users/me                | My own information                   |
| GET    | /api/v1/tags                    | List                                 |
| GET    | /api/v1/search                  | Full-text search (via SearchAdapter) |

### 5.3 CKAN-compatible API (the P1 endpoints)

Implements the P1 endpoints from section 14.1 of the design document:

| CKAN Action       | Corresponding native API      |
| ----------------- | ----------------------------- |
| package_list      | GET /api/v1/packages          |
| package_show      | GET /api/v1/packages/:id      |
| package_search    | GET /api/v1/search            |
| resource_show     | GET /api/v1/resources/:id     |
| organization_list | GET /api/v1/organizations     |
| organization_show | GET /api/v1/organizations/:id |
| group_list        | GET /api/v1/groups            |
| group_show        | GET /api/v1/groups/:id        |
| tag_list          | GET /api/v1/tags              |
| tag_show          | GET /api/v1/tags/:id          |

**The CKAN compatibility router** in `routes/ckan-compat.ts` is a thin wrapper that calls the
native API and converts the result into the CKAN format (`{ success, result, help }`).

### 5.4 Authentication (Better Auth)

```typescript
// packages/api/src/auth/auth.ts
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { db } from '@kukan/db'

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  emailAndPassword: { enabled: true },
  // the OIDC plugin is added in Phase 6
})
```

The Phase 1 authentication flow:

1. Email/password authentication only (for development, no external IdP needed)
2. Sessions are stored in the DB (the Better Auth default)
3. API key authentication: implemented ourselves with the `api_token` table
4. Middleware verifies either the session or the API key

### 5.5 Error handling

```typescript
// packages/api/src/middleware/error-handler.ts
import { KukanError } from '@kukan/shared'

export function errorHandler() {
  return async (c, next) => {
    try {
      await next()
    } catch (err) {
      if (err instanceof KukanError) {
        return c.json(
          {
            type: 'about:blank',
            title: err.code,
            status: err.status,
            detail: err.message,
          },
          err.status
        )
      }
      c.get('logger').error({ err }, 'Unhandled error')
      return c.json(
        {
          type: 'about:blank',
          title: 'Internal Server Error',
          status: 500,
        },
        500
      )
    }
  }
}
```

---

## 6. Docker Compose Development Environment

```yaml
# docker/docker-compose.yml
services:
  postgres:
    build: ./postgres
    ports:
      - '5432:5432'
    environment:
      POSTGRES_DB: kukan
      POSTGRES_USER: kukan
      POSTGRES_PASSWORD: kukan
    volumes:
      - pgdata:/var/lib/postgresql/data

  minio:
    image: minio/minio
    ports:
      - '9000:9000'
      - '9001:9001'
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    command: server /data --console-address ":9001"
    volumes:
      - miniodata:/data

volumes:
  pgdata:
  miniodata:
```

**Note**: Search in Phase 1 is the PostgreSQL ILIKE fallback (sped up with a pg_trgm GIN index).
OpenSearch is added in Phase 3. For details see
`docs/adr/en/009-opensearch-ilike-fallback.md`.

---

## 7. .env.example

```bash
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://kukan:kukan@localhost:5432/kukan

# Storage (MinIO for development)
STORAGE_TYPE=minio
MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
S3_BUCKET=kukan-dev

# Search
SEARCH_TYPE=postgres

# Queue
QUEUE_TYPE=sqs
SQS_QUEUE_URL=http://localhost:9324/queue/kukan-pipeline

# AI
AI_TYPE=none

# Auth
BETTER_AUTH_SECRET=change-this-to-at-least-32-characters-secret
BETTER_AUTH_URL=http://localhost:3000
```

---

## 8. Test Strategy (Phase 1)

### 8.1 What is tested

| Target                | Test kind             | Tooling                       |
| --------------------- | --------------------- | ----------------------------- |
| packages/shared       | Unit                  | Vitest                        |
| packages/db           | Integration (test DB) | Vitest + test containers      |
| packages/storage      | Unit (LocalAdapter)   | Vitest                        |
| packages/search       | Integration (test DB) | Vitest + test containers      |
| packages/api routes   | Integration           | Vitest + the Hono test client |
| packages/api services | Unit (injected mocks) | Vitest                        |
| CKAN-compatible API   | Integration           | Vitest                        |

### 8.2 Test DB

Either use the PostgreSQL from the development Docker Compose stack, or start a container per test
run with `testcontainers`.

```typescript
// example test
import { testClient } from 'hono/testing'
import { app } from '../src/app'

describe('GET /api/v1/packages', () => {
  it('should return paginated list', async () => {
    const res = await testClient(app).api.v1.packages.$get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toBeInstanceOf(Array)
  })
})
```

---

## 9. Implementation Order (recommended)

When instructing Claude Code, proceed in this order:

### Step 1: Project skeleton

1. `pnpm init`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`
2. Empty `package.json` + `tsconfig.json` skeletons for every package
3. ESLint / Prettier configuration
4. `pnpm install`

### Step 2: packages/shared

1. Error classes
2. Environment variable validation (Zod)
3. lru-cache utility
4. Shared type definitions
5. Zod validation schemas
6. Tests

### Step 3: packages/db

1. Drizzle configuration (`drizzle.config.ts`)
2. Schema definitions (all 14 tables)
3. DB client
4. Generating and running migrations
5. Better Auth table integration
6. Tests (connecting to the test DB)

### Step 4: Adapters (4 packages)

1. Interface definitions
2. packages/storage — MinIOStorageAdapter + LocalStorageAdapter
3. packages/search — PostgresSearchAdapter
4. packages/queue — SqsQueueAdapter
5. packages/ai — NoOpAIAdapter
6. Tests for each adapter

### Step 5: Docker Compose

1. `docker/docker-compose.yml`
2. Copy `.env.example` → `.env`
3. Confirm PostgreSQL + MinIO start with `docker compose up`

### Step 6: packages/api

1. Hono app skeleton + middleware
2. Better Auth initialization
3. Organization CRUD (the simplest, as a first cut)
4. Package CRUD
5. Resource CRUD
6. Group CRUD
7. User / Tag
8. The full-text search endpoint
9. The CKAN compatibility API wrapper
10. Permission checks
11. Tests (every endpoint)

### Step 7: Integration check

1. Start Docker Compose + the API server
2. Register dummy data through the CKAN-compatible API
3. Confirm search works
4. Confirm file upload to MinIO

---

## 10. Phase 1 Completion Criteria

- [ ] `pnpm build` succeeds for every package
- [ ] `pnpm test` passes everything
- [ ] `pnpm typecheck` reports no errors
- [ ] Docker Compose starts PostgreSQL + MinIO
- [ ] The API server starts and answers the health check
- [ ] CRUD works for Package / Resource / Organization / Group / User
- [ ] The CKAN-compatible API (the 10 P1 endpoints) works
- [ ] PostgreSQL full-text search works
- [ ] Email/password authentication works through Better Auth
- [ ] API key authentication works
- [ ] File upload/download to MinIO works
