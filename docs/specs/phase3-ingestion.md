# Phase 3a: Ingest & ファイルストレージ — 実装仕様書

> **目標**: ファイルアップロード（Presigned URL）、Ingest パイプライン（CSV/TSV）、OpenSearch 検索を実装し、開発環境（Docker Compose + InProcessQueue + MinIO）で E2E 動作する状態にする

## 1. 前提

- Phase 1 API 完成済み（CRUD + CKAN 互換 + 検索 + 認証）
- Phase 2 Frontend 完成済み（Next.js 15 カタログ UI + 管理画面）
- `resource` テーブルに Phase 3 カラム定義済み（urlType, ingestStatus, ingestError, previewKey 等）
- StorageAdapter / QueueAdapter / SearchAdapter インターフェース定義済み
- S3CompatibleStorageAdapter（MinIO / AWS S3 統合）, InProcessQueueAdapter, PostgresSearchAdapter 実装済み
- Docker Compose: PostgreSQL 16 + MinIO 動作済み

### Phase 3a vs Phase 3b

| 項目         | Phase 3a（本仕様書）                    | Phase 3b（別途）          |
| ------------ | --------------------------------------- | ------------------------- |
| スコープ     | 開発環境で E2E 動作                     | AWS 本番基盤              |
| ストレージ   | S3CompatibleStorageAdapter（MinIO 接続）| 同アダプター（AWS S3 接続）|
| キュー       | InProcessQueue（既存）                  | SQSQueueAdapter + Worker  |
| 検索         | OpenSearch（Docker）                    | AWS OpenSearch Service    |
| フォーマット | CSV/TSV                                 | PDF, Excel 等は段階的追加 |
| AI           | NoOp プレースホルダー                   | Phase 5 で実装            |

## 2. 技術スタック（Phase 3a 追加分）

| カテゴリ             | 技術                                  | 備考                                        |
| -------------------- | ------------------------------------- | ------------------------------------------- |
| 検索エンジン         | OpenSearch 3.x                        | Docker Compose（profiles: search）          |
| 検索クライアント     | @opensearch-project/opensearch ^3.0.0 | インストール済み                            |
| 日本語解析           | kuromoji プラグイン                   | OpenSearch 3.x に標準バンドル               |
| CSV パース           | PapaParse 5.x                         | インストール済み（PreviewService で使用中） |
| エンコーディング検出 | encoding-japanese 2.x                 | インストール済み（PreviewService で使用中） |

## 3. アーキテクチャ概要

### アップロード → Ingest フロー

```
[ブラウザ]
  │
  ├─ POST /api/v1/packages/:packageId/resources
  │    → リソースレコード作成（ingestStatus='pending'）
  │    ← { id, ... }
  │
  │  === Presigned URL フロー ===
  │
  ├─ POST /api/v1/resources/:id/upload-url
  │    → prepareForUpload（urlType='upload' に更新）+ Presigned PUT URL 発行
  │    ← { upload_url }
  │    ※ storageKey は `getStorageKey(packageId, resourceId)` で都度算出
  │
  ├─ PUT upload_url  ──→  [S3 / MinIO]
  │    → ファイル直接アップロード
  │
  ├─ POST /api/v1/resources/:id/upload-complete
  │    → size/hash 更新 → InProcessQueue にジョブ投入
  │    ← { ingest_status: 'queued', job_id }
  │
  │  === または サーバーサイドアップロード ===
  │
  ├─ POST /api/v1/resources/:id/upload  (multipart)
  │    → prepareForUpload + Storage 書き込み + size/hash 更新 + キュー投入
  │    ← { ingest_status: 'queued', job_id }
  │
  │  ┌─────── InProcessQueue ───────┐
  │  │ processResource(resourceId)  │
  │  │  1. Analyze  (format 判定)   │
  │  │  2. Extract  (CSV パース)    │
  │  │  3. Preview  (JSON → Storage)│
  │  │  4. AI       (NoOp)          │
  │  │  5. Index    (OpenSearch)    │
  │  └─────────────────────────────┘
  │
  ├─ GET /api/v1/resources/:id/ingest-status
  │    ← { ingest_status: 'complete' }
  │
  └─ GET /api/v1/resources/:id/preview
       ← PreviewData JSON
```

## 4. Step 2: Docker Compose + OpenSearchAdapter

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

## 5. Step 3: ファイルアップロード API

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
| GET      | `/api/v1/resources/:id/ingest-status`   | public      | Ingest 状態取得                              |

### 5.3 ストレージキー規則

```
resources/{package_id}/{resource_id}
previews/{resource_id}.json
```

### 5.4 ResourceService 拡張（実装済み）

```typescript
class ResourceService {
  // ... 既存メソッド ...

  /** urlType='upload' に設定し、ingestStatus をリセット。format はファイル名拡張子から推定 */
  async prepareForUpload(
    id: string,
    input: { filename: string; contentType: string; format?: string },
    existing?: Resource
  ): Promise<Resource>

  /** ingestStatus を更新（error 時は ingestError も設定） */
  async updateIngestStatus(id: string, status: IngestStatus, error?: string): Promise<Resource>

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
export type IngestStatus = 'pending' | 'queued' | 'processing' | 'complete' | 'error'
```

## 6. Step 4: Ingest パイプライン

### 6.1 パッケージ構成

```
packages/pipeline/
├── package.json            # @kukan/pipeline
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── process-resource.ts # パイプラインオーケストレータ
│   ├── types.ts            # PipelineContext, IngestStep 等
│   ├── steps/
│   │   ├── analyze.ts      # format 判定、processingPlan 決定
│   │   ├── extract.ts      # Storage → ダウンロード → CSV パース
│   │   ├── preview.ts      # PreviewData JSON → Storage 保存
│   │   ├── ai.ts           # NoOp（Phase 5 プレースホルダー）
│   │   └── search-index.ts # SearchAdapter.index() + DB 更新
│   └── parsers/
│       └── csv-parser.ts   # スマート CSV パーサー
```

### 6.2 PipelineContext

```typescript
interface PipelineContext {
  db: Database
  storage: StorageAdapter
  search: SearchAdapter
  ai: AIAdapter
}
```

### 6.3 パイプラインステップ

| Step | 名前    | 入力               | 出力                         | 重量     |
| ---- | ------- | ------------------ | ---------------------------- | -------- |
| 1    | Analyze | resourceId         | format, processingPlan       | 軽量     |
| 2    | Extract | packageId, resourceId, format | headers, rows, encoding      | 中〜重量 |
| 3    | Preview | headers, rows      | previewKey（Storage に保存） | 中量     |
| 4    | AI      | PreviewOutput      | aiSchema, piiCheck（null）   | NoOp     |
| 5    | Index   | 全データ           | SearchAdapter + DB 更新      | 軽量     |

### 6.4 processResource()

```typescript
async function processResource(resourceId: string, ctx: PipelineContext): Promise<void> {
  await updateIngestStatus(ctx.db, resourceId, 'processing')
  try {
    const analyzed = await analyzeStep.execute({ resourceId }, ctx)
    const extracted = await extractStep.execute(analyzed, ctx)
    const previewed = await previewStep.execute(extracted, ctx)
    const aiResult = await aiStep.execute(previewed, ctx)
    await searchIndexStep.execute(aiResult, ctx)
    await updateIngestStatus(ctx.db, resourceId, 'complete')
  } catch (err) {
    await updateIngestStatus(ctx.db, resourceId, 'error', err.message)
    throw err
  }
}
```

### 6.5 CSV スマートパーサー

Phase 3a スコープ（CSV/TSV のみ）:

- PapaParse でパース
- **ヘッダー行検出**: タイトル行（単一セルのみ非空）をスキップ
- **フッター検出**: 「合計」「注」「※」「出典」「備考」等で始まる行を除外
- **エンコーディング検出**: encoding-japanese で自動検出、UTF-8 に変換
- 他フォーマットは `processingPlan: 'skip'`（ファイル保存のみ、パース/プレビューなし）

### 6.6 PreviewData JSON

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
const pipelineCtx: PipelineContext = {
  db,
  storage: adapters.storage,
  search: adapters.search,
  ai: adapters.ai,
}
await adapters.queue.process<{ resourceId: string }>('ingest', async (job) => {
  await processResource(job.data.resourceId, pipelineCtx)
})
```

### 7.2 PreviewService 更新

`previewKey` がある場合、Storage から保存済み PreviewData を読み込み。
フォールバック: 既存のオンザフライ CSV パース（previewKey がない場合）。

## 8. Step 6: フロントエンド拡張

### 8.1 新規コンポーネント

| コンポーネント            | 概要                                                                             |
| ------------------------- | -------------------------------------------------------------------------------- |
| `file-upload.tsx`         | ドラッグ＆ドロップ + ファイル選択、アップロード進捗、Ingest ステータスポーリング |
| `ingest-status-badge.tsx` | pending/queued/processing/complete/error 状態バッジ                              |

### 8.2 既存ページ更新

- **Dataset 編集ページ**: FileUpload コンポーネント追加
- **Dataset 詳細ページ**: 各リソースに IngestStatusBadge 表示
- **Resource 詳細ページ**: Ingest 状態 + プレビュー表示

### 8.3 i18n

`ja.json` / `en.json` にアップロード・Ingest 関連の翻訳キー追加

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
4. ~~`packages/shared/src/adapter-types.ts` — `IngestStatus` 型追加~~
5. ~~`packages/shared/src/validators/resource.ts` — `uploadUrlSchema`, `uploadCompleteSchema` 追加~~
6. ~~`resource-service.ts` — `prepareForUpload`, `updateIngestStatus`, `updateAfterUpload`, `getStorageKey` 追加~~
7. ~~`resources.ts` — 4 エンドポイント追加（upload-url, upload, upload-complete, ingest-status, formats）~~
8. ~~テスト: ユニット 12 件、バリデーション 15 件、統合 17 件~~

### Step 4: Ingest パイプライン

1. `packages/pipeline/` パッケージセットアップ
2. 型定義（types.ts）
3. CSV スマートパーサー（csv-parser.ts）
4. 各ステップ実装（analyze → extract → preview → ai → search-index）
5. processResource オーケストレータ
6. テスト

### Step 5: InProcessQueue 統合

1. `packages/api/src/app.ts` — キューハンドラ登録
2. `packages/api/src/services/preview-service.ts` — 保存済み PreviewData 対応
3. E2E 動作確認

### Step 6: フロントエンド拡張

1. `file-upload.tsx` コンポーネント
2. `ingest-status-badge.tsx` コンポーネント
3. 既存ページ更新
4. i18n
5. テスト

## 11. 完了基準

- [x] `docker compose --profile search up` で OpenSearch 3.x 起動（Step 2）
- [x] `SEARCH_TYPE=opensearch pnpm dev` でアプリ起動（Step 2）
- [x] OpenSearch 経由で検索結果が返る（Step 2）
- [x] PostgreSQL フォールバック検索も引き続き動作（Step 2）
- [x] ファイルアップロード API 4 エンドポイント動作（Step 3）
- [x] S3CompatibleStorageAdapter でMinIO / AWS S3 統合（Step 3）
- [ ] CSV ファイルアップロード → Ingest 完了 → プレビュー表示（Step 4-5）
- [ ] フロントエンドにアップロード UI + Ingest ステータス表示（Step 6）
- [ ] `pnpm build` 成功
- [ ] `pnpm typecheck` 成功
- [ ] `pnpm test` 全テスト合格
- [ ] `pnpm lint && pnpm format` 通過
