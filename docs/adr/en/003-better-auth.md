> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/003-better-auth.md`](../jp/003-better-auth.md).

# ADR-003: Adopt Better Auth + OIDC

## Status

Accepted (2026-03-01)

## Context

An authentication foundation that works across both the API (Hono) and frontend (Next.js) is needed.
The v3 design adopted Auth.js, but there were challenges integrating it with the Hono API server.
Additionally, OIDC federation with external IdPs such as Keycloak is a mandatory requirement for on-premises air-gapped networks.

## Options Considered

### A) Auth.js (NextAuth) — v3 design

- Pros: Large community, natural Next.js integration
- Cons:
  - Support for runtimes other than Next.js feels bolted on
  - Using it with a Hono API server requires a custom adapter
  - DB integration depends on adapters (stability concerns with the Drizzle adapter)
  - OIDC client functionality is plugin-like with complex configuration

### B) Better Auth + OIDC — Selected

- Pros:
  - Framework-agnostic (works with Hono / Next.js / Express)
  - Native Drizzle ORM integration (shares the same DB connection)
  - OIDC client plugin for Cognito / Keycloak federation
  - Plugin architecture (2FA, organization management, API keys, etc. can be added incrementally)
  - TypeScript-first
- Cons:
  - Still a younger project compared to Auth.js
  - Smaller community size

### C) Lucia Auth

- Pros: Lightweight, educational, focused on session management
- Cons: No OIDC support, no plugin ecosystem, in maintenance mode

## Decision

Adopt Better Auth + OIDC plugin.

## Rationale

- The only option that allows using the same library across both the Hono API server and Next.js frontend
- Most natural integration with Drizzle ORM (centralized schema management in `packages/db`)
- OIDC standards compliance makes future IdP replacement easy (avoids vendor lock-in)
- The risk of being a young project is mitigated by OIDC standards compliance (worst case, migration to another library is straightforward)

## Consequences

- `packages/db` includes Better Auth table definitions
- Authentication flow is centrally managed by the Better Auth instance within `packages/api`
- Next.js side references sessions via the Better Auth client
- Per-environment IdP: Cognito (AWS) / Keycloak (on-premises LGWAN) / local email authentication (development)

## Implementation Guidance: Better Auth + Drizzle Integration

### Table Integration Strategy

Better Auth internally uses `user`, `session`, `account`, and `verification` tables.
KUKAN's `user` table and Better Auth's `user` table are integrated as a **single table**.

**Steps:**

1. Obtain the base table definitions using Better Auth's `toSchema()`
2. Add KUKAN-specific columns (`name`, `display_name`, `sysadmin`, `state`, `extras`, etc.)
3. Use Better Auth's default definitions as-is for `session`, `account`, and `verification`

```typescript
// packages/db/src/schema/auth.ts
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'

// Additional tables required by Better Auth (session, account, verification)
// These are defined following Better Auth's official documentation.
// → https://www.better-auth.com/docs/adapters/drizzle
// Always refer to Better Auth's latest documentation during implementation.
```

### Better Auth Instance Initialization

```typescript
// packages/api/src/auth/auth.ts
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { db } from '@kukan/db'

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  emailAndPassword: { enabled: true },
  session: {
    // Session lifetime configuration
    expiresIn: 60 * 60 * 24 * 7, // 7 days
  },
  // To be added in Phase 6:
  // plugins: [oidcClient({ ... })]
})
```

### Coexistence with API Key Authentication

Better Auth handles session-based authentication, while API key authentication coexists via a custom implementation.
Middleware checks both in order:

1. `Authorization: Bearer <api_key>` → validate against the `api_token` table
2. Cookie session → validate via Better Auth
3. If neither is present → 401
