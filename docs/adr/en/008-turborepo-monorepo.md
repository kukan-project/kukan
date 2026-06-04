> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/008-turborepo-monorepo.md`](../jp/008-turborepo-monorepo.md).

# ADR-008: Manage the Monorepo with Turborepo + pnpm workspaces

## Status

Accepted (2026-03-01)

## Context

KUKAN consists of multiple apps (web, worker, editor) and shared packages (api, db, shared, quality, etc.). An efficient monorepo tool is needed to manage these.

## Options Considered

### A) Nx

- Pros: Advanced caching, affected-area analysis, plugin ecosystem
- Cons: Complex configuration, high learning curve, overkill for KUKAN's scale

### B) Turborepo + pnpm workspaces — Selected

- Pros:
  - Near-zero configuration (only turbo.json + pnpm-workspace.yaml)
  - Automatic task dependency graph resolution (guaranteed build → test ordering)
  - Local + remote caching (Vercel integration or self-hosted)
  - pnpm's strict dependency management (prevents phantom dependencies)
  - Officially maintained by Vercel (good compatibility with Next.js)
- Cons: Does not have Nx-level affected-area analysis

### C) npm/yarn workspaces only (no tooling)

- Cons: Manual build ordering, no caching

## Decision

Adopt Turborepo + pnpm workspaces.

## Configuration Overview

```yaml
# pnpm-workspace.yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

```json
// turbo.json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "test": {
      "dependsOn": ["build"]
    },
    "lint": {},
    "typecheck": {
      "dependsOn": ["^build"]
    }
  }
}
```

## Rationale

- Right-sized complexity for KUKAN's scale (3 apps + 11 packages)
- pnpm's strict node_modules structure makes inter-package dependencies explicit
- Build caching significantly reduces CI time
- Natural integration with the Next.js + Vercel ecosystem

## Consequences

- Inter-package dependencies are referenced via `@kukan/package-name`
- Each package has its own `package.json` and `tsconfig.json`
- Root contains `turbo.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`
- CI runs all tasks via `pnpm turbo run build test lint typecheck`
