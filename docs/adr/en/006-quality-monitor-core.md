> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/006-quality-monitor-core.md`](../jp/006-quality-monitor-core.md).

# ADR-006: Incorporate Quality Monitor as a Core Feature

## Status

Accepted (2026-03-01)

## Context

CKAN lacks data quality monitoring capabilities, leading to broken links and invalid CSVs being left unaddressed.
External tools (such as the CKAN QA extension) exist but have low adoption rates, and their operations become siloed.
KUKAN takes the philosophy that "quality is the catalog's responsibility" and includes quality monitoring as a core feature.

## Decision

Incorporate Quality Monitor into the core as `packages/quality`.
It operates as part of the catalog itself, not as an external plugin.

## Quality Checkers (Implemented in Phase 4)

| Checker         | Function                                            | Frequency          |
| --------------- | --------------------------------------------------- | ------------------ |
| LinkChecker     | Liveness monitoring of resource URLs                | Daily              |
| CsvValidator    | CSV structure validation (headers, types, encoding) | On upload + weekly |
| MetadataAuditor | Completeness scoring of required metadata           | Real-time          |
| PiiScanner      | Personal information detection (using AIAdapter)    | On upload          |

## Quality Score

- Each dataset receives a score from 0 to 100
- Dashboard visualizes quality trends by organization and category
- Scores can be exposed externally via CKAN-compatible API

## Rationale

- Municipal portals tend to adopt a "register and forget" approach → quality degradation is the biggest challenge
- As a core feature, quality monitoring is enabled on all instances → improves quality across the entire ecosystem
- Quality Monitor (detection) + Data Editor (correction) provides a complete quality lifecycle

## Consequences

- Quality checker interfaces and implementations are placed in `packages/quality`
- Quality checks are executed as the final step of the pipeline
- A `quality_score` table is added to the DB (at dataset and resource level)
- Dashboard UI is implemented as a quality tab within `apps/web`
