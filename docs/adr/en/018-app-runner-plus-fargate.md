> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/018-app-runner-plus-fargate.md`](../jp/018-app-runner-plus-fargate.md).

# ADR-018: Web = App Runner, Worker = ECS Fargate

## Status

**Superseded by ADR-020**

## Context

A decision is needed on the execution strategy for KUKAN's deployment infrastructure, covering Web (Next.js) and Worker (SQS consumer).

### Requirements

- **Web**: HTTP request-driven, auto-scaling, near-zero-ops managed service
- **Worker**: Long-running process with SQS long polling, support for long-duration jobs

### Options Considered

| Option | Web         | Worker                          | Notes                                             |
| ------ | ----------- | ------------------------------- | ------------------------------------------------- |
| A      | App Runner  | App Runner                      | Worker CPU throttling stops SQS polling            |
| B      | App Runner  | ECS Fargate Service             | Adopted                                           |
| C      | App Runner  | EventBridge Pipes → ECS RunTask | 30-60s cold start, dual mode required             |
| D      | ECS Fargate | ECS Fargate                     | Higher ops cost (ALB required), no added benefit  |

## Decision

**Adopt Web = App Runner, Worker = ECS Fargate Service.**

### Web → App Runner

- Optimized for HTTP request/response workloads
- Automatic deployment on ECR image push
- Auto-scaling based on request count (configurable min/max)
- VPC Connector for connectivity to RDS / OpenSearch

### Worker → ECS Fargate Service

- **SQS long polling** operates without throttling
- **Architecture parity** between local development (Docker Compose + ElasticMQ) and production
- **No time limit** on job execution (e.g., large CSV to Parquet conversion)
- HTTP health check (`/health`) monitors the SQS polling loop health
  - Tracks `lastPollAt` (last poll timestamp) and `processingJobSince` (job processing flag)
  - Polling stopped & not processing → 503 → ECS marks as unhealthy → automatic task restart

### Why App Runner Is Unsuitable for Worker

App Runner throttles CPU on provisioned instances (confirmed via AWS re:Post). This effectively breaks SQS `ReceiveMessage` with 20-second long polling. Workarounds such as self-ping have been confirmed to be ineffective.

## Impact

- Cost: Worker runs on always-on ECS Fargate (small: ~$9/month)
- CDK: Two constructs needed — App Runner (L2 alpha) + ECS Fargate Service
- Docker: Single Dockerfile with multi-target builds (`web` / `worker`)

## Related

- CDK implementation: `infra/lib/constructs/web-service.ts`, `infra/lib/constructs/worker-service.ts`
- Worker health check: `apps/worker/src/index.ts`, `packages/adapters/queue/src/sqs.ts`
