> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/020-ecs-fargate-alb-migration.md`](../jp/020-ecs-fargate-alb-migration.md).

# ADR-020: Web = ECS Fargate + ALB, Worker = ECS Fargate (Supersedes ADR-018)

## Status

**Accepted** — 2026-04-03 revised: Express Mode → Standard Fargate + ALB

## Context

ADR-018 adopted AWS App Runner as the deployment target for Web, but
AWS announced the transition of App Runner to maintenance mode in April 2026.

- After April 30, 2026, new customers can no longer use App Runner
- Existing customers continue to receive security/availability support (no new features)
- AWS-recommended migration target: Amazon ECS Express Mode

### Options Considered

| Option | Web                            | Migration Cost | Standby Cost (small) | Notes                                                                             |
| ------ | ------------------------------ | -------------- | -------------------- | --------------------------------------------------------------------------------- |
| A      | ECS Express Mode               | Low            | ~$29/month           | Express Mode with auto-managed ALB                                                |
| B      | Standard ECS Fargate + ALB     | Medium         | ~$29/month           | Adopted. Self-managed ALB, TG, Listener                                           |
| C      | Lambda + CloudFront (OpenNext) | High           | ~$0/month            | Fundamental architecture change. Incompatible with single-origin design (ADR-012) |
| D      | Continue with App Runner       | None           | ~$3/month            | No new features, future deprecation risk                                          |

### Why Express Mode was adopted then changed to Standard

The initial revision adopted Express Mode (Option A) and deployed it,
but the following constraints were discovered during operation, leading to a change to Standard Fargate + ALB (Option B).

| Constraint                                         | Impact                                                   | Notes                                                           |
| -------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| Express Mode manages the ALB's default certificate | Certificate changes via `modifyListener` are overwritten | SNI additional certificates work around this but are cumbersome |
| Express Mode manages the ALB's SG                  | Cannot use SG for IP restrictions; WAF becomes mandatory | WAF ~$9/month always incurred                                   |
| Cannot disable default endpoint (`*.ecs.*.on.aws`) | Default endpoint persists even with custom domain setup  | `modifyRule` host header restriction workaround needed          |
| L1 constructs only (CfnExpressGatewayService)      | Cannot use CDK's L2 helpers or type safety               | —                                                               |
| Managed resource reconciliation                    | SDK-modified settings may be silently reverted           | Confirmed with certificate settings                             |

**Conclusion**: Express Mode's "simple deployment" benefit does not outweigh the cost of
workarounds for custom domain + IP restrictions. Standard Fargate + ALB is superior in
controllability, transparency, and cost.

## Decision

**Web = ECS Fargate + ALB, Worker = ECS Fargate Service (unchanged)** is adopted.

### Web → ECS Fargate + ALB

- Self-managed ALB, Target Group, Listener (CDK L2 constructs)
- Custom domain: ACM certificate + Route53 direct configuration (no workaround needed)
- IP restriction: Direct control via ALB SG (no WAF needed)
- WAF: Optionally enabled only when managed rules are required
- Auto Scaling: CPU utilization target tracking via `autoScaleTaskCount` (originally request-based; see "Addendum: web scaling metric")

### Network Configuration

- ECS tasks (Web / Worker) are placed in Public subnets (`assignPublicIp: true`)
- No NAT Instance / NAT Gateway required (cost reduction)
- RDS / OpenSearch in Isolated subnets (no internet access)
- S3 Gateway VPC Endpoint (free) to optimize S3 traffic

### Worker → ECS Fargate Service (unchanged)

The ADR-018 decision is maintained as-is.

### Why Fargate is more appropriate than Lambda

- KUKAN uses Hono + Next.js single-origin design (ADR-012). Lambda conversion requires fundamental architecture changes
- Lambda container image cold start: 1–3 seconds (for Next.js standalone)
- Lambda INIT phase billing since August 2025 reduces Lambda's cost advantage
- Provisioned Concurrency to keep Lambda warm costs about the same as Fargate

## Cost Impact

| Scale                      | App Runner  | Fargate + ALB | Fargate + ALB + WAF |
| -------------------------- | ----------- | ------------- | ------------------- |
| small (0.25 vCPU / 0.5 GB) | ~$3/month   | ~$27/month    | ~$36/month          |
| medium (0.5 vCPU / 1 GB)   | ~$7/month   | ~$38/month    | ~$47/month          |
| large (1 vCPU / 2 GB × 2)  | ~$145/month | ~$108/month   | ~$117/month         |

- Estimates for Tokyo region with minimum instance count for the Web service. No NAT needed (Public subnet configuration).
- Worker is small at 0.25 vCPU / 1 GB (memory requirements for PDF/Office text extraction).
  For IP restriction only, ALB SG is sufficient and WAF is unnecessary (middle column).
  When managed rules (SQLi/XSS protection) are needed, WAF is added (right column).

### CloudFront Removal

During the App Runner era, CloudFront was effectively mandatory (WAF could not be attached, custom domain constraints).
With Fargate + ALB, the ALB serves as the front, and all functions previously provided by CloudFront can be replaced by the ALB.

| Function                | App Runner era                       | Fargate + ALB                             |
| ----------------------- | ------------------------------------ | ----------------------------------------- |
| SSL/TLS + custom domain | Required via CloudFront              | Direct via ALB + ACM + Route53            |
| WAF                     | Cannot attach directly to App Runner | Can attach WAF directly to ALB (optional) |
| IP restriction          | Implemented via CloudFront Function  | Via ALB SG (free)                         |
| DDoS (Shield Standard)  | Auto-applied to CloudFront           | Also auto-applied to ALB                  |
| Static asset caching    | CDN edge caching                     | Browser caching only (see below)          |

**Static asset caching**: ALB itself has no caching functionality, but this is not a problem.
Next.js static assets (`/_next/static/*`) use content-hashed filenames with
`Cache-Control: public, max-age=31536000, immutable` automatically applied.
Browser caching means no server requests after the first load, so for KUKAN with
primarily domestic users, CDN edge caching benefits are limited.

**Drawbacks of keeping CloudFront**:

- **Configuration complexity**: CloudFront WAF and ACM certificates require us-east-1,
  creating cross-region dependency with KukanGlobalStack and requiring a 2-stack configuration
- **Increased cost**: CloudFront → ALB data transfer incurs double billing; WAF can also be duplicated
- **Operational overhead**: Request path becomes 3 stages (CloudFront → ALB → Fargate) making troubleshooting difficult;
  logs are also split across 2 locations

The following are also removed:

- **CloudFront distribution**: `infra/lib/constructs/cdn.ts`
- **Origin Verify Secret**: Header verification between CloudFront and origin
- **KukanGlobalStack** (us-east-1): Management stack for CloudFront ACM certificates and WAF WebACL
- **CloudFront Function** (IP allowlist): Replaced by ALB SG

If global distribution becomes necessary in the future, CloudFront will be reintroduced at that time.

## Impact

- CDK: Configure `web-service.ts` with ECS Fargate + ALB (L2)
- CDK: Remove `cdn.ts`, remove `KukanGlobalStack` (single-stack configuration)
- CDK: Custom domain configured directly via ALB Listener + ACM + Route53
- CDK: IP restriction implemented via ALB SG (WAF is optional)
- CDK: AwsCustomResource (modifyListener/modifyRule) no longer needed
- CDK: Remove NAT Instance / NAT Gateway (Public subnet + `assignPublicIp: true`)
- CDK: Change Private subnets to `PRIVATE_ISOLATED` (dedicated to DB / OpenSearch)
- VPC Connector: No longer needed (Fargate runs directly within the VPC)
- Origin Verify Secret: Removed
- Docker: No changes (existing `web` target used as-is)

## Addendum: web scaling metric moves from request count to CPU (2026-09-27)

The web service's autoscaling moves from `ALBRequestCountPerTarget` (target 1,000
requests/min/task) to **target tracking on `ECSServiceAverageCPUUtilization`
(target 60%)**. The request-count policy is removed, leaving CPU as the only
metric. Cooldowns are set explicitly: 180 seconds for scale-out, 300 seconds for
scale-in.

### Measurements

**Origin limits (local)**: the web image was run with limited CPU and memory,
and uncached SSR pages (9 dataset list pages, cycling through 167 detail pages)
were fetched for 60 seconds each at concurrency 1 to 16 (Core i9-12900; one
core is faster than Fargate's x86, so these are upper-side values).

| Configuration              | List limit | Detail limit | p95 (4 concurrent, list / detail) | CPU per request |
| -------------------------- | ---------- | ------------ | --------------------------------- | --------------- |
| 0.25 vCPU / 512 MB (small) | ~9 rps     | ~8 rps       | 0.78 / 1.21 s                     | 28–31 ms        |
| 0.5 vCPU / 1 GB (medium)   | ~29 rps    | ~20 rps      | 0.29 / 0.40 s                     | 17–24 ms        |
| 1 vCPU / 2 GB (large)      | ~60 rps    | ~46 rps      | 0.10 / 0.10 s                     | 17–21 ms        |

- Every configuration reached **100% CPU at a concurrency of 1**; more
  concurrency did not raise throughput, only latency. Memory stayed under
  250 MB on small / medium and is not the constraint
- small costs 1.5× the CPU per request: it used up its 25 ms share of every
  100 ms period and was throttled each time

**demo measurements (small, 3 sites, 14 days of 1-minute data)**:

- On the busiest site, regressing CPU on request count gives about 14 ms per
  request (R² 0.51). **1,000 requests/min lands exactly at 100% CPU.** The
  busiest minute was 444 requests/min at 42% CPU
- Another site is lighter at about 6 ms per request, yet had minutes at 100%
  CPU with few requests (resource queries). Request cost differs by more than
  2× between sites
- Replaying a 60% CPU target over the same 14 days, the scale-out condition
  (3 consecutive minutes above target) fired 0 times on all three sites.
  Minutes above 60% ran at most 2 in a row, so a query's short burst does not
  move the task count

### Decision

- **No single request count fits every configuration.** 1,000 requests/min
  fires after saturation on small, and at about 30% of the limit on large.
  Per-size values would still not track request cost, which varies by page
  and by site
- **CPU reflects request cost directly.** Every load measured was CPU-bound.
  The query child process runs in the same task cgroup, so its CPU counts too
- **No request-count policy alongside.** With several policies, scale-in
  happens only when all of them agree, so keeping a hard-to-calibrate metric
  would only hold scale-in back
- **Target 60%**: added tasks take 4–5 minutes to help (the alarm's
  3 minutes plus task startup and health checks, 60–70 seconds in demo's
  deploy records). The headroom covers load growth in that window
- **Cooldowns**: scale-out is 180 seconds. An added task takes 60–70 seconds
  to start and pass health checks, then a minute or two to show in the
  one-minute CPU average; until then the average still reflects the old task
  count, and the cooldown keeps that same reading from adding a second step.
  By Application Auto Scaling's rules, a scale-out still happens during the
  cooldown when the metric asks for more than was already added, so a larger
  rise in load is not held back. Scale-in is set explicitly to 300 seconds,
  the same as the CDK default

### Out of scope

- Memory-based scaling: an OOM from a single query happens per task and more
  tasks do not prevent it (handled by running queries in a child process)
- Pinning `desiredCount` to minSize at deploy time (tied to ADR-041's
  connection budget)

## Related

- ADR-018 (superseded): `docs/adr/en/018-app-runner-plus-fargate.md`
- ADR-012 (single-origin design): `docs/adr/en/012-api-as-library-single-origin.md`
- CDK implementation: `infra/lib/constructs/web-service.ts`
- AWS official: [App Runner availability change](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html)
