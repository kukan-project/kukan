> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/027-cloudfront-reintroduction.md`](../jp/027-cloudfront-reintroduction.md).

# ADR-027: CloudFront Reintroduction (Page Caching + WAF Integration)

## Status

**Accepted**

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

| ADR-020 drawback                                     | Addressed in this ADR                                                                   |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| us-east-1 ACM certificate cross-region dependency    | ARN linked via CDK `crossRegionReferences`. 2-stack configuration is accepted           |
| CloudFront → ALB data transfer double billing        | AWS internal transfer is free. CloudFront transfer rate is cheaper than EC2→Internet    |
| Double WAF cost                                      | WAF consolidated to CloudFront side (ALB WAF removed)                                   |
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

| Condition              | CloudFront Behavior                                               |
| ---------------------- | ----------------------------------------------------------------- |
| No session cookie      | Serve from cache (on hit) / Forward to origin and cache (on miss) |
| Session cookie present | Always forward to origin (no caching)                             |

**Detection method**: CloudFront Functions (Viewer Request) inspects the Cookie header.
When a session cookie is present, a unique value is added to the cache key to bypass caching.

#### Page Classification

| Path                                | Does content change with login?                              | Caching                          |
| ----------------------------------- | ------------------------------------------------------------ | -------------------------------- |
| `/dataset` (listing)                | Changes (private dataset visibility)                         | No cookie → cached               |
| `/organization`, `/group` (listing) | No change                                                    | No cookie → cached               |
| `/dataset/[name]` (detail)          | Changes (`canManage` shows admin UI, private viewing rights) | No cookie → cached               |
| `/dashboard/*`                      | Auth required                                                | Always bypassed (cookie present) |
| `/auth/*`                           | —                                                            | Always bypassed                  |
| `/api/*`                            | Auth dependent                                               | Always bypassed                  |
| `/_next/static/*`                   | No change                                                    | Long-term cache (cookie ignored) |

Aspects of public pages that change with login status:

- **Header**: Login button ↔ user menu
- **Dataset listing**: `buildVisibilityFilters` changes private dataset visibility
- **Dataset detail**: Private dataset viewing rights + `canManage` controls admin UI display

All of these are bypassed for logged-in users (cookie present) and forwarded to origin,
ensuring proper permission checks. Only public data for unauthenticated users is cached,
and there is no risk of private datasets leaking via cache.

### Cache Behavior Design

| Priority | Path Pattern      | Cache Policy                 | Origin Request Policy           | Notes                     |
| -------- | ----------------- | ---------------------------- | ------------------------------- | ------------------------- |
| 1        | `/_next/static/*` | Long-term cache (TTL 1 year) | None                            | Content-hashed, immutable |
| 2        | `/api/*`          | Cache disabled               | All Viewer                      | Auth, CRUD, MCP           |
| 3        | `/auth/*`         | Cache disabled               | All Viewer                      | Better Auth               |
| 4        | `/*` (default)    | TTL 60–300 seconds           | Cookie forwarding (CF Function) | HTML pages                |

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

| Item          | Before (ALB)                           | After (CloudFront)           |
| ------------- | -------------------------------------- | ---------------------------- |
| Scope         | REGIONAL                               | CLOUDFRONT                   |
| Region        | ap-northeast-1                         | us-east-1 (KukanGlobalStack) |
| Attached to   | ALB                                    | CloudFront Distribution      |
| Managed rules | Same (Common, BadInputs, IpReputation) | Same                         |
| On cache hit  | WAF skipped                            | **Inspected by WAF**         |
| IP reputation | Ineffective on cache hits              | Effective on all requests    |
| Cost          | ~$9/month                              | ~$9/month (not doubled)      |

ALB WAF is removed. Direct access to the ALB is prevented by Origin Verify,
making ALB-side WAF unnecessary.

### IP Restriction

With CloudFront in front, the source IP of all requests reaching the ALB is
a CloudFront IP. **ALB Security Group cannot distinguish client IPs**.

IP restriction is implemented via **CloudFront Function (Viewer Request)**.
When `allowedIpRanges` is configured, CDK embeds the IP list into the CF Function code
at synth time, performing CIDR matching (IPv4/IPv6) against `event.viewer.ip`.
Requests from IPs outside the allowlist receive a 403 response.
WAF IP set rules are not used — implementing this in the CF Function allows IP restriction
without WAF (`enableWaf: false` saves ~$9/month).
ALB SG IP restriction rules are removed, replaced by CloudFront-only access via Origin Verify.

### Origin Verify (Preventing Direct ALB Access)

When CloudFront sends requests to the origin, it includes a custom header
`X-Origin-Verify: <secret>`.

- Secret is auto-generated in Secrets Manager (managed by CDK)
- **ALB listener rule** validates the header (default action: 403, forwards only when header matches)
- ALB health checks bypass listener rules and are not affected
- No application code changes required (enforced at infrastructure level)
- On-premises / local environments do not use CloudFront, so Origin Verify is not needed

### CDK Stack Configuration

```
KukanGlobalStack (us-east-1)          * ARNs linked via crossRegionReferences
├── ACM Certificate (for CloudFront, only when domainName is set)
└── WAF WebACL (CLOUDFRONT scope, only when enableWaf is enabled)
    └── Managed rules (Common, BadInputs, IpReputation)

KukanStack (ap-northeast-1)
├── Network (VPC, SG)
├── Database (RDS/Aurora)
├── Storage (S3)
├── Queue (SQS)
├── Search (OpenSearch)
├── ECS Cluster
├── Origin Verify Secret (Secrets Manager)  ← Shared by ALB + CloudFront
├── WebService (Fargate + ALB)
│   └── ALB Listener Rule (X-Origin-Verify header validation)
├── WorkerService (Fargate)
├── CDN (CloudFront Distribution)
│   ├── CloudFront Functions (IP restriction + cookie bypass)
│   ├── Cache Policy / Origin Request Policy
│   └── Custom origin header (X-Origin-Verify)
└── Route53 A (Alias) → CloudFront
```

### Impact on On-Premises Version

None. CloudFront is AWS-specific infrastructure.
Origin Verify is enforced at the ALB listener rule level, requiring no application code changes.
On-premises / Docker Compose environments are not affected.

## Cost Impact

| Item                     | Before          | After                  | Difference                          |
| ------------------------ | --------------- | ---------------------- | ----------------------------------- |
| ALB fixed cost           | ~$18/month      | ~$18/month             | ±$0                                 |
| WAF                      | ~$9/month (ALB) | ~$9/month (CloudFront) | ±$0                                 |
| CloudFront requests      | —               | ~$1–3/month            | +$1–3                               |
| CloudFront data transfer | —               | $0.085/GB              | Cheaper than EC2 direct ($0.114/GB) |
| **Total**                | —               | —                      | **+$1–3/month** (at small scale)    |

For higher data transfer volumes, CloudFront is cheaper ($0.085 vs $0.114/GB).

## Migration Steps

### Implementation (Complete)

1. ADR approval
2. Create `infra/lib/global-stack.ts` (us-east-1: ACM certificate + WAF WebACL)
3. Create `infra/lib/constructs/cdn.ts` (CloudFront Distribution, Origin Verify Secret)
4. Create `infra/lib/cf-functions/viewer-request.js` (IP restriction + cookie bypass)
5. Update `infra/lib/constructs/network.ts`
   - Remove ALB SG IP restriction rules (IP restriction moved to CF Function)
   - ALB SG allows port 80 only (CloudFront → ALB uses HTTP)
6. Update `infra/lib/kukan-stack.ts`
   - Remove regional ACM certificate (CloudFront terminates TLS)
   - Add CDN construct
   - Change Route53 record from CNAME → ALB to A (Alias) → CloudFront
   - Remove ALB WAF Association (WAF migrated to CloudFront side)
7. Update `infra/bin/app.ts` (KukanGlobalStack + crossRegionReferences)

### Deployment

```bash
# 1. GlobalStack (us-east-1)
npx cdk deploy KukanGlobalStack

# 2. KukanStack (ap-northeast-1)
npx cdk deploy KukanStack
```

#### Note for Migrating from Existing Environments

The old ALB configuration has an HTTPS listener (port 443) and an HTTP→HTTPS redirect listener
(port 80). The new configuration uses only an HTTP listener (port 80). CloudFormation attempts to
create the new listener before deleting the old one, causing a conflict on port 80.

**Workaround**: Manually delete the old listeners before deploying.

```bash
# List ALB listeners
aws elbv2 describe-listeners --load-balancer-arn <ALB_ARN> \
  --query 'Listeners[*].[Port,Protocol,ListenerArn]' --output table

# Delete port 80 (HTTP redirect) and port 443 (HTTPS) listeners
aws elbv2 delete-listener --listener-arn <port-80-listener-arn>
aws elbv2 delete-listener --listener-arn <port-443-listener-arn>

# Redeploy
npx cdk deploy KukanStack
```

This step is only needed for a one-time migration from the old configuration. Not needed for fresh deployments.

### Verification

```bash
# Confirm cache hits (unauthenticated)
curl -sI https://<domain> | grep x-cache
# → X-Cache: Hit from cloudfront

# Confirm Origin Verify blocks direct ALB access
curl -sI http://<ALB DNS>
# → 403 Forbidden

# Confirm bypass when logged in
# Verify API endpoint functionality
# Verify WAF rule behavior (when enableWaf is enabled)
```

## Related

- ADR-020 (CloudFront removal history): `docs/adr/en/020-ecs-fargate-alb-migration.md`
- ADR-012 (single-origin design): `docs/adr/en/012-api-as-library-single-origin.md`
- Previous CloudFront implementation: git commit `9adc82c`
