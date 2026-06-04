> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/027-cloudfront-reintroduction.md`](../jp/027-cloudfront-reintroduction.md).

# ADR-027: CloudFront Reintroduction (Page Caching + WAF Integration)

## Status

**Proposed**

## Context

ADR-020 removed CloudFront and adopted a configuration where the ALB serves as the front.
The removal rationale was that "ALB can replace all CloudFront functions," but
as operations progressed, the need for **page caching** emerged.

### Current Issues

1. **Public page SSR accesses the DB on every request**
   - Dataset listing/detail, organization listing/detail, group listing/detail, top page
   - `serverFetch` → Hono `app.request()` → Drizzle → PostgreSQL executes every time
   - ISR (Next.js Incremental Static Regeneration) can reduce DB load, but
     Fargate's filesystem is ephemeral so cache is lost on task restart,
     and cache is not shared across multiple tasks

2. **WAF exists only on the ALB**
   - When CloudFront is placed in front, cache hits don't reach the ALB
   - ALB-side WAF cannot perform IP reputation checks on cache-hit requests

### Problems CloudFront Reintroduction Solves

- Serve public pages for unauthenticated users from edge cache → reduce DB load
- WAF can inspect even cache-hit requests (CloudFront scope)
- Protect origin during sudden traffic spikes

### Addressing CloudFront Drawbacks Cited in ADR-020

| ADR-020 drawback                                 | Addressed in this ADR                                                            |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| us-east-1 ACM certificate cross-region dependency | ARN linked via SSM parameters. 2-stack configuration is accepted                |
| CloudFront → ALB data transfer double billing    | AWS internal transfer is free. CloudFront transfer rate is cheaper than EC2→Internet |
| Double WAF cost                                  | WAF consolidated to CloudFront side (ALB WAF removed)                            |
| 3-stage request path makes troubleshooting difficult | 2 log sources (CloudFront access logs + ALB logs), but Origin Verify clarifies the path |

## Decision

**Reintroduce CloudFront and migrate WAF to CloudFront scope.**

### Architecture

```
User → CloudFront (WAF + Cache) → ALB → ECS Fargate (Next.js + Hono)
```

### Cache Strategy: Session Cookie-Based Bypass

Switch between caching and bypass based on the presence of the Better Auth session cookie
(`__Secure-better-auth.session_token`). No application code changes required.

| Condition               | CloudFront Behavior                                                         |
| ----------------------- | --------------------------------------------------------------------------- |
| No session cookie       | Serve from cache (on hit) / Forward to origin and cache (on miss)           |
| Session cookie present  | Always forward to origin (no caching)                                       |

**Detection method**: CloudFront Functions (Viewer Request) inspects the Cookie header.
When a session cookie is present, a unique value is added to the cache key to bypass caching.

#### Page Classification

| Path                              | Does content change with login?                              | Caching                               |
| --------------------------------- | ------------------------------------------------------------ | -------------------------------------- |
| `/dataset` (listing)              | Changes (private dataset visibility)                         | No cookie → cached                     |
| `/organization`, `/group` (listing) | No change                                                  | No cookie → cached                     |
| `/dataset/[name]` (detail)        | Changes (`canManage` shows admin UI, private viewing rights) | No cookie → cached                     |
| `/dashboard/*`                    | Auth required                                                | Always bypassed (cookie present)       |
| `/auth/*`                         | —                                                            | Always bypassed                        |
| `/api/*`                          | Auth dependent                                               | Always bypassed                        |
| `/_next/static/*`                 | No change                                                    | Long-term cache (cookie ignored)       |

Aspects of public pages that change with login status:

- **Header**: Login button ↔ user menu
- **Dataset listing**: `buildVisibilityFilters` changes private dataset visibility
- **Dataset detail**: Private dataset viewing rights + `canManage` controls admin UI display

All of these are bypassed for logged-in users (cookie present) and forwarded to origin,
ensuring proper permission checks. Only public data for unauthenticated users is cached,
and there is no risk of private datasets leaking via cache.

### Cache Behavior Design

| Priority | Path Pattern       | Cache Policy                 | Origin Request Policy           | Notes                              |
| -------- | ------------------ | ---------------------------- | ------------------------------- | ---------------------------------- |
| 1        | `/_next/static/*`  | Long-term cache (TTL 1 year) | None                            | Content-hashed, immutable          |
| 2        | `/api/*`           | Cache disabled               | All Viewer                      | Auth, CRUD, MCP                    |
| 3        | `/auth/*`          | Cache disabled               | All Viewer                      | Better Auth                        |
| 4        | `/*` (default)     | TTL 60–300 seconds           | Cookie forwarding (CF Function) | HTML pages                         |

### Cache TTL and Update Strategy

Public HTML TTL is set to **60–300 seconds**, using natural expiration.
Explicit invalidation (`CreateInvalidation` API) is not introduced in the initial phase.

**Reasons**:

- Data catalog public pages have update frequencies on the order of minutes to hours
- 60–300 second delay is acceptable
- Invalidation requires CloudFront integration code on the API side, adding complexity
- Can be added in the future if needed

### WAF Configuration

WAF is migrated from ALB (REGIONAL) to CloudFront (CLOUDFRONT scope).

| Item                  | Before (ALB)                            | After (CloudFront)            |
| --------------------- | --------------------------------------- | ----------------------------- |
| Scope                 | REGIONAL                                | CLOUDFRONT                    |
| Region                | ap-northeast-1                          | us-east-1 (KukanGlobalStack)  |
| Attached to           | ALB                                     | CloudFront Distribution       |
| Managed rules         | Same (Common, BadInputs, IpReputation)  | Same                          |
| On cache hit          | WAF skipped                             | **Inspected by WAF**          |
| IP reputation         | Ineffective on cache hits               | Effective on all requests     |
| Cost                  | ~$9/month                               | ~$9/month (not doubled)       |

ALB WAF is removed. Direct access to the ALB is prevented by Origin Verify,
making ALB-side WAF unnecessary.

### IP Restriction

With CloudFront in front, the source IP of all requests reaching the ALB is
a CloudFront IP. **ALB Security Group cannot distinguish client IPs**.

IP restriction is implemented via **CloudFront WAF IP set rules**.
When `allowedIpRanges` is configured, an IP set condition is added to the WAF WebACL,
blocking requests from IPs outside the allowlist.
ALB SG IP restriction rules are removed, replaced by CloudFront-only access via Origin Verify.

### Origin Verify (Preventing Direct ALB Access)

When CloudFront sends requests to the origin, it includes a custom header
`X-Origin-Verify: <secret>`.

- Secret is managed in Secrets Manager
- Hono middleware validates the header and returns 403 on mismatch
- Skipped when `ORIGIN_VERIFY_SECRET` environment variable is unset (on-premises/local compatibility)

### CDK Stack Configuration

```
KukanGlobalStack (us-east-1)
├── ACM Certificate (for CloudFront)
├── WAF WebACL (CLOUDFRONT scope)
│   ├── Managed rules (Common, BadInputs, IpReputation)
│   └── IP set rule (only when allowedIpRanges configured)
└── SSM Parameter (exports certificateArn, webAclArn)

KukanStack (ap-northeast-1)
├── Network (VPC, SG)
├── Database (RDS/Aurora)
├── Storage (S3)
├── Queue (SQS)
├── Search (OpenSearch)
├── ECS Cluster
├── WebService (Fargate + ALB)  ← ALB WAF removed
├── WorkerService (Fargate)
├── CDN (CloudFront Distribution)  ← New
│   ├── CloudFront Functions (Cookie-based cache bypass)
│   ├── Cache Policy / Origin Request Policy
│   └── Origin Verify Secret
└── Route53 A (Alias) → CloudFront  ← Changed from CNAME → ALB
```

### Impact on On-Premises Version

None. CloudFront is AWS-specific infrastructure.
The Origin Verify middleware is designed to skip when the environment variable is unset,
so it has no impact on on-premises / Docker Compose environments.

## Cost Impact

| Item                    | Before        | After                | Difference                      |
| ----------------------- | ------------- | -------------------- | ------------------------------- |
| ALB fixed cost          | ~$18/month    | ~$18/month           | ±$0                             |
| WAF                     | ~$9/month (ALB) | ~$9/month (CloudFront) | ±$0                          |
| CloudFront requests     | —             | ~$1–3/month          | +$1–3                           |
| CloudFront data transfer | —            | $0.085/GB            | Cheaper than EC2 direct ($0.114/GB) |
| **Total**               | —             | —                    | **+$1–3/month** (at small scale) |

For higher data transfer volumes, CloudFront is cheaper ($0.085 vs $0.114/GB).

## Migration Steps

1. ADR approval
2. Create KukanGlobalStack (us-east-1: ACM certificate + WAF WebACL)
3. Create `infra/lib/constructs/cdn.ts` (CloudFront Distribution, CF Functions, Origin Verify)
4. Add `enableCloudFront` option to `infra/lib/config.ts`
5. Update `infra/lib/constructs/network.ts`
   - Remove ALB SG IP restriction rules (remove SG rules from `allowedIpRanges`)
   - ALB SG allows access only from CloudFront (controlled via Origin Verify)
6. Update `infra/lib/kukan-stack.ts`
   - Add CDN construct
   - Change Route53 record from CNAME → ALB to A (Alias) → CloudFront
   - Remove ALB WAF Association (WAF migrated to CloudFront side)
7. Add Origin Verify middleware (`packages/api/src/middleware/origin-verify.ts`)
8. Deploy: KukanGlobalStack → KukanStack in order
9. Verification
   - Confirm cache hits with `X-Cache: Hit from cloudfront`
   - Confirm bypass when logged in
   - Verify API endpoint functionality
   - Verify WAF rule behavior

## Related

- ADR-020 (CloudFront removal history): `docs/adr/en/020-ecs-fargate-alb-migration.md`
- ADR-012 (single-origin design): `docs/adr/en/012-api-as-library-single-origin.md`
- Previous CloudFront implementation: git commit `9adc82c`
