> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/019-logging-strategy.md`](../jp/019-logging-strategy.md).

# ADR-019: Logging Strategy — Structured Logs + Infrastructure-Layer Collection

## Status

Accepted (2026-03-31)

## Context

KUKAN targets hybrid deployment across AWS (ECS Fargate + ALB) and on-premises (Docker Compose).
The current logging approach has the following issues:

- **`console.log` only**: No structured format, no log level distinction (info / warn / error)
- **Inconsistent formatting**: Only some areas use manual prefixes like `[Worker] ...`
- **No correlation ID**: Unable to trace across requests or jobs
- **Difficult to search**: Plain text makes log searching and filtering in production environments inefficient

ADR-005 established that "metrics / logging do not need adapters — logger configuration is sufficient."
Following this principle, **no log adapter will be created on the application side**.

## Decision

### Principle: stdout structured JSON + infrastructure-layer collection

The application **only outputs structured JSON to stdout**, delegating collection, storage, and visualization to the infrastructure layer.
Application code is identical across AWS and on-premises. Environment-specific differences are absorbed by the infrastructure layer.

```
┌──────────────┐   stdout    ┌─────────────┐   push    ┌──────────┐
│  App (pino)  │ ─────────▶ │  Collector   │ ───────▶ │  Store   │
│  web/worker  │  JSON logs  │              │          │          │
└──────────────┘             └─────────────┘          └────┬─────┘
                                                           │ query
                                                      ┌────▼─────┐
                                                      │  Viewer  │
                                                      └──────────┘
```

| Environment | Collector                              | Store           | Viewer                  |
| ----------- | -------------------------------------- | --------------- | ----------------------- |
| AWS         | ECS Fargate built-in (auto-collection) | CloudWatch Logs | CloudWatch console      |
| On-premises | Fluent Bit                             | Loki            | Grafana                 |

### Application side: structured logging with pino

- **pino** is adopted (the fastest JSON logger for Node.js, proven in the Hono / Fastify ecosystem)
- Outputs JSON to stdout (`level`, `time`, `msg`, `requestId`, etc.)
- Log levels: `fatal` / `error` / `warn` / `info` / `debug` / `trace`
- In development, `pino-pretty` converts output to a human-readable format

### AWS environment: CloudWatch Logs

- ECS Fargate automatically sends stdout to CloudWatch Logs (awslogs driver)
- Worker already has a CloudWatch LogGroup configured via CDK (`/kukan/worker`, 1-month retention)
- Web (ECS Fargate) is similarly collected via a CloudWatch LogGroup
- JSON format enables field-level searching with CloudWatch Logs Insights

### On-premises environment: Fluent Bit + Loki + Grafana

Three components are added to `compose.yml`:

#### Fluent Bit (log collection)

- Lightweight log collector written in C (memory ~30MB)
- Collects stdout/stderr from Docker containers, adds labels, and sends to Loki
- Lighter than Fluentd (written in Ruby) and better suited for container environments

#### Loki (log storage and search)

- Grafana's log aggregation system (memory ~200-500MB)
- **Indexes only labels**, resulting in significantly lower storage and memory consumption (orders of magnitude less than Elasticsearch/OpenSearch)
- Query with LogQL: `{app="worker"} |= "error" | json | level="error"`
- Storage: local filesystem (can also use S3-compatible storage)

#### Grafana (visualization and UI)

- Browser-based dashboard (memory ~100-200MB)
- Log search, filtering, and alert configuration
- Provides on-premises equivalent of CloudWatch Logs Insights functionality

## Log Format Specification

### Common Fields

pino standard fields included in every log line:

| Field      | Type   | Description                              |
| ---------- | ------ | ---------------------------------------- |
| `level`    | number | Log level (10–60, see table below)       |
| `time`     | number | Unix epoch milliseconds                  |
| `name`     | string | Logger name (`api` / `worker`)           |
| `msg`      | string | Log message                              |
| `pid`      | number | Process ID                               |
| `hostname` | string | Hostname                                 |

**Log level values:**

| Level   | Value |
| ------- | ----- |
| `trace` | 10    |
| `debug` | 20    |
| `info`  | 30    |
| `warn`  | 40    |
| `error` | 50    |
| `fatal` | 60    |

### Context-Specific Fields

Scoped fields added via pino's `child()`:

| Context            | Fields                                | Source                                     |
| ------------------ | ------------------------------------- | ------------------------------------------ |
| API request        | `requestId`                           | `hono/request-id` → `child({ requestId })` |
| Request completion | `method`, `path`, `status`, `elapsed` | Logger middleware                          |
| Worker job         | `jobId`, `resourceId`                 | Added during job processing                |
| SQS adapter        | `component: "sqs"`                    | `child({ component: 'sqs' })`              |
| Error              | `err` (`type`, `message`, `stack`)    | Auto-serialized by pino                    |

### Output Examples

**Request completion (production JSON):**

```json
{
  "level": 30,
  "time": 1712467200000,
  "name": "api",
  "requestId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "method": "GET",
  "path": "/api/v1/packages",
  "status": 200,
  "elapsed": 42,
  "msg": "request completed"
}
```

**Error (production JSON):**

```json
{
  "level": 50,
  "time": 1712467200000,
  "name": "api",
  "requestId": "f47ac10b-...",
  "err": {
    "type": "Error",
    "message": "connection refused",
    "stack": "Error: connection refused\n    at ..."
  },
  "msg": "Unhandled error"
}
```

**Worker job processing:**

```json
{
  "level": 30,
  "time": 1712467200000,
  "name": "worker",
  "jobId": "msg-abc123",
  "resourceId": "res-456",
  "msg": "Processing resource"
}
```

**Development environment (pino-pretty):**

```
14:23:45.123 INFO (api): request completed
    requestId: "f47ac10b-..."
    method: "GET"
    path: "/api/v1/packages"
    status: 200
    elapsed: 42
```

### CloudWatch Logs Insights Query Examples

```sql
-- List error logs
fields @timestamp, msg, err.message, requestId
| filter level >= 50
| sort @timestamp desc

-- Trace a specific request (correlate by requestId)
fields @timestamp, msg, method, path, status, elapsed
| filter requestId = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
| sort @timestamp asc

-- Slow requests (over 500ms)
fields method, path, status, elapsed
| filter msg = "request completed" and elapsed > 500
| sort elapsed desc

-- Worker job errors
fields @timestamp, msg, jobId, resourceId, err.message
| filter name = "worker" and level >= 50
| sort @timestamp desc
```

### Environment Variables

| Variable    | Default | Description                                                       |
| ----------- | ------- | ----------------------------------------------------------------- |
| `LOG_LEVEL` | `info`  | Log level (`trace`/`debug`/`info`/`warn`/`error`/`fatal`)        |

When `level` is explicitly specified in the `createLogger()` options, that takes precedence.

## Rationale

### Why pino

| Library | Speed   | Native JSON | Ecosystem                   |
| ------- | ------- | ----------- | --------------------------- |
| pino    | Fastest | Yes         | Proven with Hono / Fastify  |
| winston | Slow    | Plugin      | Legacy standard from Express era |
| bunyan  | Medium  | Yes         | Maintenance stalled         |
| console | N/A     | No          | Insufficient for production |

### Why Loki + Fluent Bit (vs ELK)

| Aspect              | ELK (Elasticsearch + Logstash + Kibana) | Loki + Fluent Bit + Grafana                      |
| ------------------- | --------------------------------------- | ------------------------------------------------- |
| Memory consumption  | Several GB                              | ~500MB total                                      |
| Disk consumption    | Large (full-text index)                 | Small (labels-only index)                         |
| Setup               | Complex                                 | Easy with Docker Compose                          |
| Air-gapped suitability | Too heavy                            | Lightweight and suitable                          |
| OpenSearch conflict  | Roles overlap between search engine and log platform | Separation of concerns (search = OpenSearch, logs = Loki) |

Since KUKAN already uses OpenSearch as a search engine,
using OpenSearch for log infrastructure as well would mix responsibilities and complicate operations. Loki provides separation.

### Why no adapter

Following ADR-005's principle, no log adapter is needed in application code:

- The application just outputs JSON to stdout (only pino configuration)
- Collection is handled by the infrastructure layer (CloudWatch / Fluent Bit)
- Application code is identical across AWS and on-premises

## Impact

### Resource Consumption (on-premises additions)

| Component  | Memory     | Disk                                  |
| ---------- | ---------- | ------------------------------------- |
| Fluent Bit | ~30MB      | Negligible                            |
| Loki       | ~200-500MB | Proportional to log volume (high compression ratio) |
| Grafana    | ~100-200MB | ~several hundred MB                   |

### Implementation Scope

- **pino introduction**: Add pino to `packages/api` and `apps/worker`, replace existing `console.log` calls
- **compose.yml**: Add 3 services for Fluent Bit / Loki / Grafana (separable via profile)
- **CDK**: Explicitly configure CloudWatch Logs for Web (ECS Fargate)

Implemented. The logger factory is at `packages/shared/src/logger.ts`, and the ESLint `no-console` rule prevents future `console.*` usage.

## Related

- ADR-005: Only four adapters — established that metrics/logging do not need adapters
- ADR-020: Web = ECS Fargate + ALB, Worker = ECS Fargate — source of CloudWatch Logs collection
- CDK Worker log configuration: `infra/lib/constructs/worker-service.ts`
- Existing logger middleware: `packages/api/src/middleware/logger.ts`
