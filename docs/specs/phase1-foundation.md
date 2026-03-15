# Phase 1: Foundation — 実装仕様書

> **目標**: モノレポ構築、DBスキーマ、4アダプターインターフェース、コアCRUD API、CKAN互換API(P1)、認証基盤、Docker Compose開発環境

## 1. プロジェクトセットアップ

### 1.1 Turborepo + pnpm workspaces 初期化

```
KUKAN/
├── apps/
│   └── web/              # Next.js フロントエンド + Hono API（単一オリジン）
├── packages/
│   ├── db/               # Drizzle スキーマ + マイグレーション
│   ├── shared/           # 型定義、Zod、lru-cache、エラークラス
│   ├── search/           # SearchAdapter
│   ├── storage/          # StorageAdapter
│   ├── queue/            # QueueAdapter
│   └── ai/              # AIAdapter
├── docker/
│   ├── docker-compose.yml
│   └── postgres/
│       └── Dockerfile       # pg_bigm 入りカスタムイメージ
├── docs/                 # ← 今のドキュメント群
├── turbo.json
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
├── .env.example
└── CLAUDE.md
```

**Note**: `apps/web`, `apps/worker`, `apps/editor`, `packages/quality`, `packages/pipeline`, `packages/editor-core`, `packages/ui` は Phase 1 では作成しない。ディレクトリ予約も不要。

### 1.2 TypeScript 設定

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

各パッケージは `extends: "../../tsconfig.base.json"` で継承。

### 1.3 主要 devDependencies（ルート）

- `turbo`
- `typescript` 5.x
- `vitest`
- `eslint` + `@typescript-eslint/*`
- `prettier`

---

## 2. packages/shared

最初に作る共有パッケージ。他の全パッケージがこれに依存する。

### 2.1 エラークラス

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

### 2.2 lru-cache ユーティリティ

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

### 2.3 環境変数バリデーション

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
  QUEUE_TYPE: z.enum(['sqs', 'in-process']).default('in-process'),
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

### 2.4 Zod バリデーションスキーマ（API入力）

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
  owner_org: z.string().uuid().optional(),
  private: z.boolean().default(false),
  license_id: z.string().optional(),
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

同様に `organization.ts`, `resource.ts`, `group.ts`, `user.ts` も作成。

### 2.5 共通型定義

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

### 3.1 Drizzle スキーマ定義

設計書セクション6.2のSQLスキーマをDrizzleのTypeScript定義に変換する。
Phase 1で作成するテーブル:

| テーブル              | 概要                                   |
| --------------------- | -------------------------------------- |
| organization          | 組織                                   |
| group                 | グループ                               |
| user                  | ユーザー（Better Auth テーブルと統合） |
| api_token             | APIトークン                            |
| package               | データセット                           |
| resource              | リソース                               |
| vocabulary            | ボキャブラリー                         |
| tag                   | タグ                                   |
| package_tag           | パッケージ-タグ紐付け                  |
| user_org_membership   | ユーザー-組織メンバーシップ            |
| user_group_membership | ユーザー-グループメンバーシップ        |
| package_group         | パッケージ-グループ紐付け              |
| audit_log             | 監査ログ                               |
| activity              | アクティビティストリーム               |

**Better Auth テーブル**: `user`, `session`, `account`, `verification` — Better Auth の Drizzle プラグインで自動生成される。`user` テーブルはKUKAN独自カラムを追加拡張。

Phase 3以降のテーブル（`quality_check`, `quality_score_history`, `harvest_source` 等）はPhase 1では作成しない。

### 3.2 ファイル構成

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
│   │   └── index.ts       # 全スキーマ re-export
│   ├── client.ts           # Drizzle DB クライアント生成
│   ├── migrate.ts          # マイグレーション実行スクリプト
│   └── index.ts            # エントリーポイント
├── drizzle/                # マイグレーションファイル（自動生成）
├── drizzle.config.ts
├── package.json
└── tsconfig.json
```

### 3.3 Drizzleスキーマ例（package テーブル）

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

    // 新機能フィールド（Phase 1ではNULL許容、後続Phaseで活用）
    qualityScore: text('quality_score'), // Phase 4で FLOAT に変更予定
    aiSummary: text('ai_summary'),
    aiTags: text('ai_tags'),

    metadataCreated: timestamp('metadata_created', { withTimezone: true }).defaultNow(),
    metadataModified: timestamp('metadata_modified', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_package_owner_org').on(table.ownerOrg),
    index('idx_package_state').on(table.state),
  ]
)
```

**Note**: `search_vector` (tsvector) と `spatial_coverage` (geometry) はDrizzleの標準型で表現しにくいため、マイグレーションSQL内で直接定義する（`drizzle-kit` のカスタムSQL機能を使用）。

### 3.4 DBクライアント

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

## 4. アダプターインターフェース

Phase 1ではインターフェース定義と最小限の開発用実装のみ。

### 4.1 packages/adapters/storage (@kukan/storage-adapter)

```
packages/adapters/storage/src/
├── adapter.ts          # StorageAdapter インターフェース
├── minio.ts            # MinIOStorageAdapter（開発用、Phase 1で実装）
├── local.ts            # LocalStorageAdapter（テスト用、Phase 1で実装）
├── s3.ts               # S3StorageAdapter（Phase 3で実装、スタブのみ）
└── index.ts
```

Phase 1で実装: **MinIOStorageAdapter** + **LocalStorageAdapter**（テスト用）

### 4.2 packages/adapters/search (@kukan/search-adapter)

```
packages/adapters/search/src/
├── adapter.ts          # SearchAdapter インターフェース
├── postgres.ts         # PostgresSearchAdapter（Phase 1で実装）
├── opensearch.ts       # OpenSearchAdapter（Phase 3で実装）
└── index.ts
```

Phase 1で実装: **PostgresSearchAdapter**（tsvector ベースのフォールバック検索）

### 4.3 packages/adapters/queue (@kukan/queue-adapter)

```
packages/adapters/queue/src/
├── adapter.ts          # QueueAdapter インターフェース
├── in-process.ts       # InProcessQueueAdapter（Phase 1で実装）
├── sqs.ts              # SqsQueueAdapter（Phase 3で実装）
└── index.ts
```

Phase 1で実装: **InProcessQueueAdapter**

### 4.4 packages/adapters/ai (@kukan/ai-adapter)

```
packages/adapters/ai/src/
├── adapter.ts          # AIAdapter インターフェース
├── noop.ts             # NoOpAIAdapter（Phase 1で実装、全メソッドがダミー値返却）
├── bedrock.ts          # Phase 5
├── openai.ts           # Phase 5
├── ollama.ts           # Phase 5
└── index.ts
```

Phase 1で実装: **NoOpAIAdapter**（全メソッドがデフォルト値を返す）

### 4.5 アダプターファクトリー

```typescript
// apps/api/src/adapters.ts
import { loadEnv } from '@kukan/shared'
import { MinIOStorageAdapter } from '@kukan/storage-adapter'
import { PostgresSearchAdapter } from '@kukan/search-adapter'
import { InProcessQueueAdapter } from '@kukan/queue-adapter'
import { NoOpAIAdapter } from '@kukan/ai-adapter'

export function createAdapters(env: Env) {
  return {
    storage:
      env.STORAGE_TYPE === 'minio' ? new MinIOStorageAdapter(env) : new MinIOStorageAdapter(env), // Phase 3で S3 分岐追加
    search: new PostgresSearchAdapter(env.DATABASE_URL),
    queue: new InProcessQueueAdapter(),
    ai: new NoOpAIAdapter(),
  }
}
```

---

## 5. packages/api — Hono API サーバー（ライブラリ）

### 5.1 ファイル構成

```
packages/api/
├── src/
│   ├── app.ts               # Hono app 生成、ミドルウェア登録
│   ├── server.ts             # Node.js サーバー起動
│   ├── adapters.ts           # アダプターファクトリー
│   ├── context.ts            # Hono Context 型拡張
│   ├── middleware/
│   │   ├── error-handler.ts  # RFC 7807 エラーレスポンス
│   │   ├── auth.ts           # Better Auth セッション検証
│   │   └── logger.ts
│   ├── routes/
│   │   ├── packages.ts       # /api/v1/packages
│   │   ├── resources.ts      # /api/v1/resources
│   │   ├── organizations.ts  # /api/v1/organizations
│   │   ├── groups.ts         # /api/v1/groups
│   │   ├── users.ts          # /api/v1/users
│   │   ├── tags.ts           # /api/v1/tags
│   │   └── ckan-compat.ts    # /api/3/action/*（CKAN互換）
│   ├── services/             # ビジネスロジック
│   │   ├── package-service.ts
│   │   ├── resource-service.ts
│   │   ├── organization-service.ts
│   │   ├── group-service.ts
│   │   ├── user-service.ts
│   │   └── tag-service.ts
│   └── auth/
│       ├── auth.ts           # Better Auth インスタンス
│       └── permissions.ts    # 権限チェックヘルパー
├── package.json
└── tsconfig.json
```

### 5.2 コアCRUD API エンドポイント

**ネイティブ REST API（`/api/v1/`）**

| Method | Path                            | 概要                          |
| ------ | ------------------------------- | ----------------------------- |
| GET    | /api/v1/packages                | 一覧（ページネーション+検索） |
| POST   | /api/v1/packages                | 作成                          |
| GET    | /api/v1/packages/:nameOrId      | 取得                          |
| PUT    | /api/v1/packages/:nameOrId      | 全体更新                      |
| PATCH  | /api/v1/packages/:nameOrId      | 部分更新                      |
| DELETE | /api/v1/packages/:nameOrId      | 削除（state=deleted）         |
| GET    | /api/v1/packages/:id/resources  | パッケージのリソース一覧      |
| POST   | /api/v1/packages/:id/resources  | リソース追加                  |
| GET    | /api/v1/resources/:id           | リソース取得                  |
| PUT    | /api/v1/resources/:id           | リソース更新                  |
| DELETE | /api/v1/resources/:id           | リソース削除                  |
| GET    | /api/v1/organizations           | 一覧                          |
| POST   | /api/v1/organizations           | 作成                          |
| GET    | /api/v1/organizations/:nameOrId | 取得                          |
| PUT    | /api/v1/organizations/:nameOrId | 更新                          |
| GET    | /api/v1/groups                  | 一覧                          |
| POST   | /api/v1/groups                  | 作成                          |
| GET    | /api/v1/groups/:nameOrId        | 取得                          |
| GET    | /api/v1/users/me                | 自分の情報                    |
| GET    | /api/v1/tags                    | 一覧                          |
| GET    | /api/v1/search                  | 全文検索（SearchAdapter経由） |

### 5.3 CKAN互換API（P1エンドポイント）

設計書セクション14.1のP1エンドポイントを実装:

| CKAN Action       | 対応するネイティブAPI         |
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

**CKAN互換ルーター**は `routes/ckan-compat.ts` でネイティブAPIを呼び出し、CKANフォーマット（`{ success, result, help }`）に変換して返す薄いラッパー。

### 5.4 認証（Better Auth）

```typescript
// packages/api/src/auth/auth.ts
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { db } from '@kukan/db'

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  emailAndPassword: { enabled: true },
  // Phase 6 で OIDC プラグイン追加
})
```

Phase 1 での認証フロー:

1. メール/パスワード認証のみ（開発用、外部IdP不要）
2. セッションはDB保存（Better Auth デフォルト）
3. API Key 認証: `api_token` テーブルでカスタム実装
4. ミドルウェアでセッション or API Key を検証

### 5.5 エラーハンドリング

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
      console.error(err)
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

## 6. Docker Compose 開発環境

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

```dockerfile
# docker/postgres/Dockerfile
FROM postgres:16-alpine
RUN apk add --no-cache postgresql16-pg_bigm
```

**Note**: Phase 1 の検索は PostgreSQL ILIKE フォールバック。Phase 3 で OpenSearch を追加。詳細は `docs/adr/009-opensearch-ilike-fallback.md` を参照。

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
QUEUE_TYPE=in-process

# AI
AI_TYPE=none

# Auth
BETTER_AUTH_SECRET=change-this-to-at-least-32-characters-secret
BETTER_AUTH_URL=http://localhost:3000
```

---

## 8. テスト戦略（Phase 1）

### 8.1 テスト対象

| 対象              | テスト種別               | ツール                           |
| ----------------- | ------------------------ | -------------------------------- |
| packages/shared   | ユニット                 | Vitest                           |
| packages/db       | 統合テスト（テスト用DB） | Vitest + テストコンテナ          |
| packages/storage  | ユニット（LocalAdapter） | Vitest                           |
| packages/search   | 統合テスト（テスト用DB） | Vitest + テストコンテナ          |
| packages/api routes   | 統合テスト               | Vitest + Hono テストクライアント |
| packages/api services | ユニット（モック注入）   | Vitest                           |
| CKAN互換API       | 統合テスト               | Vitest                           |

### 8.2 テストDB

開発用Docker ComposeのPostgreSQLを使うか、`testcontainers` でテスト毎にコンテナ起動。

```typescript
// テスト例
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

## 9. 実装順序（推奨）

Claude Code に指示する際、以下の順番で進める:

### Step 1: プロジェクトスケルトン

1. `pnpm init`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`
2. 全パッケージの `package.json` + `tsconfig.json` 空スケルトン
3. ESLint / Prettier 設定
4. `pnpm install`

### Step 2: packages/shared

1. エラークラス
2. 環境変数バリデーション（Zod）
3. lru-cache ユーティリティ
4. 共通型定義
5. Zod バリデーションスキーマ
6. テスト

### Step 3: packages/db

1. Drizzle 設定（`drizzle.config.ts`）
2. スキーマ定義（全14テーブル）
3. DBクライアント
4. マイグレーション生成・実行
5. Better Auth テーブル統合
6. テスト（テストDB接続）

### Step 4: アダプター（4パッケージ）

1. インターフェース定義
2. packages/storage — MinIOStorageAdapter + LocalStorageAdapter
3. packages/search — PostgresSearchAdapter
4. packages/queue — InProcessQueueAdapter
5. packages/ai — NoOpAIAdapter
6. 各アダプターのテスト

### Step 5: Docker Compose

1. `docker/docker-compose.yml`
2. `.env.example` → `.env` コピー
3. `docker compose up` で PostgreSQL + MinIO 起動確認

### Step 6: packages/api

1. Hono app スケルトン + ミドルウェア
2. Better Auth 初期化
3. Organization CRUD（最もシンプル、叩き台として）
4. Package CRUD
5. Resource CRUD
6. Group CRUD
7. User / Tag
8. 全文検索エンドポイント
9. CKAN互換APIラッパー
10. 権限チェック
11. テスト（全エンドポイント）

### Step 7: 統合確認

1. Docker Compose + API サーバー起動
2. CKAN互換APIでダミーデータ登録
3. 検索動作確認
4. MinIOファイルアップロード確認

---

## 10. Phase 1 完了基準

- [ ] `pnpm build` が全パッケージで成功
- [ ] `pnpm test` が全テスト合格
- [ ] `pnpm typecheck` がエラーなし
- [ ] Docker Compose で PostgreSQL + MinIO が起動
- [ ] API サーバーが起動し、ヘルスチェック応答
- [ ] Package / Resource / Organization / Group / User の CRUD が動作
- [ ] CKAN互換API（P1エンドポイント10個）が動作
- [ ] PostgreSQL 全文検索が動作
- [ ] Better Auth でメール/パスワード認証が動作
- [ ] API Key 認証が動作
- [ ] MinIO へのファイルアップロード/ダウンロードが動作
