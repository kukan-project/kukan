# ADR-038: First-User Bootstrap and Runtime Registration Control

## Status

**Accepted**

## Context

Initial user creation used to be a manual CLI step (`pnpm db:create-user`)
that creates a sysadmin. Whether self-registration is enabled was controlled
by the `REGISTRATION_ENABLED` environment variable (fixed at startup,
disabled by default), so flipping it required a redeploy.

This setup has two problems:

- **Initialization requires direct DB access**: in managed environments
  (ECS etc.) running the CLI needs a bastion host or a one-off task,
  raising the setup bar considerably.
- **Registration is a setting you want to flip at runtime**: opening
  registration only for an event period, or closing it immediately when
  something goes wrong, does not mix well with redeploys. ADR-036 already
  listed "moving `registrationEnabled` into the DB" as a future candidate.

## Decision

### 1. First-user bootstrap

**While the user table has zero rows** (deleted users still count as rows),
the system is considered "bootstrapping" and behaves specially in two ways:

- **Self-registration is allowed** regardless of the registration setting.
- The first registered user is **automatically promoted to sysadmin**
  (the `role` is injected via Better Auth's
  `databaseHooks.user.create.before`; the admin plugin's before hook merges
  with priority to the incoming data, so this does not depend on hook
  execution order).

The promotion is decided not by re-checking the row count but by a
**one-shot claim**: an `INSERT ... ON CONFLICT DO NOTHING` of a unique key
(`bootstrap-completed`, a sentinel row outside the registry) into
`system_setting`. Even if concurrent sign-ups all observe "zero users",
the unique constraint limits the promotion to exactly one winner (the same
durable-claim idea as ADR-028).

The promotion is recorded in `audit_log` (entityType `user`, with
`{ bootstrap: true }` in changes). Once at least one user exists, bootstrap
ends permanently and normal registration control applies (the positive
result is cached in-process, skipping further COUNT queries).

- **The check counts all rows.** Checking "zero active users" instead would
  create a self-recovery path — deleting every sysadmin would reopen
  registration and make the next sign-up a sysadmin — but we prefer
  predictable behavior and do not adopt it. Lockout recovery remains a CLI
  operation (`pnpm db:create-user`).
- **A leftover claim self-heals.** If the first registration fails after
  claiming but before creating its user, only the sentinel remains. A claim
  older than 60 seconds with the user table still empty is treated as such
  a leftover and **stolen atomically** (`UPDATE ... WHERE updated <
now() - 60s RETURNING`), so the next sign-up is promoted. Claims younger
  than 60 seconds are respected as belonging to an in-flight concurrent
  sign-up, preserving the race exclusion.
- **While a fresh claim exists, subsequent sign-ups are rejected with 409**
  (retryable). Allowing a regular-user creation here would make that user
  the "first user" if the claim holder died before creating its own —
  ending bootstrap with no sysadmin. With the rejection, the claim either
  completes or goes stale within 60 seconds and becomes stealable.

### 2. Registration as a runtime setting; environment variable removed

Add `registration-enabled` (boolean, default false) to the ADR-036
system_setting registry, toggled from the admin UI
(`/dashboard/admin/site`). The `REGISTRATION_ENABLED` environment variable
is **removed**. Keeping no baseline on the env side — "the runtime setting
is the single home" — follows the same pattern as the search example
queries (ADR-036).

`GET /api/v1/site/settings` returns the effective value
(bootstrapping || setting) as `registrationEnabled`, and the sign-up UI
follows it. The API-side guard (403 on the sign-up endpoint) is always
authoritative; the UI may lag behind by the shared-cache TTL (ADR-026).

### Operational note

Between deploy completion and the first registration, anyone who reaches
the URL can become sysadmin. This is a common pattern (Gitea and others);
it is harmless on closed networks, but internet-facing deployments must
**register the first user promptly after deploying**.
`pnpm db:create-user` remains as a fallback for headless initialization
and lockout recovery.

## Consequences

- A fresh install completes as "deploy → sign up in the browser → instant
  sysadmin", with no direct DB access required.
- Registration can be toggled from the admin UI, taking effect within the
  cache TTL.
- Existing environments that set `REGISTRATION_ENABLED` must re-apply the
  setting once in the admin UI after upgrading (the DB setting defaults to
  disabled).

## Related

- ADR-003: Better Auth adoption (the admin plugin / databaseHooks
  foundation)
- ADR-036: DB-backed runtime system settings (this ADR is its second
  application)
