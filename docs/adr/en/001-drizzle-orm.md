> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/001-drizzle-orm.md`](../jp/001-drizzle-orm.md).

# ADR-001: Adopt Drizzle ORM

## Status

Accepted (2026-03-01)

## Context

We need to select an ORM for the data catalog.
CKAN uses SQLAlchemy (Python), but since we are unifying on TypeScript, a new selection is required.
Compatibility with Aurora Serverless v2 (Data API) must also be considered.

## Options Considered

### A) Prisma

- Pros: Large community, schema-first development experience, mature migration tooling
- Cons:
  - Requires a proprietary binary engine (written in Rust) → increases Docker/Lambda image size
  - Proprietary schema language (.prisma) → dual maintenance with TypeScript
  - Limited native support for Aurora Data API
  - Frequently requires raw SQL for complex queries

### B) Kysely

- Pros: Type-safe query builder, lightweight, Aurora Data API support
- Cons:
  - Requires a separate migration tool
  - Dual maintenance of schema definitions and query types
  - Limited documentation in Japanese

### C) Drizzle ORM — Selected

- Pros:
  - Schema defined in TypeScript → fully automatic type inference
  - SQL-like API (intuitive for anyone who knows SQL)
  - Aurora Data API driver support (drizzle-orm/aws-data-api/pg)
  - Lightweight (no binary dependencies)
  - Migration management with Drizzle Kit
  - Better Auth provides native Drizzle integration
- Cons:
  - Ecosystem not as large as Prisma's
  - Some edge-case APIs may not be fully stable

## Decision

Adopt Drizzle ORM.

## Rationale

- High affinity with the TypeScript-unified approach (schemas are also written in TS)
- Native Aurora Data API support (critical for AWS environments)
- Natural integration with Better Auth (sharing the same DB connection)
- Lightweight with no binary dependencies (advantageous for Docker/Lambda)
- SQL-like API keeps the learning curve low (familiar to CKAN's SQLAlchemy users as well)

## Consequences

- Drizzle schemas are centrally managed in `packages/db`
- Better Auth table definitions are also integrated into the Drizzle schema
- Migrations use Drizzle Kit (`drizzle-kit generate` / `drizzle-kit migrate`)
