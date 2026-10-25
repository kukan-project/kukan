# ADR-069: Enforce site isolation on the shared OpenSearch domain with FGAC

## Status

**Proposed** — 2026-10-21

Enable FGAC (Fine-Grained Access Control) on the shared AWS OpenSearch domain (ADR-041). Each site's
task roles are allowed only that site's indices (`<prefix>-search*`). The master user is an IAM
role, and the shared stack creates the role mappings from the environment's site list. Docker
Compose (development, on-premises, closed networks) is not affected.

This turns ADR-041's trade-off "cross-site OpenSearch isolation is convention-based" into an
enforced boundary on AWS (extends ADR-041).

> **This ADR is a draft written with Claude Code from a design conversation.** The exact permission
> list and the duration of the blue/green update will be confirmed on demo (multi-site) during
> implementation.

## Context

### 1. Isolation today

Tasks sign with SigV4 as their task role, and the domain policy admits only the account's signed
principals. Each site's task roles are granted `es:ESHttp*` on the whole domain. Unsigned requests
(including SSRF from inside the VPC) are refused.

A request that gets through, however, reaches the whole domain. Site A's task role can read and
write site B's indices, including B's private and draft dataset metadata and extracted text. Isolation
between sites is only the index-name prefix (`kukan-<env>-<site>`), a naming convention.

### 2. What this protects against

- **A compromised container**: if site A's container is compromised (RCE, ECS Exec, ...), A's role
  credentials reach the other sites' indices.
- **Application bugs**: a mixed-up index prefix or a wildcard search reaches another site's documents.
- **Audit**: FGAC audit logs can record who touched which index (whether to enable them is decided
  separately).

ADR-041 accepted that only sites run by the same operator share a domain. Under that assumption the
gain is small: once site A is compromised, site B of the same operator is effectively at risk too.
It becomes necessary if sites of different operators share a domain.

### 3. Properties of FGAC

- It requires encryption at rest, node-to-node encryption and enforced HTTPS. Every current domain
  meets these.
- It can be enabled on an existing domain. **Once enabled it cannot be disabled.** Enabling it runs
  a blue/green update; the domain stays available during the update.
- From the moment it is enabled, an IAM principal with no role mapping (OpenSearch role ← IAM role
  ARN) gets 403 even when it signs.
- Roles and mappings are created through the security API (`_plugins/_security/api/…`). There is no
  CloudFormation resource for them.

### 4. APIs the application uses

Every index is the `<prefix>-search` alias and its concrete index
(`<prefix>-search-<6 digits>-<random>`). The application uses:

- **Index operations**: search and get, writes, alias swaps, adding mappings, create and delete.
- **Multi-index operations**: `_msearch`, `_mget`, `_bulk`. FGAC checks the permission for each target
  index.
- **Cluster operations**: `_reindex`, getting and cancelling tasks, `_cat/indices`.

## Options considered

### A) Restrict indices by IAM resource paths — rejected

Write `domain/<name>/<prefix>-search*` in the resource of the domain policy or the task role policy.
Multi-index APIs name their targets in the request body, so path restrictions do not reliably apply
to them. This cannot serve as isolation.

### B) Authenticate with internal users (passwords) — rejected

Keep the master user and the site users as OpenSearch internal users. This adds password management
and rotation, and duplicates the SigV4 signing from context 1.

### C) Create role mappings with a custom resource in each site stack — rejected

Each site stack creates its role and mapping with its own task role ARNs, so adding a site creates its
mapping in that deploy. But the Lambda that signs as master would live in the shared stack, and its
ServiceToken would have to reach the sites through SSM: more parts that cross stacks.

### D) The shared stack creates the role mappings from the environment's site list — adopted (proposed)

Give the task roles fixed names (following `resourceName`, e.g. `kukan-<env>-<site>-web-task`), and let
the shared stack build their ARNs from the environment's `sites[]` and create the roles and mappings
for every site.

- One custom resource in the shared stack is the only part.
- A mapping can be created as an ARN string before the role itself exists.
- Adding or removing a site becomes a shared stack update. The pipeline runs the shared stack first, so
  no step is added.

## Decision (proposed)

### 1. Enable FGAC

- Enable `fineGrainedAccessControl` on the shared domain.
- Do not use the internal user database.
- Do not enable audit logs for now (cost and retention are decided separately).

### 2. Master user

- Create a master IAM role (`kukan-<env>-search-admin`) in the shared stack.
- It is the execution role of the custom resource's Lambda that creates roles and mappings. So that
  operators can inspect the domain by hand, its trust policy also names the account: anyone whose own
  IAM policy allows `sts:AssumeRole` on it (the AWS account's administrators) can assume it. Such
  administrators can already change the domain's configuration, so little is widened. KUKAN's task
  roles are given no permission to assume it.
- The Lambda runs in the VPC and is allowed through the OpenSearch security group.

### 3. A role per site

Create one OpenSearch role `kukan-<env>-<site>` per site.

- **Index permissions**: on `<prefix>-search*`, read and write, aliases, mappings, create and delete.
- **Cluster permissions**:
  - `_msearch`, `_mget`, `_bulk` (each needs both the cluster permission and the per-index check)
  - `_reindex`
  - getting and cancelling tasks
  - `_cat/indices`

  The exact list will be confirmed on demo during implementation. Cancelling tasks is cluster-wide, so
  a site could cancel another site's reindex. This is accepted, since it gives no read or write
  access.

### 4. Role mappings

- Give the web and worker task roles fixed names (`kukan-<env>-<site>-web-task` / `-worker-task`).
  Naming a role recreates it, so the first deploy also updates the task definitions.
- The shared stack's custom resource builds both ARNs from `sites[]` and maps them to
  `kukan-<env>-<site>`.
- When a site is removed, its role and mapping are removed too. The indices themselves follow the
  site removal procedure.
- Single-site (`KukanStack`) uses the same parts, with one site and the `kukan` prefix.
- Enabling FGAC on an existing domain makes AWS map the principals the domain policy admits to
  `default_role`. Left in place it defeats the isolation, so the custom resource removes that mapping
  on every run.
- Named IAM roles are unique across the account, so **an environment name is unique within its AWS
  account** (the same name cannot be reused in another region). A deploy under a name already in use
  stops when it creates the roles. Environment names differing only in case are refused at synth.

### 5. Domain policy

It stays the account's signed principals (`AccountRootPrincipal`). FGAC decides the per-index
permissions inside it.

### 6. Migration

- The shared stack deploy enables FGAC and runs the blue/green update. The mappings are created in
  the same deploy, so tasks running with the named task roles get through once the update finishes.
- Until a site deploy replaces its tasks, the old tasks (unnamed roles) get 403 and public search
  answers 503. This is the same kind of outage as the move to SigV4 signing, so the two **go in the
  same release, and the outage happens once**.
- Content index writes that fail meanwhile catch up by themselves when the old tasks are 0.37.0 or
  later: the worker reads a 401 or 403 as search being unavailable and marks the resource, and the
  new worker indexes it again when it starts and then hourly. Workers before 0.37.0 do not mark what
  fails, and the sweeps read only marked rows, so an upgrade from before 0.37.0 needs the content
  reindex once on each site after the deploy.
- FGAC cannot be turned off. If something goes wrong, fix it by widening the role's permissions.
- If the deploy fails after the domain update, CloudFormation tries to turn FGAC back off, fails, and
  leaves the shared stack in `UPDATE_ROLLBACK_FAILED`. The deploy spec describes continuing the
  rollback while skipping the domain.

## Consequences

- **infra**:
  - Add FGAC, the master role and the custom resource (a Lambda with its VPC and security group
    settings) to the search construct.
  - Give the web and worker task roles fixed names.
  - Update the tests and snapshots.
- **Application**: no change (signing is already in place).
- **Docker Compose**: no change (the security plugin stays disabled). As in ADR-041, isolation there
  stays convention-based.
- **Release notes**: as breaking changes, the 503 during the deploy, the content reindex after it
  for upgrades from before 0.37.0, and that FGAC cannot be turned off.

## Open issues

- The exact permission list (to be confirmed on demo).
- How long the blue/green update takes, and how long CloudFormation waits for it to finish. Confirm
  it does not hit a CloudFormation timeout.
- Whether to enable audit logs (cost and retention).
- How operators reach OpenSearch from inside the VPC (there is no bastion today).
- When an admin site that shows usage across environments is built, add an observer role that is
  allowed index statistics only to the same mapping mechanism (never the master role).

## Related

- ADR-041 (multi-site deploy): this ADR turns its trade-off "cross-site OpenSearch isolation is
  convention-based" into an enforced boundary on AWS.
- ADR-005 (adapters): the application-side signing went in as a search adapter setting.
- ADR-031 (multi-environment), ADR-049 (shared ALB): the split between the shared stack and the site
  stacks.
