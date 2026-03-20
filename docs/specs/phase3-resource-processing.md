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

| 項目         | Phase 3a（本仕様書）                     | Phase 3b（別途）           |
| ------------ | ---------------------------------------- | -------------------------- |
| スコープ     | 開発環境で E2E 動作                      | AWS 本番基盤               |
| ストレージ   | S3CompatibleStorageAdapter（MinIO 接続） | 同アダプター（AWS S3 接続）|
| キュー       | InProcessQueue（既存）                   | SQSQueueAdapter + Worker   |
| 検索         | OpenSearch（Docker）                     | AWS OpenSearch Service     |
| フォーマット | CSV/TSV（プレビュー）、PDF（iframe 表示）| Excel 等は段階的追加       |
| AI           | Phase 5 で実装                           | Phase 5 で実装             |

## 2. 技術スタック（Phase 3a 追加分）

| カテゴリ             | 技術                                  | 備考                                        |
| -------------------- | ------------------------------------- | ------------------------------------------- |
| 検索エンジン         | OpenSearch 3.x                        | Docker Compose（profiles: search）          |
| 検索クライアント     | @opensearch-project/opensearch ^3.0.0 | インストール済み                            |
| 日本語解析           | kuromoji プラグイン                    | OpenSearch 3.x に標準バンドル               |
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
  │    → size/hash 更新 → resource_processing 作成 → キュー投入
  │    ← { processing_status: 'queued', job_id }
  │
  │  === サーバーサイドアップロード ===
  │
  ├─ POST /api/v1/resources/:id/upload  (multipart)
  │    → prepareForUpload + Storage 書き込み → resource_processing 作成 → キュー投入
  │    ← { processing_status: 'queued', job_id }
  │
  │  === 外部 URL リソース ===
  │
  ├─ POST /api/v1/packages/:packageId/resources  { url: "https://..." }
  │  or PUT /api/v1/resources/:id                 { url: "https://..." }（URL 変更時）
  │    → リソース作成/更新 → resource_processing 作成 → キュー投入
  │    ※ パイプライン内で外部 URL からダウンロード（10MB 上限）
  │
  │  ┌─────── InProcessQueue ────────────┐
  │  │ processResource(resourceId)       │
  │  │  1. Fetch    (ファイル取得)       │
  │  │  2. Extract  (CSV/TSV パース)     │
  │  │  3. Preview  (JSON → Storage)     │
  │  │  4. Index    (OpenSearch 更新)     │
  │  └──────────────────────────────────┘
  │
  ├─ GET /api/v1/resources/:id/processing-status
  │    ← { status: 'complete', steps: [...] }
  │
  └─ GET /api/v1/resources/:id/preview
       ← PreviewData JSON
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
export interface StorageAdapter {
  upload(key: string, body: Buffer | Readable, meta?: ObjectMeta): Promise<void>
  download(key: string): Promise<Readable>
  delete(key: string): Promise<void>
  getSignedUrl(key: string, expiresIn?: number): Promise<string>
  getSignedUploadUrl(key: string, contentType: string, expiresIn?: number, meta?: ObjectMeta): Promise<string>
}
```

| 実装                        | 方式                                                       |
| --------------------------- | ---------------------------------------------------------- |
| S3CompatibleStorageAdapter  | `@aws-sdk/s3-request-presigner` の `getSignedUrl(PutObjectCommand)` |
| LocalStorageAdapter         | `local://{key}` センチネル URL                             |

※ 旧 `MinIOStorageAdapter`（minio パッケージ）と `S3StorageAdapter` は `S3CompatibleStorageAdapter`（`@aws-sdk/client-s3` ベース）に統合済み。`STORAGE_TYPE` は `'s3' | 'local'` の 2 値。`S3_ENDPOINT` の有無で MinIO / AWS S3 を自動判別。

### 5.2 API エンドポイント

| メソッド | パス                                    | 認証        | 概要                                         |
| -------- | --------------------------------------- | ----------- | -------------------------------------------- |
| POST     | `/api/v1/resources/:id/upload-url`      | org editor+ | Presigned URL 発行（新規・差替共通）         |
| POST     | `/api/v1/resources/:id/upload-complete` | org editor+ | アップロード完了通知 → キューイング          |
| POST     | `/api/v1/resources/:id/upload`          | org editor+ | サーバーサイドアップロード（新規・差替共通） |
| GET      | `/api/v1/resources/:id/processing-status` | public    | 処理状態取得                                 |
| GET      | `/api/v1/resources/:id/download-url`    | public      | ダウンロード URL 取得（presigned / 外部 URL） |

### 5.3 ストレージキー規則

```
resources/{package_id}/{resource_id}
previews/{resource_id}.json
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
export type ProcessingStatus = 'pending' | 'queued' | 'processing' | 'complete' | 'error'
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

**新規テーブル: `resource_processing`**（resource と 1:1）

```sql
CREATE TABLE resource_processing (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id   UUID NOT NULL UNIQUE REFERENCES resource(id) ON DELETE CASCADE,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending',
  error         TEXT,
  content_hash  TEXT,
  preview_key   TEXT,
  metadata      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_resource_processing_resource ON resource_processing(resource_id);
CREATE INDEX idx_resource_processing_status ON resource_processing(status);
```

**新規テーブル: `resource_processing_step`**（resource_processing と N:1）

```sql
CREATE TABLE resource_processing_step (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  processing_id   UUID NOT NULL REFERENCES resource_processing(id) ON DELETE CASCADE,
  step_name       VARCHAR(50) NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  error           TEXT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_processing_step_processing ON resource_processing_step(processing_id);
```

**ステータス値**:

- `resource_processing.status`: `'pending'` | `'queued'` | `'processing'` | `'complete'` | `'error'`
- `resource_processing_step.status`: `'pending'` | `'running'` | `'complete'` | `'error'` | `'skipped'`

#### ResourceService 変更

- `updateIngestStatus()` → 削除。`ResourceProcessingService` に移行
- `prepareForUpload()` → `updated: sql'NOW()'` を除去（処理状態は resource_processing で管理）

### 6.2 パイプラインのトリガー

| イベント | urlType | 動作 |
|----------|---------|------|
| `upload-complete` API | `'upload'` | `resource_processing` 作成 → キュー投入 |
| `upload` API（multipart）| `'upload'` | 同上 |
| リソース作成（url 指定）| `null` | `resource_processing` 作成 → キュー投入 |
| リソース更新（url 変更）| `null` | `resource_processing` リセット → キュー投入 |

### 6.3 パッケージ構成

```
packages/pipeline/
├── package.json            # @kukan/pipeline
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── process-resource.ts # パイプラインオーケストレータ
│   ├── types.ts            # ProcessingContext, ProcessingStep 等
│   ├── steps/
│   │   ├── fetch.ts        # ファイル取得（Storage or 外部 URL）
│   │   ├── extract.ts      # CSV/TSV パース
│   │   ├── preview.ts      # PreviewData JSON → Storage 保存
│   │   └── index-search.ts # SearchAdapter.index() + DB 更新
│   └── parsers/
│       └── csv-parser.ts   # スマート CSV パーサー
```

### 6.4 ProcessingContext

```typescript
interface ProcessingContext {
  db: Database
  storage: StorageAdapter
  search: SearchAdapter
}
```

### 6.5 パイプラインステップ

| Step | 名前          | 入力                                | 出力                                  | 備考                                           |
| ---- | ------------- | ----------------------------------- | ------------------------------------- | ---------------------------------------------- |
| 1    | **Fetch**     | resourceId                          | filePath（一時ファイル）, format      | upload: Storage、外部 URL: HTTP GET（10MB 上限）|
| 2    | **Extract**   | filePath, format                    | headers, rows, encoding               | CSV/TSV のみ。非対応フォーマットは skip         |
| 3    | **Preview**   | headers, rows, encoding             | previewKey（Storage に保存）          | Extract が skip なら skip                       |
| 4    | **Index**     | resource + package メタデータ       | OpenSearch ドキュメント更新            | 常に実行                                       |

**ステップの独立性**: Extract/Preview が失敗しても Index は実行する。各ステップの成功/失敗は `resource_processing_step` に記録。

### 6.6 processResource()

```typescript
async function processResource(resourceId: string, ctx: ProcessingContext): Promise<void> {
  const processing = await processingService.startProcessing(resourceId)

  let tmpFile: string | undefined
  try {
    // Step 1: Fetch — ファイルを一時ファイルに取得
    tmpFile = await runStep(processing.id, 'fetch', () =>
      fetchStep.execute(resourceId, ctx)
    )

    // Step 2: Extract — CSV/TSV パース（対応フォーマットのみ）
    const extracted = await runStep(processing.id, 'extract', () =>
      extractStep.execute(tmpFile, resource.format, ctx)
    )

    // Step 3: Preview — PreviewData JSON を Storage に保存
    if (extracted) {
      await runStep(processing.id, 'preview', () =>
        previewStep.execute(resourceId, extracted, ctx)
      )
    }

    // Step 4: Index — OpenSearch 更新（常に実行）
    await runStep(processing.id, 'index', () =>
      indexStep.execute(resourceId, ctx)
    )

    await processingService.updateStatus(processing.id, 'complete')
  } catch (err) {
    await processingService.updateStatus(processing.id, 'error', err.message)
  } finally {
    if (tmpFile) await fs.unlink(tmpFile).catch(() => {})
  }
}

/** 各ステップを実行し、結果を resource_processing_step に記録 */
async function runStep<T>(
  processingId: string,
  stepName: string,
  fn: () => Promise<T>
): Promise<T | null> {
  const stepId = await processingService.startStep(processingId, stepName)
  try {
    const result = await fn()
    await processingService.completeStep(stepId)
    return result
  } catch (err) {
    await processingService.failStep(stepId, err.message)
    throw err  // or return null for non-critical steps
  }
}
```

### 6.7 Fetch ステップ

```typescript
async function execute(resourceId: string, ctx: ProcessingContext): Promise<string> {
  const resource = await resourceService.getById(resourceId)
  const tmpPath = path.join(os.tmpdir(), `kukan-${resourceId}`)

  if (resource.urlType === 'upload') {
    // Storage からダウンロード
    const storageKey = getStorageKey(resource.packageId, resource.id)
    const stream = await ctx.storage.download(storageKey)
    await pipeline(stream, fs.createWriteStream(tmpPath))
  } else if (resource.url) {
    // 外部 URL からダウンロード（10MB 上限）
    await downloadWithLimit(resource.url, tmpPath, MAX_EXTERNAL_DOWNLOAD_SIZE)
    // content_hash を計算して差分検知に備える
    const hash = await computeFileHash(tmpPath)
    await processingService.updateContentHash(processing.id, hash)
  } else {
    throw new Error('Resource has no file or URL')
  }

  return tmpPath
}

const MAX_EXTERNAL_DOWNLOAD_SIZE = 10 * 1024 * 1024  // 10MB
```

### 6.8 CSV スマートパーサー

Phase 3a スコープ（CSV/TSV のみ）:

- PapaParse でパース
- **ヘッダー行検出**: タイトル行（単一セルのみ非空）をスキップ
- **フッター検出**: 「合計」「注」「※」「出典」「備考」等で始まる行を除外
- **エンコーディング検出**: encoding-japanese で自動検出、UTF-8 に変換
- 非対応フォーマットは Extract/Preview をスキップ（Index のみ実行）

### 6.9 PreviewData JSON

```typescript
interface StoredPreviewData {
  resource_id: string
  format: string
  generated_at: string
  encoding: string
  table: {
    headers: string[]
    rows: string[][] // 先頭 200 行
    total_rows: number
  }
}
```

Storage キー: `previews/{resource_id}.json`

## 7. Step 5: InProcessQueue 統合

### 7.1 キューハンドラ登録

`packages/api/src/app.ts` のアプリ起動時:

```typescript
const processingCtx: ProcessingContext = {
  db,
  storage: adapters.storage,
  search: adapters.search,
}
await adapters.queue.process<{ resourceId: string }>('resource-processing', async (job) => {
  await processResource(job.data.resourceId, processingCtx)
})
```

### 7.2 PreviewService 更新

`resource_processing.preview_key` がある場合、Storage から保存済み PreviewData を読み込み。
フォールバック: 既存のオンザフライ CSV パース（preview_key がない場合）。

### 7.3 リソース CRUD と処理トリガーの統合

リソース作成 API（url 指定時）およびリソース更新 API（url 変更時）に処理キュー投入を追加:

```typescript
// POST /api/v1/packages/:packageId/resources
if (input.url) {
  await processingService.enqueue(resource.id)
}

// PUT /api/v1/resources/:id
if (input.url && input.url !== existing.url) {
  await processingService.resetAndEnqueue(resource.id)
}
```

## 8. Step 6: フロントエンド拡張

### 8.1 新規コンポーネント

| コンポーネント                | 概要                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `file-upload.tsx`             | ドラッグ＆ドロップ + ファイル選択、アップロード進捗、処理ステータスポーリング |
| `processing-status-badge.tsx` | pending/queued/processing/complete/error 状態バッジ                              |

### 8.2 既存ページ更新

- **Dataset 編集ページ**: FileUpload コンポーネント追加
- **Dataset 詳細ページ**: 各リソースに ProcessingStatusBadge 表示
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
4. ~~`packages/shared/src/adapter-types.ts` — `ProcessingStatus` 型追加~~
5. ~~`packages/shared/src/validators/resource.ts` — `uploadUrlSchema`, `uploadCompleteSchema` 追加~~
6. ~~`resource-service.ts` — `prepareForUpload`, `updateAfterUpload`, `getStorageKey` 追加~~
7. ~~`resources.ts` — 5 エンドポイント追加（upload-url, upload, upload-complete, processing-status, download-url, formats）~~
8. ~~テスト: ユニット 12 件、バリデーション 15 件、統合 17 件~~
9. ~~PDF プレビュー: `ResourcePreview` コンポーネント（CSV/TSV + PDF 対応）、`download-url` エンドポイント、`useFetch` フック~~
10. ~~TSV フォーマット対応: `preview-service.ts` の `isCsvFormat()` に TSV 追加~~

### Step 4: DB スキーマ変更 + リソース処理パイプライン

1. DB マイグレーション: `resource_processing` + `resource_processing_step` テーブル作成、resource テーブルから処理フィールド削除
2. `ResourceProcessingService` 作成（CRUD + ステップ管理）
3. `ResourceService` から `updateIngestStatus` 削除、`prepareForUpload` から `updated` 更新除去
4. 既存 API ルート更新（`ingest-status` → `processing-status`、レスポンス形式変更）
5. `packages/pipeline/` パッケージセットアップ
6. 型定義（types.ts）
7. Fetch ステップ（Storage + 外部 URL、10MB 上限）
8. CSV スマートパーサー（csv-parser.ts）
9. Extract + Preview ステップ
10. Index ステップ
11. processResource オーケストレータ
12. `IngestStatus` → `ProcessingStatus` リネーム（shared, API, テスト）
13. テスト

### Step 5: InProcessQueue 統合

1. `packages/api/src/app.ts` — キューハンドラ登録（`resource-processing`）
2. `packages/api/src/services/preview-service.ts` — 保存済み PreviewData 対応
3. リソース CRUD に処理トリガー追加（url 指定時の作成 / url 変更時の更新）
4. E2E 動作確認

### Step 6: フロントエンド拡張

1. `file-upload.tsx` コンポーネント
2. `processing-status-badge.tsx` コンポーネント
3. 既存ページ更新
4. i18n
5. テスト

## 11. 完了基準

- [x] `docker compose --profile search up` で OpenSearch 3.x 起動（Step 2）
- [x] `SEARCH_TYPE=opensearch pnpm dev` でアプリ起動（Step 2）
- [x] OpenSearch 経由で検索結果が返る（Step 2）
- [x] PostgreSQL フォールバック検索も引き続き動作（Step 2）
- [x] ファイルアップロード API エンドポイント動作（Step 3）
- [x] S3CompatibleStorageAdapter で MinIO / AWS S3 統合（Step 3）
- [ ] `resource_processing` / `resource_processing_step` テーブル動作（Step 4）
- [ ] CSV ファイルアップロード → 処理完了 → プレビュー表示（Step 4-5）
- [ ] 外部 URL リソース → 処理完了 → プレビュー表示（Step 4-5）
- [ ] 各ステップの成功/失敗が `resource_processing_step` に記録される（Step 4）
- [ ] フロントエンドにアップロード UI + 処理ステータス表示（Step 6）
- [ ] `pnpm build` 成功
- [ ] `pnpm typecheck` 成功
- [ ] `pnpm test` 全テスト合格
- [ ] `pnpm lint && pnpm format` 通過
