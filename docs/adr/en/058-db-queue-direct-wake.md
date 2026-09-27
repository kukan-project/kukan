# ADR-058: Move the job queue into PostgreSQL and wake the worker directly (retire SQS)

## Status

**Accepted** — 2026-09-27

This supersedes ADR-002 (adopting SQS). The reason ADR-022 (DB polling, withdrawn)
and option C of ADR-044 rejected a DB-backed queue — incompatibility with Aurora Serverless v2
scaling to 0 ACU — is removed by the wake-up scheme in this ADR.

The source of truth for jobs moves to a `job` table in PostgreSQL, and SQS / ElasticMQ / the DLQ
are retired. The worker does not poll the DB. After the API commits a job it sends the worker a
**content-free wake-up**; the worker, once woken, processes until the table is empty, then
releases its connections and waits.

## Context

### 1. SQS duplicates the source of truth

Enqueueing is two steps — upsert `resource_pipeline` to `queued`, then send to SQS — with no
transaction boundary between them (`packages/api/src/services/pipeline-service.ts`). A failed
send is compensated by an UPDATE back to `error`, but if the process dies between the two steps,
a row is left `queued` that nobody will ever process. In the classification of the ADR-022
revisit (2026-07-28) this is **B. side effects outside the transaction**, the kind of defect a DB
queue removes structurally.

That revisit concluded that "B's benefit can be had without migrating, via the outbox pattern",
but an outbox keeps the queue (SQS), writes the intent to enqueue into the DB, and picks up
anything dropped with a periodic sweep. **The structure of two sources of truth — the DB and
the queue — stays, and more parts are added.**

### 2. SQS does not do much for us

| SQS feature        | How KUKAN uses it                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| Delivery           | 14 job types; about 30 `enqueue` call sites across api / worker                                    |
| Visibility timeout | 10 minutes; the worker extends it every 2 minutes, up to 90 (`packages/adapters/queue/src/sqs.ts`) |
| Delayed delivery   | 4 sites (embed debounce, requeue while waiting for a claim, fetch rate limiting)                   |
| DLQ                | `maxReceiveCount: 3`, 14-day retention. **Nothing reads it and nothing alarms on it**              |
| Queue depth metric | Worker autoscaling (visible + in flight)                                                           |
| Receiving          | One message at a time per worker task, serially                                                    |

All of this can be expressed with PostgreSQL rows and timestamps. Priorities, FIFO and fan-out
are not used.

### 3. The queue is an environment-difference adapter

ADR-005 restricts adapters to things that differ between environments. The queue is one of them:
development and on-premises run an extra ElasticMQ container, and deploying to a cloud other than
AWS needs a new implementation for that cloud's messaging. PostgreSQL is already present in every
environment; putting the queue there removes the environment difference altogether.

### 4. Why a DB queue was rejected before

ADR-022 and option C of ADR-044 gave the same reason: **the worker keeps asking the DB whether
there is work** (polling, holding a connection), so Aurora Serverless v2 never drops to 0 ACU.
LISTEN/NOTIFY holds a connection too, so it is no different.

Notifying from the writing side, on the other hand, does not keep the DB up: at the moment a job
is INSERTed the DB is awake anyway. **What keeps it up is waiting on the DB, not having the queue
in the DB.**

## Options considered

- **A) Keep SQS and add an outbox**: removes the B defects, but the duplicated source of truth
  and ElasticMQ remain, and an outbox table and a resend sweep are added.
- **B) DB queue + polling (ADR-022)**: simplest, but incompatible with 0 ACU. Fine on RDS, on
  premises, or with a cloud DB that has no 0 ACU mode, but the implementation would then differ by
  environment.
- **C) DB queue + direct wake-up (adopted)**: no polling, so 0 ACU is not blocked. One
  implementation for every environment. The cost is a new wake-up path (API → worker).
- **D) Stream DB changes out to external messaging via triggers**: LISTEN/NOTIFY and logical
  replication (CDC) hold a connection on the receiving side. Invoking Lambda from a trigger
  (`aws_lambda.invoke`) is not rolled back, is Aurora-only, and still leaves SQS in place.
- **E) An off-the-shelf library such as pg-boss**: polls internally, so it has B's problem. It also
  manages its own schema, duplicating Drizzle's migrations.

## Decision

Adopt option C.

### 1. The `job` table is the source of truth

One row per job. Proposed columns:

| Column         | Role                                                          |
| -------------- | ------------------------------------------------------------- |
| `type`         | Job type (the existing `*_JOB_TYPE`)                          |
| `payload`      | JSONB                                                         |
| `run_at`       | Can be taken from this time on (delayed delivery, retry wait) |
| `attempts`     | Number of times taken                                         |
| `locked_until` | Lease expiry; NULL when not taken                             |
| `locked_by`    | Identifier of the taking worker (checked on extend/complete)  |
| `last_error`   | Most recent failure                                           |
| `state`        | `ready` / `dead`                                              |

- **Enqueue** is an INSERT. If the caller passes a transaction, it joins the same transaction as
  the business-data update (the defect in §1 goes away).
- **Take** one row with `FOR UPDATE SKIP LOCKED` where `run_at <= now()` and the lease has
  expired, advance `locked_until`, and increment `attempts`.
- **Extend** `locked_until` at the same cadence as SQS today (every 2 minutes, up to 90). The DB
  is awake while work is in progress, so the extending UPDATE does not block 0 ACU.
- **Complete** is a DELETE. As with SQS, succeeded jobs are not kept.
- **Fail** records `last_error`; once `attempts` reaches the limit (3, as with today's
  `maxReceiveCount`) the row becomes `state = 'dead'`. Below the limit, `run_at` is pushed back and
  the lease cleared.
- **Dead** rows are kept and shown in the admin UI. Nobody reads today's DLQ, so making failures
  visible is an improvement in itself.
- **A purge (version or organization) whose job is gone is queued again.** A purge marks its
  target `purging` and its job moves it on, so once the job is gone (deleted on the admin page,
  or a dead job pruned after its retention) the target stays `purging` and a repeat request is
  refused. The hourly pass queues the purge again for every `purging` target with no job behind
  it. While a dead job is still there it is left alone (it can be retried from the admin page)

ADR-044's per-resource claim stays as it is. The queue lease is per job; the claim is per
resource — different targets (nearly half the job types belong to no resource). The window in
which a stale execution survives after its lease expires remains with a DB queue too, so the
claim's safety net is still needed.

### 2. The worker does not poll; once woken it works until the table is empty

```
API    : INSERT job (commit) → POST /wake to the worker (no content, do not wait for the reply)
worker : woken → take and process until nothing can be taken → release connections and wait
```

- **A wake-up may be lost.** The source of truth is in the DB; the signal means nothing more than
  "come and look". A failure is only logged, and the enqueue is treated as a success.
- **If woken while processing**, run one more round after emptying the table (one flag against
  missed wake-ups).
- **Empty the table once at start-up.** Wake-ups that could not be delivered while the worker was
  down are picked up here.
- **Delayed jobs** are picked up by an in-process timer set to the earliest future `run_at` the
  worker saw while taking. The DB is woken only once, at that time.
- **Expired leases** are picked up by the same timer as delayed jobs. The timer is set to the
  earliest of the later of `run_at` and `locked_until`, so a job held by a worker that crashed is
  picked up when its lease runs out. A live worker keeps extending its lease, so the timer is
  re-armed at each extension meanwhile; the DB is awake for that work, so 0 ACU is not blocked.
  The next wake-up or start-up drain and the existing hourly cron pick them up too (the hourly
  crons already wake the DB today, so nothing new blocks 0 ACU).
- Jobs a worker writes itself (follow-ups written by the job it runs, and what its crons write)
  also signal every task, as the web does, and make a pass in-process. Woken alone, a busy task
  would hold what it queued until its current job ended while idle tasks sat by (under SQS the
  idle tasks took them at once).
- **A received signal is never forwarded.** `/wake`, the hourly pass and the start-up pass make a
  pass in-process only. Forwarded, the tasks would signal each other without end. A signal is sent
  only when a job run in a pass writes another, so the number of signals is bounded by the jobs.

Holding no DB connection while idle is a requirement. The worker's pool closes idle connections
after 10 seconds by default (`WORKER_DB_POOL_IDLE_TIMEOUT_MS`).

### 3. The wake-up path

- The worker already has an HTTP port (`HEALTH_PORT`, for health checks). Add `/wake` there.
- In Docker Compose it is reached by service name (container name under multi-site).
- On ECS the worker service is named through Cloud Map DNS. The environment has one private DNS
  namespace (`<env>.internal`), and each site's worker holds an A record under its service name
  (`kukan-<env>[-<site>]-worker.<env>.internal`). Under multi-site the shared stack owns the
  namespace and hands it to site stacks through SSM parameters. Service Connect is not used: it
  needs a proxy beside the web, which takes memory from the small-scale web.
- A path is opened from the web security group to the worker port. The security groups are shared
  by the sites of an environment, so another site's worker is reachable too, but the token is
  derived from each site's own secret, so it is refused.
- Authenticate with an internal shared secret. No new secret is added: the token is an HMAC
  derived from `BETTER_AUTH_SECRET`, which the web and the worker already have, so there is
  nothing more to distribute or rotate. If `/wake` were hit from outside, all it would do is "go
  and look at the table", so the damage is limited to waking the DB — but it is still not exposed.
- With several workers the signal goes to all of them: the web resolves every address behind the
  name and POSTs to each. A worker takes one job at a time, so a signal that reaches a busy task
  only notes a pass to make once it is free. Sent to one task alone, a new job waits for that task's
  long job to end while another sits idle. The idle ones take it, and `SKIP LOCKED` keeps two from
  taking the same row. A task started by scale-out joins through its start-up drain.

### 4. The autoscaling metric

The SQS queue-depth metric goes away. Counting rows in the DB would wake it, so that is not used.
The worker counts waiting rows **while processing** and emits them as a structured log
(CloudWatch Embedded Metric Format: `JobsWaiting` in `KUKAN/Worker`, dimension `Site`).

- What is counted is the rows ready now, the leased ones, and the failed ones waiting to retry
  (SQS's visible + in flight). Without the leased ones, the service scales in while work taken
  once is still there
- A busy task counts only while running a job (when it takes the first job of a pass, then once a
  minute). The DB is awake while processing, so this adds no wake-ups. It always recounts at the
  start of a pass: left at the idle figure while work runs, the service would scale in
- A task that finishes a pass and goes idle counts only the retry-waiting rows nobody holds (at
  the end of a pass, so the DB is awake). A row another task holds is reported by that task;
  counted by the idle one too, it would go on being reported after that task finished it, and
  hold off scale-in. Rows delayed on purpose (a debounce) are not work yet and are not counted.
  Without the retries, a wave of failures would read as nothing to do and scale in under the work
- Every task writes its figure once a minute, so the series has no gaps and scale-in decisions do
  not stall
- A busy task reports the whole table's count and an idle one only its retries, so it is aggregated by Maximum. The steps and
  thresholds (scale in at 0, +1 at 5, +2 at 25, 300-second cooldown) carry over from SQS
- Custom metrics are billed, so only sites with scaling configured (`maxTasks > minTasks`) emit it

### 5. The health check

Today the worker proves it is alive by "having polled SQS within the last 60 seconds"
(`apps/worker/src/index.ts`). Without polling, the definition becomes "answers HTTP" and nothing
else. An event loop that has stopped cannot answer, so a worker stuck in synchronous work is
caught.

- A DB query must not be part of liveness (each health check would wake the DB)
- Nor is how long the job in progress has run. Marking the task unhealthy past the extension limit
  (90 minutes) would stop a legitimately long job with its task, again at the same point on every
  retry, until it is dead. A job past the limit lets its lease go, so another worker (or the same
  one, next time round) can take it

What this cannot catch is an async wait that never returns (waiting on an external service that
does not answer). The worker takes one job at a time, so on a single-worker site the whole queue
waits meanwhile. The SQS receive loop was a single loop with the same property; the cause is
closed instead: waits on anything external are bounded (fetching external URLs, OpenSearch, AI
abstracts and embeddings, S3 connection and idle time).

## Consequences

- Removed: `SQSQueueAdapter`, `@aws-sdk/client-sqs`, the ElasticMQ container and
  `docker/elasticmq.conf`, the CDK `QueueConstruct` (queue and DLQ) and queue-depth scaling, and
  the `SQS_*` environment variables
- `QueueAdapter` keeps `enqueue` / `process` / `stop`, and `enqueue` gains an argument for passing
  a transaction. It adds `transaction` (to wake after the commit), `enqueueMany`, `countJobs` /
  `listJobs` / `retryDead` / `deleteDead` for the admin page, and `pruneDead` for retention.
  `getStats` (SQS's queue depth) is removed; the admin page counts the `job` table directly (only
  when opened, so waking the DB is fine)
- ADR-005's four adapters become three (the queue is no longer an environment difference)
- Docker Compose users get environment-variable and topology changes; the release notes carry
  migration steps
- ADR-002 becomes superseded; ADR-022 and option C of ADR-044 gain a reference to this ADR

## Migration

SQS and ElasticMQ are removed in one release. Messages left in the queue are not carried over.

- Before applying it, operators confirm on the admin "Job management" page that the queue has nothing
  pending or in flight (stated in the release notes). With that confirmation there is no need
  for a coexistence period that drains SQS
- During a rolling deploy, an old web task may still enqueue to SQS while the new worker no
  longer reads it; jobs queued in those few minutes are lost. Pipeline runs come back by
  reprocessing the rows left `queued` on the admin page; lake ingests and search document syncs
  are picked up by the hourly sweeps; embeddings come back through the search admin's reprocess.
  A version purge is left claimed with nothing queued, and the hourly pass queues it again (§1)
- In practice most of the old web's enqueues fail rather than vanish. On AWS the IAM policy is
  updated before the ECS services are replaced, so old tasks are refused the SQS send; under
  Compose ElasticMQ is already gone. Uploads completing in those few minutes may fail, so the
  release is applied at a quiet time (stated in the release notes). Keeping the SQS permissions and
  queue for one more release would prevent it, but not for a site that upgrades past that release,
  so it is not done

## Open issues

1. ~~Find the `enqueue` callers that can join a transaction~~ → the pipeline enqueue (the update to
   `queued`), the version purge claim, the lake-ingest leases and the post-purge rebuild enqueue in
   the same transaction. An organization purge's claim is taken by its job, so there is no update
   to share a transaction with
2. Deduplicating identical jobs. Is the current mechanism for the 60-second embed debounce
   (a per-package claim) enough, or should the `job` table carry a unique key?
3. ~~Retention of `dead` rows, and re-enqueueing them from the admin UI~~ → the admin Background Jobs
   page lists jobs by status; a dead one can be put back with its attempts reset, or deleted. Dead
   jobs untouched for 30 days are deleted by the hourly pass
4. ~~How Service Connect namespaces are split per site under multi-site~~ → §3 (Cloud Map DNS, one
   namespace per environment, sites told apart by service name)
5. ~~The concrete shape of the waiting-rows metric, and the scale-out thresholds~~ → §4 (thresholds
   carried over)
6. Whether small deployments (Docker Compose, small) may run the worker as a child process of web.
   The wake-up becomes an in-process call and the §3 path is unnecessary, but it brings memory
   interference (the same cgroup), coupling of web and worker task counts, work cut off on every
   deploy, and the worker's native dependencies flowing into the web image — so separate
   deployment is the default. The root is the different nature of the load. A worker that uses
   up its resources with the queue piling up only falls behind, and time resolves it. For web, a
   slow response is itself the failure. Run together, web pays for the worker's saturation
7. Measure that Aurora's auto-pause actually drops to 0 ACU once the pool has closed its idle
   connections (the worker health-check cron's default 5-minute interval may already be
   preventing pause)

## Related ADRs

- ADR-002: SQS over BullMQ (superseded by this ADR)
- ADR-005: Only four adapters
- ADR-022: Replacing SQS with DB polling (withdrawn; the reason for rejecting it is resolved by
  this ADR's wake-up scheme)
- ADR-028: Asynchronous organisation purge and durable claim
- ADR-041 / ADR-049: Multi-site and the shared ALB (namespace for the wake-up path)
- ADR-044: Per-resource execution claim (stays unchanged under this ADR)
