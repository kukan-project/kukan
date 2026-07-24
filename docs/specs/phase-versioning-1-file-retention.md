# Phase Versioning-i: 正本バージョンファイル保持 & パージ — 実装仕様書

> **目標**: リソースの正本データを版として immutable 保持し（全フォーマット対象）、版の
> 一覧・取得・ダウンロードと、sysadmin による過去版パージ（法的削除）を実装する。
> DuckLake（行レベル差分）には依存せず、単独でリリース可能な最小の版管理基盤を作る。
> 設計判断は ADR-043 を正とする。

## 1. 前提

- Phase 3 完成済み（アップロード + Fetch → Extract → Index パイプライン + Worker + Queue）
- ADR-043 合意済み（提案 → 本仕様書で層1を確定）
- 現状のストレージ・DB の実体:
  - 正本ファイルは固定キー `resources/{packageId}/{resourceId}`（`getStorageKey()`）へ**上書き**保存
  - アップロードは presigned PUT で現行キーに 1 回書かれ、旧版は残らない
  - 外部 URL は Fetch ステップが現行キーへダウンロードし、`hash !== res.hash` のときのみ
    `resource.hash`/`size` を更新（[fetch.ts](../../apps/worker/src/pipeline/steps/fetch.ts)、既存のハッシュゲート）
  - `resource` テーブルに `hash`（`sha256:...`）/`size`/`urlType`（`upload` | 外部）/`state`
  - `resource_pipeline`（resource と 1:1）に `previewKey`/`metadata.schema`（最新版のみ、ADR-032）
  - `audit_log` テーブルあり（`entityType`/`entityId`/`action`/`userId`/`changes`）
  - StorageAdapter に `copy` は**無い**（`upload`/`download`/`delete`/`head`/`downloadRange`/`deleteByPrefix`/presigned）

## 2. ADR-043 からの実装上の精緻化

ADR §1-2「アップロード時に現行キーと版キーの両方へ書く」は、presigned PUT が現行キーへ
1 回しか書けないため**そのままでは実現できない**。代わりに次の方式を採る（本仕様書で確定）。

- **版の捕捉はアップロード時点ではなく Worker パイプラインの「Version ステップ」で行う。**
  Fetch でハッシュが確定した後、現行キーの内容を版キーへ**サーバーサイド copy** する。
- これはアップロード／外部 URL の両経路を Worker 側で一本化でき、fetch.ts の既存ハッシュゲートを
  そのまま版の契機に流用できる。
- **不変性の担保**: 版 vN のコピーは vN のパイプライン実行中（＝現行キーがまだ vN の内容を
  保持している間）に作られる。後続の v(N+1) アップロードが現行キーを上書きしても、
  既にできている `versions/.../vN` オブジェクトには影響しない。
- **既知の制約**: 版はパイプライン実行時点で捕捉される。パイプライン処理前に同一リソースへ
  連続アップロードした場合、中間版が捕捉されないことがある（許容。完了基準に明記）。

## 3. アーキテクチャ概要

```
層1（本仕様書）: 正本バージョンファイル（全フォーマット）
  現行キー   resources/{packageId}/{resourceId}         ← 最新版（既存経路は無変更）
  版キー     versions/{packageId}/{resourceId}/v{n}     ← immutable コピー
  台帳       resource_version テーブル

  === 版の捕捉（Worker）===
  [upload-complete / 外部URL] → Queue → processResource
    Fetch    現行キーへ確定（ハッシュ算出）
    Version  ← 新設。ハッシュが最新版と異なれば現行キー→版キーへ copy + resource_version 追加
    Extract  Parquet/スキーマ生成（最新版、既存）
    Index    コンテンツ検索投入（既存）

  === 版の参照（API）===
  GET  /resources/:id/versions              版一覧（可視性チェック）
  GET  /resources/:id/versions/:v           版メタ
  GET  /resources/:id/versions/:v/download  版ダウンロード（サーバー経由、ADR-017 踏襲）

  === パージ（API + Worker）===
  POST /resources/:id/versions/:v/purge     sysadmin 限定、理由必須
    → resource_version.state: active → purging → purged（非同期、ADR-028 パターン）
    → 版ファイル削除 + 派生物波及（層1完結。層2 は Phase ii で追加）
```

## 4. Step 1: DB スキーマ — `resource_version`

`packages/db/src/schema/resource-version.ts` を新設。

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

- `resource` への FK は `onDelete: 'cascade'`（リソース削除で版台帳も消える）。ただし**版ファイル
  本体（S3）と DuckLake は cascade で消えない** → リソース purge 側で明示的に掃除する（残課題、
  Phase ii のリソース purge 拡張で扱う。本フェーズはリソース delete=論理削除のため版ファイルは残置）。
- `ResourceSchema` は `@kukan/shared` の既存 Zod 型（ADR-032）を再利用。
- マイグレーションは Drizzle Kit（`pnpm db:generate`）。既存リソースへのバックフィルは**しない**
  （次回パイプライン実行時から版が付く。ADR-029/032 と同方針）。

## 5. Step 2: StorageAdapter に `copy` を追加

サーバーサイドコピー（S3 CopyObject / MinIO 同等）を追加し、Worker からバイト列を
ストリームせずに版キーを作れるようにする。

```typescript
// packages/adapters/storage/src/adapter.ts
export interface StorageAdapter {
  // ...既存...
  /** Server-side copy within the same bucket (no data streamed through the app). */
  copy(sourceKey: string, destKey: string): Promise<void>
}
```

- S3 実装: `CopyObjectCommand`（`CopySource = bucket/sourceKey`）。
- MinIO も S3 互換 `CopyObject` で同一実装。
- 版キー生成ヘルパを `@kukan/shared` に追加:
  ```typescript
  export function getVersionKey(packageId: string, resourceId: string, version: number): string {
    return `versions/${packageId}/${resourceId}/v${version}`
  }
  ```

## 6. Step 3: Version ステップ（Worker）

`apps/worker/src/pipeline/steps/version.ts` を新設し、`processResource` の **Extract 後**に挿入する
（スキーマスナップショットを版に載せられるように Extract 完了後に走らせる）。

### 6.1 ロジック

```
executeVersion(resourceId, packageId, currentStorageKey, hash, size, urlType, schema, ctx):
  latest = 最新の resource_version（resourceId, max(version), state != purged）
  if latest && latest.hash === hash:
    return { captured: false }          // 内容不変 → 版を作らない
  next = (latest?.version ?? 0) + 1
  versionKey = getVersionKey(packageId, resourceId, next)
  await ctx.storage.copy(currentStorageKey, versionKey)   // immutable コピー
  await ctx.insertResourceVersion({
    resourceId, version: next, storageKey: versionKey,
    size, hash, origin: urlType === 'upload' ? 'upload' : 'fetch',
    schema: schema ?? null, createdBy: <pipeline actor>,
  })
  return { captured: true, version: next }
```

- **ハッシュゲート**: `latest.hash === hash` なら版を作らず終了（外部 URL の定期再取得で内容が
  変わらないケースを無駄に版化しない）。`resource.hash` は Fetch が確定済み。
- **origin**: `urlType === 'upload'` → `'upload'`、それ以外（外部 URL）→ `'fetch'`。
- **schema**: Extract が返した列スキーマ（CSV/TSV のみ非 null）をそのまま版に載せる。
- Version ステップは**非クリティカル**扱い（Extract/Index と同じ）。失敗はステップに記録するが
  パイプライン全体は継続する（版が作れなくても最新版の配信は動く）。
- `createdBy`（版を発生させたユーザー）はパイプラインコンテキストに actor を渡せる場合のみ設定。
  外部 URL の定期再取得等 actor 不明時は null。

### 6.2 process-resource.ts への差し込み

`extractResult`（`previewKey`/`schema`）確定後、Index ステップの前に Version ステップを追加。
`StepTracker` に `'version'` ステップを登録し、`startStep`/`completeStep`/`skipStep` を既存同様に記録。

## 7. Step 4: 版参照 API

`packages/api/src/routes/resources.ts` に追加。サービスは `ResourceVersionService`（新設）。

| メソッド・パス                            | 権限                             | 内容                                                                                                              |
| ----------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET /resources/:id/versions`             | リソース可視性（ADR-017 同経路） | `state != purged` の版を新しい順に。purged 版は**墓標として version/日時/理由のみ**返す（内容・ダウンロード不可） |
| `GET /resources/:id/versions/:v`          | 同上                             | 単一版メタ（size/hash/origin/schema/created/state）                                                               |
| `GET /resources/:id/versions/:v/download` | 同上                             | 版キーをサーバー経由でストリーム（ADR-017 のダウンロード実装を版キーで流用）                                      |

- 可視性チェックは既存の `getByIdWithAccessCheck`（ADR-017/032 と同じ）を通す。
- purged 版のダウンロードは 410 Gone（`type`/`title` は RFC 9457）。
- 版一覧レスポンスに `origin` を含め、フロントで「取得時点のスナップショット」（fetch）を明示できるようにする。

## 8. Step 5: パージ（法的削除）

### 8.1 API

```
POST /resources/:id/versions/:v/purge
  body: { reason: string }   // 必須、Zod 検証（min length）
```

- **権限は sysadmin 限定**（`user.sysadmin`）。editor 権限では不可。
- `reason` 必須。監査ログに記録。
- 冪等: 既に `purged`/`purging` なら現状を返す（二重実行しない）。
- 応答: `202 Accepted`（非同期処理）＋現在の版状態。

### 8.2 状態遷移（ADR-028 durable-claim パターン踏襲）

```
active → purging → purged
```

1. API が `active → purging` に更新（durable claim。ここで監査ログ `action='purge_request'` を記録）
2. Worker ジョブ（新キュージョブ `RESOURCE_VERSION_PURGE`）が波及処理を実行:
   - **層1**: 版ファイル `versions/.../v{n}` を storage から削除
   - **派生物**: パージ対象が最新版なら、その版由来のプレビュー Parquet（`resource_pipeline.previewKey`）と
     OpenSearch リソースコンテンツインデックス（ADR-021）を無効化／再生成。過去版由来の派生物は
     現状最新版からしか作らないため通常は対象外
   - **層2（DuckLake）**: 本フェーズ対象外（Phase ii で compaction rewrite を追加）
3. 全波及完了後 `purging → purged`。`purgedAt`/`purgedBy`/`purgeReason` を確定し、
   監査ログ `action='purge'` を記録。**台帳行は残す（墓標）**。

### 8.3 物理消滅タイムライン（仕様として明文化）

- パージ実行でアプリ層からは**即時不可視**（全ロール。版ファイル削除済み、purged はダウンロード 410）。
- AWS: S3 バージョニングの noncurrent 版はライフサイクル（30 日、ADR-037）で自動失効。
  AWS Backup の復旧ポイントは保持期間満了で消滅 → **「パージ後、最大 30 日 + バックアップ保持期間で
  物理消滅」** をパージ UI/ドキュメントに明記。
- 残置期間中の noncurrent 版へはアプリにコードパスが無く、KUKAN のどのロールからも到達不能
  （到達可能なのは AWS IAM 保持者のみ）。
- オンプレ（MinIO、バージョニング未設定）は削除即時消滅。残置問題なし。

## 9. Step 6: Web UI（`apps/web`）

- リソース詳細（ダッシュボード側・編集者ビュー）に**版履歴**セクションを追加:
  版番号・作成日時・サイズ・origin（アップロード / 取得）・ダウンロードリンク。
- sysadmin には各版に**パージボタン**（理由入力モーダル + 物理消滅タイムラインの注意書き + 確認）。
- 公開リソース詳細（閲覧者向け）は本フェーズでは**版履歴を出さない**（差分サマリの提示は
  Phase ii/iii。閲覧者向け露出はそこで設計）。
- i18n: 版履歴・パージ関連のラベルを ja/en に追加。

## 10. テスト戦略

- **ユニット**:
  - Version ステップのハッシュゲート（同一ハッシュ→版なし、差分→版インクリメント、origin 判定）
  - `getVersionKey` / StorageAdapter `copy`（モック）
  - パージ状態遷移（active→purging→purged、冪等、二重実行防止）
- **統合**（テスト用 DB + MinIO）:
  - アップロード→パイプライン→ resource_version に v1 が作られる
  - 内容差し替え→ v2 作成、v1 の版ファイルが不変で残る
  - 同一内容再取得→版が増えない
  - 版ダウンロードが版キーの内容を返す
  - パージ: 版ファイル削除・墓標が残る・purged ダウンロード 410・監査ログ記録
  - sysadmin 以外のパージ拒否（403）
- **E2E**（Playwright、任意）: 版履歴表示 + sysadmin パージフロー。

## 11. 実装順序

1. Step 1: `resource_version` スキーマ + マイグレーション
2. Step 2: StorageAdapter `copy` + `getVersionKey`
3. Step 3: Version ステップ（Worker）+ process-resource 差し込み + StepTracker 拡張
4. Step 4: 版参照 API + `ResourceVersionService`
5. Step 5: パージ API + Worker ジョブ + キュージョブ種別追加
6. Step 6: Web UI + i18n
7. テスト

## 12. 完了基準

- アップロード / 外部 URL いずれも、パイプライン実行で `resource_version` に版が作られる
- 差し替えで版が増分し、旧版ファイルが immutable に残る（現行キー上書きに影響されない）
- 同一ハッシュの再処理で版が増えない
- 版一覧 / 取得 / ダウンロードが可視性チェック込みで動作
- sysadmin のパージで版ファイルが消え、墓標行 + 監査ログが残り、以後ダウンロード不可
- sysadmin 以外はパージ不可
- 既存のダウンロード・プレビュー・パイプライン経路は無変更で動作（後方互換）
- **既知の制約**（許容）: パイプライン処理前の連続アップロードは中間版を捕捉しないことがある

## 13. スコープ外（後続フェーズ）

- **Phase ii（DuckLake）**: 表形式リソースの層2 ingest、行レベル差分 API（3 段フォールバック）、
  管理者向け差分サマリ、パージの層2波及（compaction rewrite）
- **Phase iii**: 閲覧者向け「前版からの変更」UI、版指定クエリ、プレビュー Parquet の
  DuckLake export 統合、MCP 版差分ツール
- 保持世代数のランタイム設定（ADR-036）、IAM 明示 Deny（ADR-043 残課題 7）、
  外部 URL 定期再取得（quality パッケージ相乗り）は必要になった時点で追加
