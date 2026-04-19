# ADR-022: DB ポーリングによる SQS 代替（提案）

## ステータス

**取り下げ（Withdrawn）** — 2026-04-19

## コンテキスト

現在のパイプラインジョブキューは SQS（AWS）/ ElasticMQ（開発・オンプレ）で実装されている（ADR-002）。
`@kukan/queue-adapter` パッケージがアダプター層を提供し、API が SQS にメッセージを送り、Worker が SQS をポーリングして処理する。

この構成は以下のコンポーネントを必要とする:

- `@kukan/queue-adapter` パッケージ
- SQS（AWS 環境）
- ElasticMQ（開発・オンプレ環境、Docker コンテナ）
- CDK の SQS + DLQ 構成

### きっかけ

全リソース一括パイプライン投入（`POST /admin/jobs/enqueue-all`）の実装時に、
大量の SQS メッセージ送信がボトルネックになり得ることが判明。
DB に `status='queued'` を書くだけで Worker が拾えれば、SQS 送信の待ち時間がゼロになる。

## 提案

SQS を廃止し、`resource_pipeline` テーブルへの DB ポーリングに置き換える。

### アーキテクチャ

```
現行:  API → PipelineService.enqueue() → DB upsert + SQS send → Worker SQS poll → 処理
提案:  API → DB upsert (status='queued') → Worker DB poll (SELECT FOR UPDATE SKIP LOCKED) → 処理
```

### Worker のジョブループ

```typescript
while (running) {
  const job = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(resourcePipeline)
      .where(eq(resourcePipeline.status, 'queued'))
      .orderBy(resourcePipeline.created)
      .for('update', { skipLocked: true })
      .limit(1)

    if (row) {
      await tx
        .update(resourcePipeline)
        .set({ status: 'processing' })
        .where(eq(resourcePipeline.id, row.id))
    }
    return row ?? null
  })

  if (job) {
    await processResource(job.resourceId, ctx, db)
  } else {
    await sleep(2000) // キューが空なら待機
  }
}
```

### SQS が提供する機能の代替

| SQS の機能                        | DB 代替                                              | 方法                                |
| --------------------------------- | ---------------------------------------------------- | ----------------------------------- |
| メッセージ配信                    | `status='queued'` の行を SELECT                      | ポーリング                          |
| 排他的消費（1メッセージ=1Worker） | `FOR UPDATE SKIP LOCKED`                             | PostgreSQL 標準                     |
| 可視性タイムアウト                | `status='processing'` + `updated` の経過時間チェック | 既存の仕組みで対応                  |
| 遅延配信                          | `WHERE created + delay < NOW()`                      | SQL 条件                            |
| DLQ                               | `status='error'` + retry count                       | 既に `resource_pipeline` に実装済み |
| 複数 Worker の負荷分散            | `SKIP LOCKED`                                        | 自動分散                            |
| メッセージ永続化                  | DB そのもの                                          | 当然                                |
| バックプレッシャー                | Worker が空いたら取りに行く                          | pull 型（SQS と同じ）               |

### コネクションプール

- LISTEN/NOTIFY と異なり、通常のクエリなのでコネクションプールがそのまま使える
- 専用コネクションの確保が不要
- Drizzle ORM をそのまま使用可能

## メリット

- **インフラ簡素化**: SQS + ElasticMQ + DLQ が不要
- **`@kukan/queue-adapter` パッケージを廃止** できる（4 アダプターのうち 1 つを削減）
- **オンプレデプロイの簡素化**: ElasticMQ Docker コンテナが不要
- **CDK の簡素化**: SQS/DLQ リソースの削除
- **enqueue-all が即座に完了**: DB に INSERT するだけで SQS 送信待ちなし
- **一貫性**: DB がジョブの Single Source of Truth（SQS との同期ズレがない）

## デメリット・リスク

- **Aurora Serverless 0 ACU 運用が不可**: Worker のポーリング（2〜3 秒間隔）により常に DB 接続が維持され、
  Aurora Serverless v2 が 0 ACU にスケールダウンしない。低利用率サイトでは
  SQS 方式（ジョブがない間は DB 接続なし → 0 ACU → ~$1.20/月）と比べて
  最低 0.5 ACU（~$73/月）のコスト増になる。
  **RDS（常時起動）やオンプレ PostgreSQL では影響なし**
- **DB 負荷**: ポーリング間隔（2〜3 秒）× Worker 数のクエリが DB に発生。
  数台の Worker なら問題ないが、大規模（10+ Worker）では負荷が増える
- **レイテンシ**: ポーリング間隔分の遅延（最大 2〜3 秒）。SQS のロングポーリングは即座に応答
- **AWS Auto Scaling**: SQS ベースの ECS Auto Scaling が使えなくなる。
  代替として CloudWatch カスタムメトリクス（`queued` 件数）で Auto Scaling を設定する必要がある
- **移行コスト**: Worker のジョブループ、PipelineService、CDK スタックの変更が必要

## 判断基準

以下の条件が揃えば採用を推奨:

- Worker 数が 5 台以下（DB ポーリング負荷が許容範囲）
- SQS Auto Scaling が不要（固定 Worker 数で運用）
- オンプレデプロイの簡素化が優先事項
- **DB が RDS（常時起動）またはオンプレ PostgreSQL**（Aurora Serverless 0 ACU が不要）

以下の場合は SQS を維持する方が適切:

- Aurora Serverless v2 の 0 ACU スケールダウンを活用したい（低利用率サイト）
- 大規模（10+ Worker、数万ジョブ/日）
- SQS ベース Auto Scaling が必要

## 取り下げ理由

- **選択的再処理が主なユースケース**: 実運用では全件一括ではなく、選択したリソースや検索でヒットした
  リソースのみを再処理するケースが大半。数件〜数百件なら SQS 送信は数百 ms で完了し問題にならない
- **Aurora Serverless 0 ACU との非互換**: DB ポーリングにより常時接続が維持され、
  低利用率サイトでの大幅なコスト増（~$1.20/月 → ~$73/月）につながる
- **全件一括が必要な場合**: `enqueue-all` のバックグラウンド化（方式 A: 即レスポンス + 非同期 SQS 送信）
  で対応可能。SQS 自体を廃止する必要はない

## 関連 ADR

- ADR-002: SQS over BullMQ（現行の判断）
- ADR-005: 4 アダプターのみ（QueueAdapter が対象の 1 つ）
