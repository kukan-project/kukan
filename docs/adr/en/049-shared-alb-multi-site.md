> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/049-shared-alb-multi-site.md`](../jp/049-shared-alb-multi-site.md).

# ADR-049: Consolidating the ALB Across Sites (Per-Site ALB → Shared ALB + Header Routing)

## Status

**Accepted** — implemented 2026-09-08. This does not supersede ADR-041
(multi-site deploy); it **extends** it. It settles the second stage of the item ADR-041 deferred in its table:
"Intermediate (staged optimization): the ALB starts out per site; sharing it via
host-based routing is a second stage."

## Context

ADR-041's principle is "share the hourly-billed _boxes_; keep the _logical
resources_ that own data and namespaces per site". The ALB belongs to the former,
but the first implementation stage placed it in the SiteStack. Today
`WebServiceConstruct` creates one internal ALB per site, and CloudFront reaches it
through a VPC origin (ADR-027).

### The ALB is ~40% of the marginal fixed cost of a site

Estimate for ap-northeast-1, $1=¥152, 730h/month, scale=small (web 0.25 vCPU /
0.5 GB × 1 task, worker 0.25 vCPU / 1 GB × 1 task):

| Item                                     | Unit price | Per site / month |
| ---------------------------------------- | ---------- | ---------------- |
| ALB fixed cost                           | $0.0243/h  | **$17.7**        |
| Fargate web (1 task minimum)             | —          | $11.3            |
| Fargate worker (1 task minimum)          | —          | $13.3            |
| Secrets Manager (auth + site DB)         | $0.40 each | $0.8             |
| **Marginal fixed cost of adding a site** |            | **~$43**         |

Savings from consolidating onto one ALB:

| Sites | Today (ALB total) | Consolidated | Saving / month  |
| ----- | ----------------- | ------------ | --------------- |
| 2     | $35.5             | $17.7        | $17.7 (~¥2,700) |
| 5     | $88.7             | $17.7        | $71 (~¥10,800)  |
| 10    | $177              | $17.7        | $160 (~¥24,300) |

LCUs are usage-billed, so the total does not change — it drops slightly, because
low-traffic sites no longer each pay the rounding of their own max dimension. The
rule-evaluation dimension (1 LCU = 1000 evaluations/s) is noise at the site counts
we plan for. Warm-up against sudden spikes also works in favor of aggregation.

### The routing-key premise has changed since ADR-041

ADR-041 assumed host-based routing, but ADR-027 subsequently put CloudFront in
front, and `CdnConstruct` uses `ALL_VIEWER_EXCEPT_HOST_HEADER`. The Host that
reaches the origin is therefore **not the viewer's host but the VPC origin's
domain name (the ALB's DNS name)**, so host-based routing does not work as-is.
Making it work would require switching the origin request policy on all three
behaviors to `ALL_VIEWER`, and for sites without a custom domain (published on
`*.cloudfront.net`) the routing key would change whenever the distribution is
recreated.

## Options considered

### A) Keep the status quo (per-site ALB)

Isolation is strongest, and one site's ALB misconfiguration cannot reach another.
But against ADR-041's sharing principle there is no reason to share Aurora /
OpenSearch / the VPC and yet keep the ALB per site. $17.7/month accumulates
linearly with site count.

### B) Shared ALB + Host header routing

ADR-041's original assumption. Change the origin request policy to `ALL_VIEWER`
so the viewer's Host passes through to the origin. The routing key becomes the
natural "site's public domain", but as noted this requires CloudFront changes and
is unstable for sites without a custom domain. Whether Host must join the cache
key is another open question.

### C) Shared ALB + origin custom header routing (adopted)

Attach `X-Kukan-Site: kukan-<env>-<site>` to the CloudFront origin definition and
branch the ALB listener rules on an `http-header` condition. Origin request
policies, cache policies and CF Functions are untouched, and nothing depends on
whether the site has a domain.

### D) Consolidate CloudFront into one distribution

CloudFront has no hourly charge, so there is nothing to save; meanwhile IP
allowlists and basic auth (CF Function), WAF and cache policies are all
per-distribution, so consolidating would lose the per-site edge gate. Rejected.

### E) Drop the ALB (replace with NLB / point CloudFront directly at ECS)

A CloudFront VPC origin endpoint can only be an ALB, an NLB, or an EC2 instance —
never an ECS service directly. An NLB is billed at the same hourly rate as an ALB
and cannot express L7 header conditions, so it cannot host the consolidation.
Not viable.

## Decision

**Adopt option C. Move the ALB and the CloudFront VPC origin into the
SharedStack, keep target groups and listener rules in the SiteStack, and route to
sites by an origin custom header.**

1. **SharedStack**: one internal ALB, an HTTP:80 listener (`open: false`, default
   action a fixed 404 response), and one `cloudfront.VpcOrigin`
2. **SiteStack**: one `ApplicationTargetGroup` and one listener rule (condition
   `http-header X-Kukan-Site = kukan-<env>-<site>`). Health checks and auto
   scaling stay per site
3. **The routing key is an origin custom header.** Its value is the site key (the
   result of `envPrefix()`). The ALB is internal and its SG only admits the
   CloudFront managed prefix list (`NetworkConstruct`), so **this header is a
   separation key, not a security boundary** — do not overload it as origin
   verification
4. **Listener rule priorities are never numbered from the `sites[]` index** —
   removing or reordering sites would shift existing priorities and could
   collide mid-way through the serial deploy (ADR-041), failing the deployment.
   The default is a **stable hash of the site name (FNV-1a, 1000–49999)**,
   overridable per site with `SiteConfig.albPriority` (explicit values are
   confined to 1–999, so they can never collide with the derived band).
   `validateSites()` checks the effective values for uniqueness and, on a
   collision, errors asking for an explicit value **on the site being added** (relaxed
   at implementation time from "mandatory explicit declaration" so that
   existing `sites: [{ name }]` configs, docs and tests keep working)
5. **Create exactly one VPC origin, on the shared side.** Creating one per site
   would duplicate ENI sets against the same ALB and spend the account's VPC
   origin quota (default 25, adjustable) once per site. The shared side's own
   constraint is "distributions associated with the same VPC origin: 50" (no
   increase offered), which becomes the sites-per-environment ceiling (see Scale
   ceiling)
6. **The single-site shape (`KukanStack`) is unchanged.** Add an optional
   `sharedListener` to `WebServiceProps`; when absent, the current code path (own
   ALB + `addTargets`) runs exactly as today. The construct tree paths do not
   move, so the single-site golden snapshots do not change by a single line
   (ADR-041's drift guard is preserved)

### Cross-stack references (SSM, following ADR-041)

Loosely coupled through SSM parameters rather than CloudFormation exports.

| Parameter                  | Purpose                                                              |
| -------------------------- | -------------------------------------------------------------------- |
| `alb/listener-arn`         | The SiteStack imports the listener to attach its rule                |
| `alb/dns-name`             | The CloudFront origin's `DomainName` (required even for VPC origins) |
| `cloudfront/vpc-origin-id` | The SiteStack imports the VPC origin                                 |

### CDK facts established up front (verified against aws-cdk-lib 2.268)

- **`addTargets()` throws on an imported listener.** Create the
  `ApplicationTargetGroup` explicitly in the SiteStack and attach it with
  `addTargetGroups(id, { targetGroups, priority, conditions })`. `priority` is
  mandatory whenever conditions are present
- **`scaleOnRequestCount` works with a target group on a shared ALB.** CDK builds
  the resource label by `Fn::Split`-ing the target group's `LoadBalancerArns`
  attribute, so it resolves even from an SSM-derived token ARN
- **VPC origin import is `cloudfront.VpcOrigin.fromVpcOriginId()` plus
  `origins.VpcOrigin.withVpcOrigin(origin, { domainName, customHeaders })`.** An
  imported origin carries no `domainName` attribute, so the ALB's DNS name must be
  passed explicitly (the `alb/dns-name` parameter above)
- **Security groups remain solely managed by `NetworkConstruct`.** The SiteStack
  imports the ALB and web SGs with `mutable: false`, so neither rule creation nor
  target-group registration can rewrite them

## Scale ceiling (what binds first as sites are added)

**The shared ALB is not the ceiling.** Default quotas are 100 rules per ALB, 100
target groups per ALB and 1000 targets per ALB (all adjustable on request), and
one site consumes "1 rule + 1 target group + `web.maxSize` targets". At
scale=small roughly 100 sites fit without any quota increase.

What binds earlier is the following — none of which this ADR makes worse (the VPC
origin case improves).

| Constraint                                                                                                                                                                                           | Where it starts to bite                                           | Mitigation                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **DB connections** (sum of `dbPool.webMax × web.maxSize + dbPool.workerMax × worker.maxTasks` vs `max_connections`)                                                                                  | **First to bind.** ADR-041 validates it at synth and warns/errors | Raise maxACU (a static parameter, so "change ACU → reboot all instances → add the site" in two stages), shrink pools, or split the shared cluster                                                                        |
| **CloudFront per-account quotas**: 20 cache policies / 100 CloudFront Functions / 500 distributions (defaults, adjustable)                                                                           | Cache policies bind at roughly **20 sites**                       | `HtmlCachePolicy` holds no site-specific values, so it can be shared once per environment (open item 3). CF Functions differ per site (IP allowlist, basic auth) and cannot be shared — request an increase at 100 sites |
| **Distributions associated with the same VPC origin: 50** (default, **no increase offered**) — every site uses the environment's shared VPC origin, so this is the **sites-per-environment ceiling** | **50 sites** (hard)                                               | `validateSites` fails synth at the 51st site. Beyond that, split into another environment (shared cluster)                                                                                                               |
| **Shards and heap on the shared OpenSearch domain**                                                                                                                                                  | Worth revisiting in the tens of sites even at medium              | ADR-041's co-tenancy policy (share only across sites with similar SLAs; move a site to its own domain once it outgrows this)                                                                                             |
| **Public subnet IPs** (/24 × 2 AZ ≈ 500, doubled during rolling updates)                                                                                                                             | Around 100 sites                                                  | Widen the subnet CIDR (requires recreating the VPC, so plan a blue/green once large scale is in sight)                                                                                                                   |
| **Serial deploy duration** (ADR-041)                                                                                                                                                                 | Proportional to site count                                        | Trim the number of dev sites. Wave parallelism first requires the connection budget to account for several sites updating at once                                                                                        |

The ALB's LCU has a rule-evaluation dimension (1 LCU = 1000 evaluations/s). Rules
are evaluated in priority order, so a request costs N/2 evaluations on average:
50 sites at 100 req/s is 2500 evaluations/s ≈ 2.5 LCU. Since LCUs are billed on
the maximum of four dimensions, processed bytes and active connections normally
dominate at that scale, so this does not become the driver.

By not creating a VPC origin per site (decision 5), the account's VPC origin
quota and ENI duplication stop scaling with the number of sites. In exchange,
"50 distributions per VPC origin" becomes a hard per-environment ceiling —
`validateSites` fails synth beyond it.

## Trade-offs

- **The edge security boundary does not move**: ADR-027 already consolidated WAF
  onto CloudFront (`CLOUDFRONT` scope, created in us-east-1 by `KukanGlobalStack`
  and attached by `CdnConstruct` via `webAclId`); the ALB carries no association.
  Together with the IP allowlist and basic auth (CF Function), every per-site edge
  gate stays **per distribution, upstream of the shared ALB**. Sharing the ALB
  leaves the inspection points independent per site — traffic that reaches the
  shared ALB has already passed its site's gate
- **Shared blast radius**: an outage or misconfiguration of the single ALB reaches
  every site. Sharing Aurora / OpenSearch already has this property, and ADR-041's
  co-tenancy policy (share only across sites with similar SLA requirements)
  applies unchanged
- **Deploy coupling is one-sided**: rules and target groups live in the SiteStack,
  so **adding or removing a site never touches the SharedStack**. Conversely,
  changing the ALB itself (listener, SG, attributes) affects all sites at once
- **Observability granularity**: ALB-level metrics (`RequestCount`,
  `TargetResponseTime`) become a mix of sites. Per-site figures remain available
  through the TargetGroup dimension. If access logs are enabled later they land in
  one bucket and are separated by the `target_group_arn` field
- **Cross-site interference**: abnormal traffic to one site can affect another's
  latency while the ALB scales. In steady state, aggregation's pre-warming helps
- **Quotas**: 100 rules per ALB, 100 target groups per ALB, 1000 targets per ALB
  (all adjustable on request) — ample headroom for the site counts in view
- **Reversibility is preserved**: moving a site back to a dedicated ALB is
  "re-attach the target group to a new ALB and swap the CloudFront origin", so
  ADR-041's "co-tenancy is not an irreversible decision" still holds
- **Priorities are a deploy-time resource on the shared listener**: `validateSites`
  only sees the configured end state, not the values live rules hold. **Reassigning
  a deployed site's priority to another deployed site's value** (a swap) makes the
  first stack updated in the serial deploy fail with `PriorityInUse` and roll back.
  A site removed from `sites[]` whose stack was not destroyed keeps its rule on the
  shared listener and blocks any new site resolving to the same value (remove a
  site by destroying its stack first, then dropping it from the config)
- **Replacing the shared ALB hits every site**: if the shared ALB (listener) is
  replaced, every site's rule is cascade-deleted and sites stay unreachable until
  the SiteStacks are redeployed serially. Treat it, like the VPC and the cluster,
  as a box that is never replaced

## Migration

A running multi-site environment already has per-site ALBs, so a cutover is
involved.

1. **Deploy the ALB, VPC origin and SSM parameters into the SharedStack.**
   Existing sites are untouched and stay up (the new ALB comes up with nothing
   pointed at it)
2. **Cut sites over one at a time**, serially (as ADR-041 already requires).
   Validation sites first, then production sites

**The cutover deploy carries a risk of a few minutes of 503s.** CloudFormation
does not guarantee the ordering between swapping the ECS service's target group
and updating the CloudFront distribution, so a window can open after the service
detaches from the old ALB and before the new origin propagates.

- **A validation environment closed off by IP allowlist or basic auth**: a single
  cutover during a maintenance window is fine. Rollback is a revert and redeploy
  (a few minutes to recreate the ALB)
- **A production site that is publicly served**: needs two stages. (a) Register
  the new target group alongside the old one so both paths are live, and switch
  the CloudFront origin to the shared VPC origin; (b) in a separate deploy, drop
  the old ALB and the old target group registration. An ECS service can register
  several load balancers, so the old path stays alive throughout (a). **This
  two-stage path is not implemented** (open item 4) — when this ADR was
  implemented the only multi-site environments predating the shared ALB were
  closed validation environments, and keeping a temporary flag plus dual
  registration in the mainline was not worth it. Implement it as a temporary
  `SiteConfig` flag if a publicly served site ever has to be cut over in place

Operational notes for the cutover (also in `docs/specs/jp/phase4-deploy.md`):

- Site stacks resolve the new SSM parameters (`alb/*`, `cloudfront/vpc-origin-id`)
  at deploy time, so **a site's own `cdk diff` / `cdk deploy` fails until the
  SharedStack has been updated** (parameter not found)
- The pipeline cuts sites over starting from `sites[0]`. To choose the order
  (validation site → production site), cut over by hand before the pipeline runs
- Verify afterwards that the old ALB / VPC origin were deleted. CloudFormation does
  not fail the stack on cleanup-phase deletion failures; leftovers become orphans

## Impact

- `infra/lib/shared-stack.ts`: add the ALB, listener, VPC origin and three SSM
  parameters
- `infra/lib/site-stack.ts` / `composition.ts`: import the shared listener and VPC
  origin and pass them through `SiteSurface`
- `infra/lib/constructs/web-service.ts`: the optional `sharedListener` branch
  (current path unchanged when absent)
- `infra/lib/constructs/cdn.ts`: optional VPC origin import and origin custom
  headers
- `infra/lib/config.ts`: `SiteConfig.albPriority` (optional), `resolveAlbPriority()`,
  uniqueness validation in `validateSites()`
- `infra/lib/constructs/shared-alb.ts`: new `SharedAlbConstruct` bundling the ALB,
  listener and VPC origin
- `infra/lib/__tests__/`: update the multi-site snapshots (the single-site ones
  staying unchanged is the guard). Add a synth-error test for duplicate rule
  priorities
- `docs/specs/jp/phase4-deploy.md` / `en`: document the shared ALB and
  `albPriority` in the multi-site setup steps

## Open items

1. **Sharing the worker** (ADR-041's stated future optimization: tag SQS messages
   with the site and resolve connections dynamically). Of the $25 marginal fixed
   cost per site left after this ADR, $13.3 is the worker task — the next lever
2. **ALB access logs** are out of scope here. If enabled, assume one shared bucket
   with per-site separation via `target_group_arn`
3. **Sharing `HtmlCachePolicy` within an environment.** It holds no site-specific
   values yet is created per site, and hits CloudFront's per-account quota
   (default 20) at around 20 sites. It is a small change independent of this ADR;
   whether to fold it into the same PR is an implementation-time call
4. **The two-stage cutover for publicly served sites (temporary dual-registration
   flag) is not implemented.** Implement it when needed (see Migration)
5. **Non-AWS environments (Docker Compose) are unaffected.** As ADR-041 notes, the
   edge is a single Caddy with virtual hosts — already consolidated

## Related

- ADR-041 (multi-site deploy): this ADR is the extension that settles its "second
  stage"; not a replacement
- ADR-027 (reintroducing CloudFront): VPC origins and
  `ALL_VIEWER_EXCEPT_HOST_HEADER` are the premise behind the routing-key choice
- ADR-020 (Web = ECS Fargate + ALB): the self-managed ALB architecture itself is kept
- ADR-031 (multi-environment deploy): one shared ALB per environment
- ADR-042 (multi-brand build): per-site web images are unaffected and orthogonal to
  ALB sharing
