> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/041-multi-site-deploy.md`](../jp/041-multi-site-deploy.md).

# ADR-041: Multi-Site Deployment (Shared Infrastructure + Per-Site Logical Isolation)

## Status

**Accepted** — Implemented 2026-07-19 (PR #106–#109). This ADR **extends** ADR-031 (multi-environment deployment) rather than superseding it. It adds a site axis inside the environment axis (dev / prd).

Decisions fixed at implementation time (deltas from the body):

- The shared boxes gained a **Secrets Manager interface VPC endpoint** (the VPC has no NAT, so it is the only path for the site-DB bootstrap Lambda; one per environment regardless of site count)
- Site-domain ACM certificates / WAF WebACLs are **auto-created by the GlobalStack in standalone mode** (one certificate per site plus one WebACL shared across sites; pipeline mode still requires pasted ARNs, same as single-site — cross-region references are incompatible with CDK Pipelines, ADR-030. Initially both modes required ARNs; relaxed 2026-07-20)
- `OPENSEARCH_INDEX_PREFIX` is `kukan-<env>-<site>` (index `kukan-<env>-<site>-search`)
- **AWS Backup works for multi-site environments too**: the DB plan lives in the SharedStack (the shared cluster is snapshotted exactly once) and the bucket plans in each SiteStack (vault `kukan-<env>-<site>-backup`). Initially rejected because the shared cluster would have been snapshotted once per site; resolved 2026-07-20 by this split
- The site database/role are **retained** on SiteStack deletion (the Custom Resource's Delete is a no-op, protecting data from rollback-deletes of a failed create)
- Site stacks deploy **serially** (canary, then one site at a time). ECS rolling updates run old and new tasks together, so the connection budget counts exactly one site's doubling on the assumption that only one site updates at a time; wave parallelism is a future optimization for deployments that can budget several sites' doubling
- **Never raise `db.maxAcu` and add sites in the same deploy**: max_connections is a static parameter that keeps its old value until every DB instance is rebooted. Deploy the ACU change alone, reboot the instances, confirm they are in sync, then add sites (the synth error's remedy text says so too)

## Context

When a single fork operates multiple KUKAN sites (e.g. data catalogs for several municipalities), the current "1 site = 1 environment = 1 all-in-one stack" layout makes fixed costs grow linearly with the number of sites. The two main sources of fixed cost are:

- **OpenSearch domain**: node-hour billing (small: t3.small.search ×1, medium: m6g.large.search ×1)
- **Aurora minimum ACU**: `serverlessV2MinCapacity` is billed even when idle

Meanwhile, the logical resources that hold site data and namespaces (databases, indices, buckets, queues) can remain separated. The KUKAN application layer already has the groundwork needed for site separation:

- PostgreSQL connections switch the target database via the `POSTGRES_DB` environment variable (`packages/shared/src/env.ts`)
- The OpenSearch adapter has an `indexPrefix` option (`packages/adapters/search/src/opensearch.ts`; note that `packages/api/src/adapters.ts` currently does not pass it, leaving the default `kukan`)
- Users, sessions, organizations, and runtime settings (ADR-036) all live in the database, so separating databases automatically separates them per site
- The worker receives `DATABASE_URL` / `SQS_QUEUE_URL` / `OPENSEARCH_URL` via environment variables, so it can be deployed per site just by swapping environment variables (no tenant identifier is needed in SQS messages)

## Options Considered

### A) Full separation (replicating environments as-is)

Create one ADR-031 environment per site. Strongest isolation, but fixed costs (OpenSearch + Aurora minimum ACU + NAT) grow linearly with the number of sites — no cost reduction.

### B) In-app multi-tenancy

Introduce `site_id` into a single application and filter in every table, every query, the search index, and SQS messages. Infrastructure is minimal, but the single-site assumption permeates every layer (fork-based brand layer, `system_setting`, the user table, the pipeline), so this is effectively a redesign. An application bug immediately becomes cross-site information leakage, which is also a heavy risk.

### C) Shared instances + per-site logical isolation (adopted)

Share only the time-billed "boxes" (Aurora cluster, OpenSearch domain, VPC/NAT), and keep every logical resource that holds data and namespaces per site. Application code changes are limited to wiring the index prefix, and isolation is enforced at the credential level (database roles).

## Decision

**Adopt option C. Split the CDK into a SharedStack (shared boxes) and SiteStack × N (per-site resources), forming a two-axis layout (environment × site) orthogonal to the environment axis of ADR-031.**

### Shared vs. per-site inventory

| Category                               | Resources                                                                                                                                                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Shared (SharedStack)**               | VPC / subnets / NAT / SGs, Aurora cluster, OpenSearch domain, ECS cluster, CDK Pipeline (one), worker image (brand-independent, one)                                                                                                                         |
| **Per-site (SiteStack)**               | PostgreSQL database + dedicated role/secret, OpenSearch indices (prefix), S3 bucket, SQS queue + DLQ, ECS services (web / worker tasks), web image (ADR-042), CloudFront + domain + ACM certificate (+ WAF), environment variable set, CloudWatch log groups |
| **Intermediate (staged optimization)** | ALB starts per-site; sharing via host-based routing is a second-stage optimization                                                                                                                                                                           |

Principle: **time-billed "boxes" are shared; "logical resources" that hold data and namespaces are per site.**

### Layout

```
KukanPipeline (fork, one pipeline)
├─ Dev stage                        ← the environment axis stays as in ADR-031
│   ├─ SharedStack (dev)            ← small footprint (no OpenSearch + SEARCH_TYPE=postgres is possible)
│   └─ SiteStack × n(dev)           ← the site list is defined per environment (dev can be minimal)
└─ Prd stage
    ├─ SharedStack (prd)
    └─ SiteStack × n(prd)           ← canary, then one site at a time (the connection budget's premise)
```

- Extend the naming convention from `kukan-<env>-*` (ADR-031) to `kukan-<env>-<site>-*`
- Each environment in `environments.ts` holds a `sites: []` array declaring the brand name (ADR-042), domain, certificate ARN, etc. per site
- References from SharedStack to SiteStacks go through SSM parameters rather than CloudFormation exports, avoiding deploy lock-ups where shared-side changes are blocked by site references

### How site isolation is realized

- **PostgreSQL**: 1 site = 1 database + a dedicated role. Issue per-site credentials via Secrets Manager that cannot CONNECT to other sites' databases. Site database/role creation is done by a Custom Resource (Lambda) — CDK cannot create in-database objects natively. Migrations keep the current model: each site's task runs them against its own database at startup under an advisory lock
- **OpenSearch**: introduce an `OPENSEARCH_INDEX_PREFIX` environment variable and wire it to `indexPrefix` in `packages/api/src/adapters.ts` (the only application-side change). The parent-child unified index (ADR-025) becomes one index per site
- **Worker**: keep one queue + one worker service per site (environment variable swap only, no code changes). Sharing workers (adding a site identifier to messages + dynamic connection resolution) is an optimization for when the site count grows

### Deployment behavior

CDK image assets are content-hashed, so **only sites with actual changes get deployed**.

- Core code change → every site's web image hash changes; all sites roll sequentially
- Brand-only change (ADR-042) → only that site's image changes; **other sites are a no-op**
- Assets are built once at synth time and the same images are delivered to both Dev and Prd stages, so "the image validated in dev is exactly what ships to prd" is guaranteed by the mechanism

### Non-AWS environments (Docker Compose / on-premises / closed networks)

The same "shared boxes, per-site logical resources" model holds. The edge is a single Caddy with virtual hosts, which is actually simpler than AWS where CloudFront × N is needed.

```
Shared compose (started once): postgres / opensearch / minio / elasticmq / ollama / caddy
Site compose × N             : web-<site> / worker-<site> (joining the shared external network)
```

Compose-side changes at implementation time:

- Stop hardcoding `container_name: kukan-*` (it collides across projects) or rename to `kukan-<site>-*`
- Site database creation: an init script under `/docker-entrypoint-initdb.d` or an operational procedure (the equivalent of the AWS Custom Resource)
- ElasticMQ: append per-site queues to `docker/elasticmq.conf` (queues are statically defined)
- MinIO: extend `minio-init` to create per-site buckets
- OpenSearch heap (`OPENSEARCH_JAVA_OPTS`) and host memory capacity planning effectively cap the number of sites

The application layer (index prefix, `POSTGRES_DB`, brand build) is fully shared between AWS and non-AWS; environment differences stay confined to infrastructure definitions (CDK / compose).

## Trade-offs

- **Cross-site OpenSearch isolation is convention-based**: domain access control is VPC + SG (AWS) / no auth (compose, security plugin disabled), and the index prefix is only a naming convention. Hardening paths exist — per-site IAM roles with index-pattern-scoped resource policies (requires implementing SigV4 signing) or enabling FGAC — but initially we accept the policy that **only sites run by the same operator share a domain**
- **Coarser DB backup granularity**: Aurora PITR / snapshots are cluster-level. "Restore only one site" means cloning the cluster and pg_dump/restore of that database, lengthening RTO. Complement with per-site logical backups (scheduled pg_dump) — a premise change to ADR-037
- **Shared blast radius**: failures, maintenance, and engine upgrades of the shared Aurora / OpenSearch hit all sites simultaneously. A cohabitation policy is needed so that only sites with similar SLA expectations share. Note that one site's data is contained in its database/index/bucket, so a site can later be evacuated to another cluster — cohabitation is not irreversible
- **Connection multiplication**: web pool (`WEB_DB_POOL_MAX`) × tasks + worker pools multiply by the site count. Aurora Serverless v2 max_connections tracks maxACU, so it must be reviewed as sites grow (RDS Proxy is a future option)
- **Sizing the shared domain**: one site's reindex (bulk ingestion) affects search latency for all sites. A shared OpenSearch hosting multiple sites is recommended at medium (m6g.large.search) or larger (not enforced — synth emits a warning when two or more sites land on a burstable instance)
- **Shared AI quotas**: Bedrock invoke quotas are account-wide. Concurrent bulk embedding jobs across sites can throttle (with Ollama the same manifests as CPU inference contention)
- **Pipeline duration**: each push deploys "dev site count + prd site count" stacks serially. Mitigate by keeping the dev site list small (wave parallelism only becomes an option if the connection budget is changed to account for several sites updating at once)

## Migration of Existing Environments

This ADR does not force existing single-site environments to migrate.

- **Existing environments keep the current shape (multi-site is opt-in)**: an environment without `sites` in `environments.ts` continues to synthesize the all-in-one `KukanStack` with `kukan-<env>-*` naming. The SharedStack / SiteStack split applies only to environments that declare multi-site. The constructs (network / database / search, etc.) are shared by both stack shapes, so this does not duplicate the implementation
- **New environments should start with `sites` from day one**: adding `sites` in place later is a replacement, so a fresh deployment that may ever grow beyond one site should start in the multi-site shape with a single entry (e.g. `sites: [{ name: 'main' }]`). With certificate auto-creation and the AWS Backup split (relaxed 2026-07-20) there is no functional gap against the single-site shape
- **Moving an existing environment to the new shape is blue/green**: moving resources across stacks and changing physical names (Aurora `clusterIdentifier`, OpenSearch `domainName`, etc.) are CloudFormation replacements, so no in-place conversion (`cdk refactor` / retain + `cdk import`) is attempted. Build the new shape alongside, then pg_dump / restore + S3 sync + reindex, switch DNS, and destroy the old environment. The complexity stays in the runbook, and rollback remains possible
- **Implementation guardrails (drift protection between the two shapes)**: real logic stays in the existing constructs (network / database / search, etc.), and the shape branching is confined to a single composition point. The single-site shape must not change its construct tree paths (= logical IDs) from today — verified mechanically with a golden diff of synth templates across the refactor and permanent synth snapshot tests in CI (inserting a wrapper construct changes every path and would replace all resources, so it is not allowed; extracting into plain functions is safe because functions do not appear in the tree). Under this constraint, unifying both shapes into a single composition code path is the implementation goal; if it cannot be maintained, fall back to two thin wiring layers with snapshot tests for both shapes to catch drift

## Consequences (changes at implementation time)

- `infra/`: split into SharedStack / SiteStack, add `sites` to `environments.ts`, naming `kukan-<env>-<site>-*`, Custom Resource for site database/role creation, SSM-based cross-stack references
- `packages/shared/src/env.ts`: add `OPENSEARCH_INDEX_PREFIX`
- `packages/api/src/adapters.ts`: wire `indexPrefix`
- `compose.yml` / `docker/`: shared/site compose split template, `container_name` cleanup, multi-site support in the ElasticMQ conf and MinIO init
- `docs/specs/phase4-deploy.md`: add multi-site setup steps
- Multiple brands are handled in ADR-042

## Related

- ADR-031 (Multi-environment deployment design): this ADR extends it by adding a site axis inside the environment axis. Not a replacement
- ADR-042 (Multi-brand build): supplies the per-site web images
- ADR-025 (OpenSearch parent-child unified index): becomes one index per site
- ADR-036 (Runtime system settings): automatically per-site because the database is per-site
- ADR-037 (Backup strategy): the DB backup granularity premise changes (see trade-offs)
- ADR-038 (First-user bootstrap): works independently per site (database-scoped)
