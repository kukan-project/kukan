# Phase 3a: リソース処理 & ファイルストレージ — 実装仕様書

> **目標**: ファイルアップロード（Presigned URL）、リソース処理パイプライン（CSV/TSV + 外部 URL 対応）、OpenSearch 検索を実装し、開発環境（Docker Compose + InProcessQueue + MinIO）で E2E 動作する状態にする

## 1. 前提

- Phase 1 API 完成済み（CRUD + CKAN 互換 + 検索 + 認証）
- Phase 2 Frontend 完成済み（Next.js 15 カタログ UI + 管理画面）
- `resource` テーブルに `urlType` カラム定義済み
- StorageAdapter / QueueAdapter / SearchAdapter インターフェース定義済み
- S3CompatibleStorageAdapter（MinIO / AWS S3 統合）, InProcessQueueAdapter, PostgresSearchAdapter 実装済み
- Docker Compose: PostgreSQL 16 + MinIO 動作済み

### Phase 3a vs Phase 3b

| 項目         | Phase 3a（本仕様書）                      | Phase 3b（別途）            |
| ------------ | ----------------------------------------- | --------------------------- |
| スコープ     | 開発環境で E2E 動作                       | AWS 本番基盤                |
| ストレージ   | S3CompatibleStorageAdapter（MinIO 接続）  | 同アダプター（AWS S3 接続） |
| キュー       | InProcessQueue（既存）                    | SQSQueueAdapter + Worker    |
| 検索         | OpenSearch（Docker）                      | AWS OpenSearch Service      |
| フォーマット | CSV/TSV（プレビュー）、PDF（iframe 表示） | Excel 等は段階的追加        |
| AI           | Phase 5 で実装                            | Phase 5 で実装              |

## 2. 技術スタック（Phase 3a 追加分）

| カテゴリ             | 技術                                  | 備考                                        |
| -------------------- | ------------------------------------- | ------------------------------------------- |
| 検索エンジン         | OpenSearch 3.x                        | Docker Compose（profiles: search）          |
| 検索クライアント     | @opensearch-project/opensearch ^3.0.0 | インストール済み                            |
| 日本語解析           | kuromoji プラグイン                   | OpenSearch 3.x に標準バンドル               |
| CSV パース           | PapaParse 5.x                         | インストール済み（PreviewService で使用中） |
| エンコーディング検出 | encoding-japanese 2.x                 | インストール済み（PreviewService で使用中） |

## 3. アーキテクチャ概要

### 処理フロー

```
[ブラウザ]
  │
  ├─ POST /api/v1/packages/:packageId/resources
  │    → リソースレコード作成
  │    ← { id, ... }
  │
  │  === Presigned URL フロー（ファイルアップロード）===
  │
  ├─ POST /api/v1/resources/:id/upload-url
  │    → prepareForUpload（urlType='upload' に更新）+ Presigned PUT URL 発行
  │    ← { upload_url }
  │
  ├─ PUT upload_url  ──→  [S3 / MinIO]
  │    → ファイル直接アップロード
  │
  ├─ POST /api/v1/resources/:id/upload-complete
  │    → size/hash 更新 → resource_pipeline 作成 → キュー投入
  │    ← { pipeline_status: 'queued', job_id }
  │
  │  === サーバーサイドアップロード ===
  │
  ├─ POST /api/v1/resources/:id/upload  (multipart)
  │    → prepareForUpload + Storage 書き込み → resource_pipeline 作成 → キュー投入
  │    ← { pipeline_status: 'queued', job_id }
  │
  │  === 外部 URL リソース ===
  │
  ├─ POST /api/v1/packages/:packageId/resources  { url: "https://..." }
  │  or PUT /api/v1/resources/:id                 { url: "https://..." }（URL 変更時）
  │    → リソース作成/更新 → resource_pipeline 作成 → キュー投入
  │    ※ パイプライン内で外部 URL からダウンロード（10MB 上限）
  │
  │  ┌─────── InProcessQueue ────────────┐
  │  │ processResource(resourceId)              │
  │  │  1. Fetch    (ファイル取得)              │
  │  │  2. Extract  (CSV/TSV パース → Parquet)  │
  │  │  3. Index    (OpenSearch 更新)            │
  │  └────────────────────────────────────────┘
  │
  ├─ GET /api/v1/resources/:id/pipeline-status
  │    ← { status: 'complete', steps: [...] }
  │
  └─ GET /api/v1/resources/:id/preview
       ← Parquet (Range Read 対応)
```

## 4. Step 2: Docker Compose + OpenSearchAdapter ✅

### 4.1 Docker Compose 追加

`docker/compose.yml` に以下を追加:

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

起動: `docker compose --profile search up -d`

### 4.2 OpenSearchAdapter

`packages/adapters/search/src/opensearch.ts`（スタブ → 本実装）

```typescript
export class OpenSearchAdapter implements SearchAdapter {
  constructor(config: OpenSearchConfig)
  async ensureIndex(): Promise<void> // kuromoji マッピング付きインデックス作成
  async index(doc: DatasetDoc): Promise<void>
  async search(query: SearchQuery): Promise<SearchResult>
  async delete(id: string): Promise<void>
  async bulkIndex(docs: DatasetDoc[]): Promise<void>
}
```

**インデックスマッピング**:

- `title`: kuromoji_analyzer + keyword サブフィールド
- `notes`: kuromoji_analyzer
- `name`, `tags`, `organization`: keyword
- `resources`: nested 型（リソースメタデータ検索用）
  - `resources.name`: kuromoji_analyzer + keyword サブフィールド
  - `resources.description`: kuromoji_analyzer
  - `resources.id`: keyword
  - `resources.format`: keyword
- `created`, `updated`: date

**検索クエリ**:

- `bool.should` で dataset-level `multi_match`（`title^3`, `name^2`, `notes`, `tags`）+ nested resource `multi_match`（`resources.name^2`, `resources.description`）
- nested クエリに `inner_hits: { size: MAX_MATCHED_RESOURCES_PER_PACKAGE }` でマッチしたリソースを返却
- `bool.filter` for organization, tags（スコアリング影響なし、ADR-013 準拠）

**リソースメタデータ検索（Step 2b で実装済み）**:

- PostgresSearchAdapter: EXISTS サブクエリで resource.name/description を ILIKE 検索
- PackageService.list(): `q` パラメータ指定時に同じ EXISTS サブクエリ + `matchedResources` をバッチ取得
- pg_trgm GIN インデックスを `resource.name` と `resource.description` にも追加
- パッケージごとのマッチリソース上限: `MAX_MATCHED_RESOURCES_PER_PACKAGE`（1000件、`@kukan/shared`で定義）
- フロントエンドの DatasetCard にマッチしたリソースをインデント付きサブアイテムとして表示

### 4.3 アダプターファクトリ更新

- `createAdapters()` を **async** に変更（`ensureIndex()` 呼び出しのため）
- `packages/api/src/app.ts`: `await createAdapters(env, db)`

## 5. Step 3: ファイルアップロード API ✅

### 5.1 StorageAdapter 拡張

`adapter.ts` に `getSignedUploadUrl` を追加（実装済み）:

```typescript
export interface SignedUrlOptions {
  expiresIn?: number
  inline?: boolean      // Content-Disposition: inline（PDF プレビュー等）
  contentType?: string  // Response Content-Type 指定
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

| 実装                       | 方式                                                                |
| -------------------------- | ------------------------------------------------------------------- |
| S3CompatibleStorageAdapter | `@aws-sdk/s3-request-presigner` の `getSignedUrl(PutObjectCommand)` |
| LocalStorageAdapter        | `local://{key}` センチネル URL                                      |

※ 旧 `MinIOStorageAdapter`（minio パッケージ）と `S3StorageAdapter` は `S3CompatibleStorageAdapter`（`@aws-sdk/client-s3` ベース）に統合済み。`STORAGE_TYPE` は `'s3' | 'local'` の 2 値。`S3_ENDPOINT` の有無で MinIO / AWS S3 を自動判別。

### 5.2 API エンドポイント

| メソッド | パス                                    | 認証        | 概要                                          |
| -------- | --------------------------------------- | ----------- | --------------------------------------------- |
| POST     | `/api/v1/resources/:id/upload-url`      | org editor+ | Presigned URL 発行（新規・差替共通）          |
| POST     | `/api/v1/resources/:id/upload-complete` | org editor+ | アップロード完了通知 → キューイング           |
| POST     | `/api/v1/resources/:id/upload`          | org editor+ | サーバーサイドアップロード（新規・差替共通）  |
| GET      | `/api/v1/resources/:id/pipeline-status` | public      | 処理状態取得                                  |
| GET      | `/api/v1/resources/:id/download-url`    | public      | ダウンロード URL 取得（presigned）            |
| GET      | `/api/v1/resources/:id/preview-url`     | public      | プレビュー URL 取得（ADR-015 参照）           |
| GET      | `/api/v1/resources/:id/raw`             | public      | 生テキストプレビュー取得（先頭 5MB）          |
| POST     | `/api/v1/resources/:id/run-pipeline`    | org editor+ | 手動パイプライン再実行                        |
| GET      | `/api/v1/resources/formats`             | public      | 登録済みフォーマット一覧                      |

### 5.3 ストレージキー規則

```
resources/{package_id}/{resource_id}
previews/{package_id}/{resource_id}.parquet
```

### 5.4 ResourceService 拡張（実装済み）

```typescript
class ResourceService {
  // ... 既存メソッド ...

  /** urlType='upload' に設定。format はファイル名拡張子から推定 */
  async prepareForUpload(
    id: string,
    input: { filename: string; contentType: string; format?: string },
    existing?: Resource
  ): Promise<Resource>

  /** アップロード完了後の size / hash メタデータ更新 */
  async updateAfterUpload(id: string, input: { size?: number; hash?: string }): Promise<Resource>
}

/** storageKey は DB カラムではなく都度算出 */
function getStorageKey(packageId: string, resourceId: string): string {
  return `resources/${packageId}/${resourceId}`
}
```

### 5.5 共有型

```typescript
// packages/shared/src/adapter-types.ts
export type PipelineStatus = 'pending' | 'queued' | 'processing' | 'complete' | 'error'
```

## 6. Step 4: DB スキーマ変更 + リソース処理パイプライン

### 6.1 DB スキーマ変更

#### resource テーブルから処理関連フィールドを分離

`resource` テーブルをリソースの**メタデータのみ**に限定し、処理状態は専用テーブルに移行する。
これにより `resource.updated` がユーザー操作（名前・URL 変更等）のみを反映し、パイプライン処理の影響を受けなくなる。

**resource テーブルから削除するカラム**:

- `preview_key`
- `ingest_status`
- `ingest_error`
- `ingest_metadata`
- `ai_schema`
- `pii_check`
- `content_hash`
- `health_status`（残す。Quality Monitor 実装時に再検討）
- `health_checked_at`（同上）
- `quality_issues`（同上）

**新規テーブル: `resource_pipeline`**（resource と 1:1）

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

**新規テーブル: `resource_pipeline_step`**（resource_pipeline と N:1）

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

**ステータス値**:

- `resource_pipeline.status`: `'pending'` | `'queued'` | `'processing'` | `'complete'` | `'error'`
- `resource_pipeline_step.status`: `'pending'` | `'running'` | `'complete'` | `'error'` | `'skipped'`

#### ResourceService 変更

- `updateIngestStatus()` → 削除。`ResourcePipelineService` に移行
- `prepareForUpload()` → `ingestStatus`/`ingestError` 設定を除去（処理状態は resource_pipeline で管理）

### 6.2 パイプラインのトリガー

| イベント                  | urlType    | 動作                                      |
| ------------------------- | ---------- | ----------------------------------------- |
| `upload-complete` API     | `'upload'` | `resource_pipeline` 作成 → キュー投入     |
| `upload` API（multipart） | `'upload'` | 同上                                      |
| リソース作成（url 指定）  | `null`     | `resource_pipeline` 作成 → キュー投入     |
| リソース更新（url 変更）  | `null`     | `resource_pipeline` リセット → キュー投入 |

### 6.3 パッケージ構成

```
packages/pipeline/
├── package.json            # @kukan/pipeline
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── process-resource.ts # パイプラインオーケストレータ
│   ├── pipeline-service.ts # ResourcePipelineService（状態管理）
│   ├── types.ts            # PipelineContext, ResourceForPipeline 等
│   ├── steps/
│   │   ├── fetch.ts        # ファイル取得（Storage or 外部 URL）
│   │   ├── extract.ts      # CSV/TSV パース → Parquet 生成 → Storage 保存
│   │   └── index-search.ts # SearchAdapter.index() + DB 更新
│   └── parsers/
│       └── csv-parser.ts   # スマート CSV パーサー（PapaParse + encoding-japanese）
```

### 6.4 PipelineContext

`PipelineContext` はアダプターと DB アクセサメソッドを提供する。DB を直接公開せず、パイプラインが必要とするクエリをアクセサ関数として定義する。

```typescript
interface PipelineContext {
  storage: StorageAdapter
  search: SearchAdapter
  getResource(id: string): Promise<ResourceForPipeline | null>
  updateResourceHash(id: string, hash: string): Promise<void>
  getPackageForIndex(packageId: string): Promise<PackageForIndex | null>
}
```

`PipelineContext` の組み立ては `packages/api/src/queue/pipeline-handler.ts` の `buildPipelineContext()` で行う。アクセサは Drizzle ORM クエリで直接実装。

### 6.5 パイプラインステップ

| Step | 名前        | 入力                            | 出力                                 | 備考                                                                  |
| ---- | ----------- | ------------------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| 1    | **Fetch**   | resourceId                      | storageKey, format, packageId        | upload: skip、外部 URL: Storage に直接ストリーム（10MB 上限）、hash 計算 |
| 2    | **Extract** | resourceId, packageId, storageKey, format | previewKey, encoding               | CSV/TSV → Worker Thread で Parquet 変換。非対応は skip。非クリティカル |
| 3    | **Index**   | resourceId                      | OpenSearch ドキュメント更新          | 常に実行                                                              |

**ステップの独立性**: Extract が失敗しても Index は実行する（`nonCritical` フラグ）。各ステップの成功/失敗は `resource_pipeline_step` に記録。

### 6.6 processResource()

```typescript
async function processResource(
  resourceId: string,
  ctx: PipelineContext,
  db: Database // パイプライン状態管理用
): Promise<void> {
  const pipelineService = new ResourcePipelineService(db)
  const pipeline = await pipelineService.startPipeline(resourceId)
  if (!pipeline) throw new Error(`No pipeline record found for resource ${resourceId}`)

  try {
    // Step 1: Fetch — 外部 URL は Storage に直接ストリーム、upload 済みは skip
    const fetchResult = await runStep(pipelineService, pipeline.id, 'fetch', () =>
      fetchStep(resourceId, ctx)
    )

    if (fetchResult) {
      // Step 2: Extract — CSV/TSV パース → Worker Thread で Parquet 変換 → Storage 保存（非クリティカル）
      const extractResult = await runStep(
        pipelineService,
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
        true // nonCritical: エラーでも Index に進む
      )

      if (extractResult) {
        await pipelineService.updatePreviewKey(pipeline.id, extractResult.previewKey)
        await pipelineService.updateMetadata(pipeline.id, { encoding: extractResult.encoding })
      }
    }

    // Step 3: Index — OpenSearch 更新（常に実行）
    await runStep(pipelineService, pipeline.id, 'index', () => indexSearchStep(resourceId, ctx))

    await pipelineService.updateStatus(pipeline.id, 'complete')
  } catch (err) {
    await pipelineService.updateStatus(pipeline.id, 'error', (err as Error).message)
  }
}

/** 各ステップを実行し、結果を resource_pipeline_step に記録 */
async function runStep<T>(
  pipelineService: ResourcePipelineService,
  pipelineId: string,
  stepName: PipelineStepName,
  fn: () => Promise<T>,
  nonCritical = false
): Promise<T | null> {
  const stepId = await pipelineService.startStep(pipelineId, stepName)
  try {
    const result = await fn()
    if (result === null) {
      await pipelineService.skipStep(stepId)
      return null
    }
    await pipelineService.completeStep(stepId)
    return result
  } catch (err) {
    await pipelineService.failStep(stepId, (err as Error).message)
    if (nonCritical) return null
    throw err
  }
}
```

### 6.7 Fetch ステップ

外部 URL リソースを Storage に直接ストリーミングする。upload 済みリソースは Storage にファイルがあるため skip。
一時ファイルは使わず、Storage に直接書き込む。

```typescript
interface FetchResult {
  storageKey: string
  format: string | null
  packageId: string
}

async function fetchStep(
  resourceId: string,
  ctx: PipelineContext
): Promise<FetchResult | null> {
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

const MAX_EXTERNAL_DOWNLOAD_SIZE = 10 * 1024 * 1024 // 10MB
```

### 6.8 CSV スマートパーサー

Phase 3a スコープ（CSV/TSV のみ）:

- PapaParse でパース
- **ヘッダー行検出**: タイトル行（単一セルのみ非空）をスキップ
- **フッター検出**: 「合計」「注」「※」「出典」「備考」等で始まる行を除外
- **エンコーディング検出**: encoding-japanese で自動検出、UTF-8 に変換
- 非対応フォーマットは Extract/Preview をスキップ（Index のみ実行）

### 6.9 プレビューデータ（Parquet 形式）

Extract ステップで CSV/TSV をパースし、全行を Parquet 形式で Storage に保存する（ADR-014 参照）。

- **ライブラリ**: `hyparquet-writer`（サーバー側書き込み）、`hyparquet`（ブラウザ側読み取り）
- **圧縮**: SNAPPY（hyparquet-writer デフォルト。hyparquet がブラウザ側で Snappy 解凍対応）
- **Row Group サイズ**: 5,000 行
- **列型**: 全列 STRING

Storage キー: `previews/{packageId}/{resourceId}.parquet`

フロントエンドは `hyparquet` の `asyncBufferFromUrl()` + `parquetReadObjects({ rowStart, rowEnd })` で Range ベースページネーションを行う。

## 7. Step 5: InProcessQueue 統合

### 7.1 キューハンドラ登録

`packages/api/src/app.ts` の `createApp()` 内でハンドラ登録:

```typescript
import { registerPipelineHandler } from './queue/pipeline-handler'

// createAdapters() の直後
await registerPipelineHandler(db, adapters.queue, adapters.storage, adapters.search)
```

`pipeline-handler.ts` は `buildPipelineContext()` で PipelineContext を組み立て、`processResource()` を呼ぶ:

```typescript
await queue.process<{ resourceId: string }>(
  PIPELINE_JOB_TYPE,
  async (job: Job<{ resourceId: string }>) => {
    const ctx = buildPipelineContext(db, storage, search)
    await processResource(job.data.resourceId, ctx, db)
  }
)
```

### 7.2 プレビュー URL

統一 `preview-url` エンドポイント（ADR-015）がフォーマットに応じて適切な URL を返す:
- CSV/TSV: `resource_pipeline.preview_key` から Parquet ファイルの presigned URL
- PDF: 元ファイルの presigned URL（inline disposition 付き）
- その他: `null`

### 7.3 リソース CRUD と処理トリガーの統合

リソース作成 API（url 指定時）およびリソース更新 API（url 変更時）に処理キュー投入を追加:

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

## 8. Step 6: フロントエンド拡張

### 8.1 新規コンポーネント

| コンポーネント              | 概要                                                                          |
| --------------------------- | ----------------------------------------------------------------------------- |
| `file-upload.tsx`           | ドラッグ＆ドロップ + ファイル選択、アップロード進捗、処理ステータスポーリング |
| `pipeline-status-badge.tsx` | pending/queued/processing/complete/error 状態バッジ                           |

### 8.2 既存ページ更新

- **Dataset 編集ページ**: FileUpload コンポーネント追加
- **Dataset 詳細ページ**: 各リソースに PipelineStatusBadge 表示
- **Resource 詳細ページ**: 処理状態 + ステップ詳細 + プレビュー表示

### 8.3 i18n

`ja.json` / `en.json` にアップロード・処理関連の翻訳キー追加

## 9. テスト戦略

| 対象                      | テスト種別                           | ツール                   |
| ------------------------- | ------------------------------------ | ------------------------ |
| OpenSearchAdapter         | ユニット（Client モック）            | Vitest                   |
| CSV スマートパーサー      | ユニット（フィクスチャ CSV）         | Vitest                   |
| パイプライン各ステップ    | ユニット（Storage/DB/Search モック） | Vitest                   |
| processResource           | 統合（全ステップ、モック）           | Vitest                   |
| Upload API エンドポイント | 統合（テスト DB + LocalStorage）     | Vitest                   |
| フロントエンド            | コンポーネント                       | Vitest + Testing Library |

## 10. 実装順序

### Step 1: 実装仕様書 ✅

本ドキュメント

### Step 2: Docker Compose + OpenSearchAdapter ✅

1. ~~`docker/compose.yml` に OpenSearch 3.x + Dashboards 追加（profiles: search）~~
2. ~~`packages/adapters/search/src/opensearch.ts` 実装（kuromoji + nested resources）~~
3. ~~`packages/api/src/adapters.ts` — `createAdapters` を async 化~~
4. ~~`packages/api/src/app.ts` — await 対応~~
5. ~~`.env.example` 更新~~
6. ~~テスト~~
7. ~~CLAUDE.md の OpenSearch バージョン更新（2.x → 3.x）~~

### Step 3: ファイルアップロード API ✅

1. ~~StorageAdapter 統合: `minio.ts` + `s3.ts` → `S3CompatibleStorageAdapter`（`@aws-sdk/client-s3` ベース）~~
2. ~~`adapter.ts` に `getSignedUploadUrl` 追加、`LocalStorageAdapter` にセンチネル URL 実装~~
3. ~~`STORAGE_TYPE` 簡素化: `'s3' | 'minio' | 'local'` → `'s3' | 'local'`~~
4. ~~`packages/shared/src/adapter-types.ts` — `PipelineStatus` 型追加~~
5. ~~`packages/shared/src/validators/resource.ts` — `uploadUrlSchema`, `uploadCompleteSchema` 追加~~
6. ~~`resource-service.ts` — `prepareForUpload`, `updateAfterUpload`, `getStorageKey` 追加~~
7. ~~`resources.ts` — 5 エンドポイント追加（upload-url, upload, upload-complete, pipeline-status, download-url, formats）~~
8. ~~テスト: ユニット 12 件、バリデーション 15 件、統合 17 件~~
9. ~~PDF プレビュー: `ResourcePreview` コンポーネント（CSV/TSV + PDF 対応）、`download-url` エンドポイント、`useFetch` フック~~
10. ~~TSV フォーマット対応: `preview-service.ts` の `isCsvFormat()` に TSV 追加~~

### Step 4: DB スキーマ変更 + リソース処理パイプライン ✅

1. ~~DB マイグレーション: `resource_pipeline` + `resource_pipeline_step` テーブル作成、resource テーブルから処理フィールド削除~~
2. ~~`ResourcePipelineService` 作成（CRUD + ステップ管理）~~
3. ~~`ResourceService` から `updateIngestStatus` 削除、`prepareForUpload` から `updated` 更新除去~~
4. ~~既存 API ルート更新（`ingest-status` → `pipeline-status`、レスポンス形式変更）~~
5. ~~`packages/pipeline/` パッケージセットアップ~~
6. ~~型定義（types.ts — PipelineContext にアクセサメソッド方式採用）~~
7. ~~Fetch ステップ（Storage + 外部 URL、10MB 上限、hash 計算）~~
8. ~~CSV スマートパーサー（csv-parser.ts — PapaParse + encoding-japanese）~~
9. ~~Extract ステップ（CSV パース → Parquet 生成 → Storage 保存、ADR-014）~~
10. ~~Index ステップ（SearchAdapter.index() 呼び出し）~~
11. ~~processResource オーケストレータ（3 ステップ、nonCritical フラグ）~~
12. ~~`IngestStatus` → `PipelineStatus` リネーム（shared, API, テスト）~~
13. ~~テスト（fetch, csv-parser, process-resource, pipeline-service, pipeline-handler）~~

### Step 5: InProcessQueue 統合 ✅

1. ~~`packages/api/src/queue/pipeline-handler.ts` — キューハンドラ登録 + PipelineContext 組み立て~~
2. ~~`packages/api/src/app.ts` — `registerPipelineHandler()` 呼び出し追加~~
3. ~~リソース CRUD に処理トリガー追加（upload-complete, url 指定時の作成 / url 変更時の更新）~~
4. ~~`POST /api/v1/resources/:id/run-pipeline` — 手動パイプライン実行エンドポイント追加~~
5. ~~E2E 動作確認（外部 CSV URL → fetch/extract/index → Parquet in MinIO）~~

### Step 6: フロントエンド拡張 ✅

1. ~~`FileUploadZone` コンポーネント（ドラッグ＆ドロップ + presigned URL アップロード + 進捗表示）~~
2. ~~`PipelineStatusBadge` コンポーネント（ポーリングによる自動更新）~~
3. ~~`useFileUpload`, `usePipelineStatus`, `useParquetPreview` カスタムフック~~
4. ~~リソースフォーム統合: create/edit を `ResourceList` 内のインラインフォームに統一~~
5. ~~`ResourceFormFields` 共有コンポーネント（Name, Source tabs, Description, Format）~~
6. ~~`ResourcePreview` 改善: 統一 `preview-url` エンドポイント使用（ADR-015）~~
7. ~~テーブル表示 / テキスト表示の切替タブ（Badge ベース）~~
8. ~~PDF プレビュー（iframe, inline disposition）~~
9. ~~i18n（ja.json / en.json）~~
10. ~~テスト~~

## 11. 完了基準

- [x] `docker compose --profile search up` で OpenSearch 3.x 起動（Step 2）
- [x] `SEARCH_TYPE=opensearch pnpm dev` でアプリ起動（Step 2）
- [x] OpenSearch 経由で検索結果が返る（Step 2）
- [x] PostgreSQL フォールバック検索も引き続き動作（Step 2）
- [x] ファイルアップロード API エンドポイント動作（Step 3）
- [x] S3CompatibleStorageAdapter で MinIO / AWS S3 統合（Step 3）
- [x] `resource_pipeline` / `resource_pipeline_step` テーブル動作（Step 4）
- [x] CSV ファイルアップロード → 処理完了 → Parquet プレビュー生成（Step 4-5）
- [x] 外部 URL リソース → 処理完了 → Parquet プレビュー生成（Step 4-5）
- [x] 各ステップの成功/失敗が `resource_pipeline_step` に記録される（Step 4）
- [x] フロントエンドにアップロード UI + 処理ステータス表示（Step 6）
- [x] `pnpm typecheck` 成功
- [x] `pnpm test` 全テスト合格（52 files, 521 tests）
- [x] `pnpm lint && pnpm format` 通過
