> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/007-data-editor-addon.md`](../jp/007-data-editor-addon.md).

# ADR-007: Design Data Editor as an Add-on Module

## Status

Accepted (2026-03-01)

## Context

After Quality Monitor "detects" issues, a means to "correct" the data is needed.
However, not all municipalities require browser-based data editing.
Workflows where data is edited in local tools like Excel and re-uploaded are also common.

## Options Considered

### A) Core feature required in all environments

- Problem: Excessive for small municipalities, increases bundle size, adds dependencies

### B) Fully external tool (separate repository)

- Problem: Difficult to integrate with Quality Monitor, fragmented UX

### C) Add-on module (same repository, independent deployment) — Selected

- Exists within the monorepo but deployment is optional
- Can navigate directly from Quality Monitor detection results to the editing screen
- Separated as `apps/editor` + `packages/editor-core`

## Decision

Design Data Editor as an add-on module.
Installation is optional; integration APIs with Quality Monitor are provided as standard.

## Architecture

```
apps/editor/          ← Next.js UI (independently deployable)
packages/editor-core/ ← Business logic (change tracking, validation, approval workflow)
```

### editor-core Responsibilities

- Change tracking (row-level diff management)
- Validation rule engine
- Approval workflow (draft → review → approval → publish)
- Persisting change history

### Integration with Quality Monitor

```
Quality Monitor → Issue detection → Fix suggestion generation → Correction in Data Editor → Re-validation
```

## Rationale

- "Catalog" and "editor" are fundamentally different use cases
- As an add-on, incremental adoption is possible (implemented in Phase 7, adoption is at each municipality's discretion)
- Being in the monorepo makes type sharing and API integration easy
- Independent deployment allows upgrading only the editor

## Consequences

- `apps/editor` is implemented in Phase 7 (empty directory in Phases 1-6)
- `packages/editor-core` is also Phase 7
- `/api/editor/*` endpoints are added to the API side in Phase 7
- Reserved slots for `edit_session` / `edit_change` tables in the DB design for Phases 1-6
