> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/022-db-polling-queue.md`](../jp/022-db-polling-queue.md).

# ADR-022: DB Polling as SQS Alternative (Proposal)

## Status

**Withdrawn** — 2026-04-19

## Context

The current pipeline job queue is implemented with SQS (AWS) / ElasticMQ (development/on-premises) (ADR-002).
The `@kukan/queue-adapter` package provides the adapter layer, where the API sends messages to SQS and the Worker polls SQS for processing.

This configuration requires the following components:

- `@kukan/queue-adapter` package
- SQS (AWS environment)
- ElasticMQ (development/on-premises environment, Docker container)
- CDK SQS + DLQ configuration

### Motivation

When implementing bulk pipeline enqueue for all resources (`POST /admin/jobs/enqueue-all`),
it became apparent that sending large volumes of SQS messages could become a bottleneck.
If the Worker could simply pick up rows with `status='queued'` in the DB, SQS send latency would be zero.

## Proposal

Replace SQS with DB polling on the `resource_pipeline` table.

### Architecture

```
Current:  API → PipelineService.enqueue() → DB upsert + SQS send → Worker SQS poll → process
Proposed: API → DB upsert (status='queued') → Worker DB poll (SELECT FOR UPDATE SKIP LOCKED) → process
```

### Worker Job Loop

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
    await sleep(2000) // Wait if queue is empty
  }
}
```

### SQS Feature Replacements

| SQS Feature                          | DB Alternative                                        | Method                            |
| ------------------------------------ | ----------------------------------------------------- | --------------------------------- |
| Message delivery                     | SELECT rows with `status='queued'`                    | Polling                           |
| Exclusive consumption (1 msg = 1 Worker) | `FOR UPDATE SKIP LOCKED`                          | PostgreSQL standard               |
| Visibility timeout                   | `status='processing'` + elapsed time check on `updated` | Existing mechanism              |
| Delayed delivery                     | `WHERE created + delay < NOW()`                       | SQL condition                     |
| DLQ                                  | `status='error'` + retry count                        | Already implemented in `resource_pipeline` |
| Load distribution across Workers     | `SKIP LOCKED`                                         | Automatic distribution            |
| Message persistence                  | The DB itself                                         | Inherent                          |
| Backpressure                         | Worker fetches when idle                              | Pull-based (same as SQS)          |

### Connection Pool

- Unlike LISTEN/NOTIFY, these are regular queries so the connection pool works as-is
- No dedicated connection required
- Drizzle ORM can be used directly

## Advantages

- **Infrastructure simplification**: SQS + ElasticMQ + DLQ no longer needed
- **`@kukan/queue-adapter` package can be eliminated** (removing 1 of the 4 adapters)
- **Simplified on-premises deployment**: ElasticMQ Docker container no longer needed
- **CDK simplification**: Removal of SQS/DLQ resources
- **enqueue-all completes instantly**: Just INSERT into DB with no SQS send wait
- **Consistency**: DB is the Single Source of Truth for jobs (no SQS sync drift)

## Disadvantages and Risks

- **Aurora Serverless 0 ACU operation becomes impossible**: Worker polling (2–3 second intervals) maintains constant DB connections,
  preventing Aurora Serverless v2 from scaling down to 0 ACU. For low-utilization sites,
  this results in a significant cost increase compared to the SQS approach (no DB connections when idle → 0 ACU → ~$1.20/month),
  with a minimum of 0.5 ACU (~$73/month).
  **No impact on RDS (always-on) or on-premises PostgreSQL**
- **DB load**: Polling interval (2–3 seconds) × number of Workers generates queries against the DB.
  No issue with a few Workers, but load increases at scale (10+ Workers)
- **Latency**: Delay equal to polling interval (up to 2–3 seconds). SQS long polling responds immediately
- **AWS Auto Scaling**: SQS-based ECS Auto Scaling can no longer be used.
  Requires alternative CloudWatch custom metrics (`queued` count) for Auto Scaling configuration
- **Migration cost**: Changes needed to Worker job loop, PipelineService, and CDK stack

## Decision Criteria

Adoption is recommended when the following conditions are met:

- 5 or fewer Workers (DB polling load is acceptable)
- SQS Auto Scaling is unnecessary (fixed Worker count)
- On-premises deployment simplification is a priority
- **DB is RDS (always-on) or on-premises PostgreSQL** (Aurora Serverless 0 ACU is not needed)

Maintaining SQS is more appropriate when:

- Aurora Serverless v2's 0 ACU scale-down is desired (low-utilization sites)
- Large scale (10+ Workers, tens of thousands of jobs/day)
- SQS-based Auto Scaling is required

## Withdrawal Reason

- **Selective reprocessing is the primary use case**: In practice, most cases involve reprocessing only selected resources or
  search-matched resources, not full bulk processing. For a few to several hundred items, SQS send completes in a few hundred ms with no issue
- **Incompatibility with Aurora Serverless 0 ACU**: DB polling maintains constant connections,
  leading to significant cost increase for low-utilization sites (~$1.20/month → ~$73/month)
- **When bulk enqueue is needed**: Background processing of `enqueue-all` (Option A: immediate response + async SQS send)
  can address this. There is no need to eliminate SQS itself

## Related ADRs

- ADR-002: SQS over BullMQ (current decision)
- ADR-005: Only four adapters (QueueAdapter is one of them)
