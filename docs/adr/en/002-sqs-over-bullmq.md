> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/002-sqs-over-bullmq.md`](../jp/002-sqs-over-bullmq.md).

# ADR-002: Adopt SQS and Eliminate Redis/BullMQ

## Status

Accepted (2026-03-01)

## Context

We need to decide on a job queuing strategy for the pipeline.
The v3 design used Redis + BullMQ across all environments, but given the typical workload of municipal portals (a few to a few dozen jobs per day), Redis was deemed excessive.

## Options Considered

### A) Redis + BullMQ (common across all environments) — v3 design

- Pros: Mature library, priority queues, job chaining, retry functionality
- Cons:
  - Redis required even in development (additional docker-compose service)
  - Redis adds operational burden in on-premises air-gapped networks
  - AWS environments require ElastiCache (~$13/month minimum)
  - Infrastructure cost is disproportionate to municipal portal workloads

### B) SQS (AWS) + ElasticMQ (development/on-premises) — Selected

- Pros:
  - AWS: SQS free tier covers 1 million requests/month, built-in DLQ, 14-day message retention
  - Development/on-premises: ElasticMQ (SQS-compatible in-memory queue) runs the same code
  - QueueAdapter abstracts away environment differences
  - Natural API/Worker separation (SQS event-driven)
- Cons:
  - SQS has some FIFO ordering constraints (standard queue is sufficient)

### C) BullMQ — Future option

- Retained as a potential third implementation of QueueAdapter
- Only for large-scale on-premises environments (hundreds of jobs per day or more)

## Decision

Adopt option B. Retain option C as a future option.

## Rationale

- For typical municipal portal workloads, SQS free tier keeps the cost at $0 indefinitely
- Eliminating Redis removes one infrastructure component, simplifying operations across all environments
- API (0.25 vCPU) and Worker (1 vCPU) have different scaling characteristics, making SQS event-driven separation a natural fit
- Approximately ~$38/month savings (no ElastiCache required)

## Consequences

- ElastiCache fully removed → mid-scale AWS configuration costs ~$122/month (down from $160, 24% reduction)
- Redis container removed from Docker Compose configuration
- Cache property removed from deployment profiles, unified to lru-cache utility
- QueueAdapter: SqsQueueAdapter / (future) BullMQQueueAdapter

## Development Environment: ElasticMQ

For local development, [ElasticMQ](https://github.com/softwaremill/elasticmq) (an SQS-compatible in-memory queue) is used.
Following the same pattern as MinIO providing S3 compatibility, the presence of `SQS_ENDPOINT` determines whether to use ElasticMQ or AWS SQS.

- Docker Compose: `docker compose up -d` (`softwaremill/elasticmq-native`)
- Queue configuration: `docker/elasticmq.conf` (with DLQ)
- Connect via `SQS_ENDPOINT=http://localhost:9324`
