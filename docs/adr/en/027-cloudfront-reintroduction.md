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

| ADR-020 drawback                                     | Addressed in this ADR                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| us-east-1 ACM certificate cross-region dependency    | ARN linked via CDK `crossRegionReferences`. 2-stack configuration is accepted        |
| CloudFront → ALB data transfer double billing        | AWS internal transfer is free. CloudFront transfer rate is cheaper than EC2→Internet |
| Double WAF cost                                      | WAF consolidated to CloudFront side (ALB WAF removed)                                |
| 3-stage request path makes troubleshooting difficult | 2 log sources (CloudFront access logs + ALB logs), but VPC origin clarifies the path |

## Decision

**Reintroduce CloudFront and migrate WAF to CloudFront scope.**

### Architecture

```
User → CloudFront (WAF + Cache) → [VPC Origin] → ALB (internal) → ECS Fargate (Next.js + Hono)
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

| Priority | Path Pattern      | Cache Policy                 | Origin Request Policy           | Notes                                |
| -------- | ----------------- | ---------------------------- | ------------------------------- | ------------------------------------ |
| 1        | `/_next/static/*` | Long-term cache (TTL 1 year) | None                            | Content-hashed, immutable            |
| 2        | `/api/*`          | Cache disabled               | All Viewer                      | Auth, CRUD, MCP                      |
| 3        | `/auth/*`         | Cache disabled               | All Viewer                      | Better Auth                          |
| 4        | `/robots.txt`     | TTL 1 hour (empty key)       | None                            | Not split by locale, cookie or query |
| 5        | `/sitemap*`       | TTL 1 hour (empty key)       | None                            | `/sitemap.xml` and `/sitemap/*`      |
| 6        | `/*` (default)    | TTL 60–300 seconds           | Cookie forwarding (CF Function) | HTML pages                           |

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

ALB WAF is removed. The ALB is internal (within VPC), so it is not directly
accessible from the internet.

### Access Control (IP allowlist + Basic auth)

With CloudFront in front, the source IP of all requests reaching the ALB is
a CloudFront IP. **ALB Security Group cannot distinguish client IPs**.

Access control is implemented via **CloudFront Function (Viewer Request)**.
It supports two gates, **OR-combined** (a request passes if either is satisfied):

- **IP allowlist**: when `allowedIpRanges` is configured, CDK embeds the IP list into
  the CF Function code at synth time, performing CIDR matching (IPv4/IPv6) against
  `event.viewer.ip`.
- **Basic auth**: when `basicAuth: { username, password }` is configured, CDK embeds
  `base64("user:pass")` into the CF Function at synth time and compares it against the
  `Authorization` header (encoded at synth time because CloudFront Functions have no
  `btoa`/`Buffer` at runtime).

When both are set, requests from office IPs pass without a password, while external
collaborators with no fixed IP pass via Basic auth — intended for sharing a restricted
site with users who lack a stable IP.

The reject status code is `401` (with `WWW-Authenticate: Basic`, so the browser prompts
for credentials) when Basic auth is configured, or `403` when only the IP allowlist is set.

WAF IP set rules are not used — implementing this in the CF Function allows access control
without WAF (`enableWaf` defaults OFF when either `allowedIpRanges` or `basicAuth` is set,
saving ~$9/month).

**Note**: Basic auth credentials are embedded (base64) in the CF Function source, which is
readable via the console/API, so this is a light gate (e.g. staging protection) only. Pair
it with real app auth (Better Auth) or WAF for sensitive data.

### Preventing Direct ALB Access (VPC Origin)

CloudFront VPC Origin is used to connect CloudFront directly to the internal ALB within the VPC.

- ALB is `internetFacing: false` (no public IPs)
- CloudFront creates ENIs in the VPC and accesses the ALB via private network
- ALB SG allows port 80 only from the CloudFront managed prefix list (`com.amazonaws.global.cloudfront.origin-facing`)
- No Origin Verify header or Secrets Manager secret required (network-level isolation)
- On-premises / local environments do not use CloudFront, so no impact
- Eliminates ALB public IPv4 addresses, saving **~$7.5/month**

### CDK Stack Configuration

```
KukanGlobalStack (us-east-1)          * ARNs linked via crossRegionReferences
├── ACM Certificate (for CloudFront, only when domainName is set)
└── WAF WebACL (CLOUDFRONT scope, only when enableWaf is enabled)
    └── Managed rules (Common, BadInputs, IpReputation)

KukanStack (ap-northeast-1)
├── Network (VPC, SG)
├── Database (RDS/Aurora, including the job queue's `job` table)
├── Storage (S3)
├── Search (OpenSearch)
├── ECS Cluster
├── WebService (Fargate + internal ALB)
├── WorkerService (Fargate)
├── CDN (CloudFront Distribution)
│   ├── VPC Origin → internal ALB
│   ├── CloudFront Functions (access control: IP/Basic + cookie bypass + locale/client IP headers)
│   └── Cache Policy / Origin Request Policy
└── Route53 A / AAAA (Alias) → CloudFront
```

(2026-10 note: the `Queue (SQS)` box in the diagram as decided was removed by ADR-058. Jobs go into the PostgreSQL `job` table, and the web wakes the worker over HTTP with `POST /wake`.)

### Impact on On-Premises Version

None. CloudFront is AWS-specific infrastructure.
VPC Origin is purely an infrastructure concern, requiring no application code changes.
On-premises / Docker Compose environments are not affected.

## Cost Impact

| Item                     | Before          | After                  | Difference                          |
| ------------------------ | --------------- | ---------------------- | ----------------------------------- |
| ALB fixed cost           | ~$18/month      | ~$18/month             | ±$0                                 |
| ALB public IPv4          | ~$7.5/month     | $0 (internal ALB)      | **-$7.5**                           |
| WAF                      | ~$9/month (ALB) | ~$9/month (CloudFront) | ±$0                                 |
| CloudFront requests      | —               | ~$1–3/month            | +$1–3                               |
| CloudFront data transfer | —               | $0.085/GB              | Cheaper than EC2 direct ($0.114/GB) |
| Origin Verify Secret     | ~$0.4/month     | $0 (not needed)        | **-$0.4**                           |
| **Total**                | —               | —                      | **-$5–7/month** (at small scale)    |

VPC Origin eliminates the need for ALB public IPv4 and the Origin Verify Secret.
For higher data transfer volumes, CloudFront is even cheaper ($0.085 vs $0.114/GB).

## Migration Steps

### Implementation (Complete)

1. ADR approval
2. Create `infra/lib/stacks/global-stack.ts` (us-east-1: ACM certificate + WAF WebACL)
3. Create `infra/lib/constructs/cdn.ts` (CloudFront Distribution with VPC Origin)
4. Create `infra/lib/cf-functions/viewer-request.js` (access control: IP/Basic + cookie bypass)
5. Update `infra/lib/constructs/network.ts`
   - Remove ALB SG internet-facing ingress rules (ALB is internal)
6. Update `infra/lib/stacks/kukan-stack.ts`
   - Remove regional ACM certificate (CloudFront terminates TLS)
   - Remove Origin Verify Secret (replaced by VPC origin)
   - Add CDN construct with VPC origin
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

# ALB is internal so not directly accessible from the internet
# (DNS resolves to private IPs, unreachable from outside the VPC)

# Confirm bypass when logged in
# Verify API endpoint functionality
# Verify WAF rule behavior (when enableWaf is enabled)
```

## Supplement (2026-10, v0.36.0)

Besides access control and the cookie bypass, the viewer-request function overwrites two headers
on every request (a value the viewer sent is never used).

- **`x-kukan-locale`**: the locale resolved from the `NEXT_LOCALE` cookie, then `Accept-Language`
  by q, then the default `en`. The HTML cache policy includes this header in the cache key.
  Keying on `Accept-Language` itself would split entries per browser; this folds them into one
  entry per locale. The web prefers this header when present.
- **`x-kukan-client-ip`**: `event.viewer.ip`. The end of `X-Forwarded-For` is CloudFront's own
  address, and trusting a viewer-sent value would let a client pick its own rate-limit bucket. The
  web reads this header, named by `CLIENT_IP_HEADER` (set by the CDK), for sign-in rate limits
  (ADR-003 supplement).

Route 53 also gets an AAAA alias beside the A (`enableIpv6Dns`, overridable per site). It is on by
default, but off where `allowedIpRanges` is set: a viewer admitted by its IPv4 address would come
over IPv6, get a 403, and browsers do not retry over IPv4.

## Supplement (2026-11): rate-based rules and logging

Two rate-based rules were added to the WebACL after the managed rule groups, along with a log
of only the requests a rule matched. They are configured by `waf` on the environment entry: the
WebACL is shared by the environment's sites, so this is an environment-level setting, never a
per-site one (a site entry carrying it is refused at synth).

| Rule (priority)      | What it counts                                                                              | Default limit (5 min) | Metric                |
| -------------------- | ------------------------------------------------------------------------------------------- | --------------------- | --------------------- |
| `RateLimitAll` (40)  | Every request per viewer IP, except paths under `/_next/static/` and `/vendor/ibis-office/` | 2000                  | `kukan-waf-rate-all`  |
| `RateLimitAuth` (50) | Requests whose path starts with `/api/auth/` (Better Auth)                                  | 100                   | `kukan-waf-rate-auth` |

- **Why static assets are not counted.** CloudFront-scope WAF inspects cache hits too. One page
  view fetches a dozen static files, so counting them would turn the limit into a page budget
  rather than a request budget. The exclusion is judged strictly on the raw path: the prefix, and
  no `..`, `%` or `\` anywhere (the same test viewer-request applies to the ibisOffice files). The
  path is forwarded raw and the origin may read it differently, so anything ambiguous stays counted. `/api/auth/` is counted in two forms,
  URL-decoded alone and also with backslashes and `..` resolved, since either alone misses a spelling
  that reaches the handler under the other reading.
- **Why after the managed groups.** A request a managed rule blocked is neither counted against
  its IP nor logged twice.
- **Two rules of the common rule set only count** (`ruleActionOverrides` to count).
  `SizeRestrictions_BODY` blocks a body over 8 KB, so a dataset whose Japanese description runs past
  about 2,700 characters could not be saved. `GenericRFI_BODY` blocks a body holding a URL written
  with an IP address, so a resource with such a URL could not be registered. Both were measured on
  demo. They hit requests a catalog's API takes in ordinary use, so they are logged rather than
  blocked. The set's other rules (`CrossSiteScripting_BODY`, `NoUserAgent_HEADER` and so on) still
  block. The former matches `<script>` and event attributes, not `<b>` or `<a href>`.
- **A body past what is inspected is blocked** (`BlockUninspectedBody`, priority 5, 413).
  CloudFront-scope WAF inspects only the first 16 KB of a body, and `CrossSiteScripting_BODY` and
  the like read no further. With `SizeRestrictions_BODY` counting, a payload placed past 16 KB would
  slip through (the API takes bodies up to 1 MiB), so a body over 16 KB is blocked whole. A Japanese
  description of about 5,000 characters still saves. Raising the limit to 64 KB was not taken, as
  inspecting past 16 KB is charged extra. The server-proxied upload (`POST /api/v1/resources/<UUID>/upload`) alone
  is exempt: it takes a file up to its own cap, and its raw path is matched strictly on the UUID's
  form, so no spelling the origin reads as another route matches. On a site with WAF on, other API bodies are thus capped
  at 16 KB (the API itself takes 1 MiB, but WAF inspects at most 64 KB, so a line has to be drawn
  somewhere). Create a dataset with many resources in several requests, or add the resources
  afterwards.
- **Count by default.** The IPs over the limit are recorded in metrics and the log, not blocked.
  Where many people sit behind one exit — a municipality's NAT, an isolated-browsing gateway —
  one person's limit becomes the organization's. Count first, see who is over, then switch to
  `mode: 'block'`.
- **`exemptIpRanges`**: CIDRs never counted (an office exit, say). An AWS IP set holds one
  address version, so IPv4 and IPv6 get separate sets (each only when the list has ranges of
  that version), AND-ed onto both rules' scope-down as `NOT IPSet`.
- **A block answers 429** with a plain-text body (the WebACL's `customResponseBodies`, key
  `rate-limited`) and a `Retry-After` header, so it reads apart from an origin 403 and tells the
  client to wait and retry.
- **Logging** (`AWS::WAFv2::LoggingConfiguration`): default DROP, KEEP only matches whose action
  is COUNT or BLOCK. The `cookie` and `authorization` headers are redacted. The full access log
  already lives in CloudFront (delivery is free), and WAF logs are billed per GB, so this one
  holds only which rule matched what. Retention is `waf.logging.retentionDays`, falling back to
  `cdnLogRetentionDays`; `logging: false` turns it off.
- **The bucket lives in the same us-east-1 stack as the WebACL.** Its name is
  `aws-waf-logs-kukan-<env>-<account>` (AWS requires the `aws-waf-logs-` prefix; the account
  makes it unique). A CloudFront-scope logging configuration is set up in us-east-1, and the
  bucket with its delivery policy (`PutObject` / `GetBucketAcl` for
  `delivery.logs.amazonaws.com`) must exist before the configuration is created — the
  configuration depends on the policy explicitly. RETAIN, like the access log bucket.
- **The IP sets are retained with the WebACL.** After a switch to a pasted ARN only the WebACL would
  remain, and deleting an IP set it still references would stop the deploy. Removing every range of
  one version from `exemptIpRanges` leaves its IP set unreferenced; delete it by hand if it matters.
- **The leftover bucket blocks turning the log back on.** With a fixed name and RETAIN, the
  bucket survives a deploy with `logging: false` (and the deletion of the global stack) outside
  the stack, and the next deploy that creates it fails on the name. Delete or rename the leftover
  bucket before turning the log back on or recreating the stack.
- **Table previews are many small requests.** A table preview reads its Parquet by Range
  requests, and the DuckDB-WASM reads behind an interactive preview are many small GETs per
  interaction — all counted by the catch-all rule, since they reach the origin. In the count
  period, look at whether a single person's heavy preview use approaches the limit; if so, raise
  `limit` rather than widen the exclusions, which are for paths that never reach the origin.
- Cost: two rate rules and the body-size rule, +$3, about $12/month per WebACL. The log costs S3 plus delivery per GB.

**Reviewing the counted IPs and switching to block:**

1. In CloudWatch (us-east-1, namespace `AWS/WAFV2`), read `CountedRequests` by `Rule` =
   `kukan-waf-rate-all` / `kukan-waf-rate-auth`. Non-zero: go on.
2. List the IPs over the limit right now:
   ```bash
   aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1
   aws wafv2 get-rate-based-statement-managed-keys --scope CLOUDFRONT --region us-east-1 \
     --web-acl-name <Name> --web-acl-id <Id> --rule-name RateLimitAll
   ```
3. Read the S3 log (stack output `WafLogBucketName`, under `AWSLogs/<account>/WAFLogs/`) for
   when, which IP and which URI matched.
4. Cross-check with the CloudFront access log (`c_ip`, User-Agent, URI; the Athena example in
   the system admin guide) and the `session` table's `ipAddress` (is a signed-in user behind that
   IP?). A shared exit goes into `exemptIpRanges`; otherwise set `mode: 'block'`.
5. A change to `waf` lands through a standalone deploy of the global stack (the pipeline has no
   us-east-1, ADR-030). Where the ARN is pasted in, drop `webAclArn` for the moment, run
   `npx cdk deploy -c env=<env> <Env>/KukanGlobalStack`, and put it back. The WebACL is updated
   under the same logical ID, so the ARN does not change.

## Related

- ADR-020 (CloudFront removal history): `docs/adr/en/020-ecs-fargate-alb-migration.md`
- ADR-012 (single-origin design): `docs/adr/en/012-api-as-library-single-origin.md`
- Previous CloudFront implementation: git commit `9adc82c`
