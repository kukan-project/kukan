# ADR-028: 組織パージの worker 非同期化と durable claim

## ステータス

**承認（Accepted）**

## コンテキスト

組織（organization）は論理削除（`state` = `active` / `deleted`）を持ち、ゴミ箱からの
完全削除（purge）では配下の package と、その外部リソース（OpenSearch ドキュメント・
S3 オブジェクト = 生ファイル＋プレビュー）まで cascade で消す必要がある。

`organization → package` は 1 対多の所有（`package.owner_org` FK、cascade なし）で、
org 行を消す前に配下 package を**先に削除**しなければ FK 違反になる。1 つの組織配下に
package が数千件ありうるため、設計上いくつもの課題があった。

### 当初設計（同期パージ）の課題

1. **HTTP リクエスト内で大量削除すると timeout する**
   - 数千 package の DB 削除＋外部リソース掃除を 1 リクエストで処理すると、
     ALB のアイドルタイムアウト（既定 60s）を超えうる。

2. **「DB 削除を commit してから cleanup job を enqueue」は信頼境界が割れる**
   - DB 行を消した後に SQS enqueue が失敗すると、org は既に消えており再試行不能、
     かつ外部掃除に必要な package ID も失われ、OpenSearch ドキュメント・S3 ファイルが
     恒久的にリークする（検索に削除済みコンテンツが残存しうる）。

3. **purge 実行中の restore 競合（TOCTOU）**
   - 外部ファイルを消した後に sysadmin が org を、または org 管理者が配下 package を
     restore すると、復元済みの実体が直後の DB 一括削除で消え、外部ファイルは既に無い、
     という不整合（データ損失）が起きる。「最後に state を再確認」だけでは、
     既に外部ファイルを消した後に restore される窓が残るため不十分。

## 決定

**破壊的処理を worker ジョブへ移し、開始時に org を durable に claim する。**

### 1. ルートは検証と enqueue のみ（`requestPurge`）

- `POST /organizations/:id/purge` は事前条件（アクティブ package が無いこと）を確認し、
  `purge-organization` ジョブを enqueue するだけ。org は `deleted` のまま残す。
- 破壊的処理とそのトリガが**同一の信頼境界**に入るため、enqueue が失敗しても org は無傷で、
  ユーザーはそのまま再試行できる（delete-then-enqueue のようなリークが起きない）。

### 2. worker が破壊的処理を実行（`OrganizationService.purgeDeletedOrg`）

worker は API のサービス層を直接呼ぶ（`reindex` ジョブと同型。`@kukan/api` から
`OrganizationService` を import）。処理順序:

1. **durable claim**: `UPDATE organization SET state='purging' WHERE id=? AND state IN ('deleted','purging') RETURNING id`。行が返らなければ no-op（復元済み／purge 済み／未削除）。
2. 配下 package の ID を取得。
3. 外部リソース掃除（OpenSearch ＋ S3）を**並列度上限つき**で実行（`purgePackageExternals`）。
4. DB トランザクションで package 全件＋org 行を削除。

### 3. claim が競合を塞ぐ仕組み

- `restore`（org）は **`state='deleted'` からのみ**復元を許す → `purging` の org は復元不可。
- `PackageService.create` / `restore` は **owner org が `active`** であることを要求 → `purging`
  org 配下に新規 package を作れず、削除済み package も個別 restore できない。
- よって claim 以降は package セットが凍結され、外部ファイルを消した後に実体が復活する
  競合が原理的に発生しない。**外部削除の前に claim する**点が要。

### 4. 冪等性とリトライ（fail-fast）

- 外部掃除は `Promise.all`（`allSettled` ではない）で、1 件でも失敗すると throw し、
  DB 削除に進まない。org は `purging` のまま残り、SQS の可視性タイムアウト後に再配信される。
- 再実行時は自分の `purging` org を再 claim して続行（idempotent）。外部掃除自体も冪等。
- DB 削除（不可逆）が**最後**のステップなので、途中失敗は常に「`purging` のまま安全に再試行」
  に収束する。

### 状態モデル

`state` は `varchar(20)` で、`purging` を追加値として格納する（**マイグレーション不要**）。
`purging` は過渡状態で、`list()` / `getByNameOrId` は `active` / `deleted` のみを対象とするため
一覧・取得・UI には現れない。purge 完了後は org 行ごと消える。専用カラム（`purging_at` 等）も
検討したが、ライフサイクルを単一の `state` 列で表す既存モデルを崩さない方を優先した。

## 検討した代替案

| 代替案                               | 不採用の理由                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| HTTP リクエスト内で同期パージ        | 大規模組織で ALB timeout。delete-then-enqueue は信頼境界が割れリークする     |
| DB 削除後に最後に state を再確認     | 外部ファイルは既に削除済みのため、遅れて restore されると不整合が残る        |
| Transactional outbox（専用テーブル） | 破壊的処理を worker に置くことで「enqueue 失敗＝org 無傷」を達成でき、追加の |
|                                      | テーブル＋リレーを増やさずに同等の保証が得られる（ADR-022 と関連）           |
| `purging` 専用カラム／真偽フラグ     | スキーマ追加と二重フィールドの分岐が増える。`state` 列の再利用で十分         |

## 影響

- 変更: `packages/api/src/services/organization-service.ts`（`requestPurge` / `purgeDeletedOrg` / `restore` ガード）
- 変更: `packages/api/src/services/package-service.ts`（`assertOwnerOrgActive` で create/update/restore を統一）
- 変更: `apps/worker/src/index.ts`（`purge-organization` ハンドラ）、`packages/shared/src/pipeline-types.ts`（`PURGE_ORG_JOB_TYPE` ＋ payload スキーマ）
- 新規: `packages/api/src/services/package-cleanup.ts`（`purgePackageExternals`：検索＋ storage 掃除の共通ヘルパー）
- グループ（group）は package を**所有しない**（多対多。purge は関連を外すだけで package は残る）ため、本 ADR の claim 機構は不要。group purge は同期 1 文で原子的。
- 検索ファセットはアクティブ package のみ集計し、アクティブ package は `purging` org 配下に存在し得ないため、`purging` org がファセットに漏れることはない。

## 関連

- ADR-022（DB ポーリングによる SQS 代替）: `docs/adr/jp/022-db-polling-queue.md`
- 実装: `packages/api/src/services/organization-service.ts`, `apps/worker/src/index.ts`
