# ADR-068: Run the Web on Lambda Web Functions (No NAT, by a Connector and IPv6)

## Status

**Proposed — stage 2 passed, the whole web included; decide after checking the billing basis against the bill** — 2026-10-17

Let the web in AWS environments run on **Lambda Web Functions** as well as on ECS Fargate + ALB.
Web Functions run an ordinary Node HTTP server that listens on a port, so the main reasons ADR-020
turned Lambda down (OpenNext is needed; the single origin of ADR-012 breaks) no longer apply. What
remains in the way is the DuckDB inside the web (ADR-032's query child process, ADR-055's OData
feed) and the way out to the VPC.

For the way out, making the egress network connector **DualStack** and leaving over IPv6 through
the existing internet gateway is expected to avoid a NAT. The only destination without IPv6 is
Bedrock Runtime in Tokyo, which is reached through an interface endpoint. Web Functions are Arm64
only, but the web and worker already run on arm64 Fargate (the default), and an arm64 build
environment exists.

**ECS Fargate stays the default, and each environment can choose Web Functions instead**
(§Decision 1), since Web Functions are new and the CDK has no L2 for them yet. Where an environment
chooses them, they replace the web part of ADR-020, and ADR-049 (shared ALB) remains only for
Fargate environments. The worker stays on ECS Fargate (§Out of scope). Docker Compose (development, on-premises, closed networks)
is unaffected.

> **This ADR is a draft written with Claude Code from a design conversation.** The Web Functions
> specification comes from the official documentation as of 2026-10-17, prices from the AWS Price
> List API, and the web's touch points from the source on develop (`2de25638`). Stage 1
> measurements are in §Context 4.

## Context

### 1. Lambda Web Functions (announced 2026-10-12)

A third form of Lambda; the existing Lambda is renamed Event Functions.

| Item                | Detail                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------- |
| How it runs         | An HTTP server listening on `AWS_LAMBDA_HTTP_ENDPOINT`. No adapter                        |
| Environment         | 2 vCPU / 2 GB fixed, Arm64 only (not selectable), Node.js 24 (`nodejs24.x`)               |
| Concurrency         | Up to 128 requests per environment (default 64, `maxConcurrencyPerEnvironment`)           |
| Startup             | Must start listening within 10 seconds. Scales to zero environments without traffic       |
| Requests            | Up to 900 seconds. Response streaming. HTTP/1.1 only, no WebSocket                        |
| Packaging           | Zip only (in a versioned S3 bucket). No container images                                  |
| Runtime patches     | Applied automatically; cannot be pinned                                                   |
| Inbound             | Always a public endpoint. No PrivateLink. Protected by CloudFront OAC and `IamAuth`       |
| Outbound            | Without a connector, directly over Lambda's public IPv4. With one, from the VPC's subnets |
| Billing             | Active CPU time + memory while an environment lives + requests + data transfer            |
| Regions (at launch) | us-east-1, us-east-2, us-west-2, ap-northeast-1, eu-west-1 (not Osaka)                    |

A connector replaces the default way out, and its network interfaces get no public IPv4 (there is
no setting for one). The documentation says "IPv4 destinations need a route to a NAT gateway, IPv6
destinations a route to an egress-only internet gateway". IPv6 addresses are global in themselves,
so `::/0 → internet gateway` in a public subnet also works (an egress-only gateway refuses inbound
by route; a security group refusing it makes that unnecessary).

### 2. What became of ADR-020's reasons against Lambda

| ADR-020's reason                                    | With Web Functions                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Needs OpenNext; incompatible with the single origin | **Gone.** `server.js` runs as is; the difference is a few lines of listen address    |
| Next.js standalone cold start of 1–3 s              | Starting from zero remains, but one environment takes many requests and scales ahead |
| INIT-phase billing erodes the cost advantage        | A different billing model (active CPU time)                                          |
| Kept warm, it costs about as much as Fargate        | Idle time is not billed for CPU                                                      |

### 3. Where the web reaches, inside and outside the VPC

Taken from the source on develop.

| Destination                                  | Use                              | Path (this ADR)                       |
| -------------------------------------------- | -------------------------------- | ------------------------------------- |
| PostgreSQL (RDS / Aurora, isolated)          | Everything                       | Connector                             |
| OpenSearch (isolated)                        | Search                           | Connector                             |
| The worker's `/wake` (Cloud Map, ADR-058 §3) | Job notification                 | Connector                             |
| S3                                           | Storage adapter, DuckDB          | Gateway endpoint (existing)           |
| Bedrock Runtime (Converse, InvokeModel)      | Query embedding, AI suggestions  | **Interface endpoint**                |
| GA4 Data API (`*.googleapis.com`)            | Access statistics (ADR-024)      | IPv6                                  |
| OpenAI-compatible APIs (`baseUrl`)           | AI adapter                       | IPv6 (the official API has AAAA)      |
| Secrets Manager                              | Secrets at startup (§Decision 5) | IPv6 (the standard endpoint has AAAA) |

Not going out: authentication (no social login, no mail), DuckDB extensions (autoinstall is off),
fetching external URLs (the worker's Fetch only).

Bedrock Runtime in Tokyo has no IPv6. The official endpoint list has only
`bedrock-runtime.ap-northeast-1.amazonaws.com`, which has no AAAA, and the dual-stack names
(`*.api.aws`, `*.dualstack.*`) do not resolve. `bedrock-mantle.ap-northeast-1.api.aws` has an A
record only.

### 4. Stage 1 measurements (2026-10-17, Tokyo, without DuckDB)

A dependency-free Node probe was deployed as a Web Function to check what the web's query path
assumes (`services/child/host.ts`, `serve.ts`, `process-memory.ts`). The code is in
`spike/adr-068/`, as is stage 2's below.

| Question                              | Result                                                                                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can it `fork`                         | Yes (about 27 ms per child)                                                                                                                                 |
| Can a child raise its `oom_score_adj` | It can write it, but the OOM behaviour below makes it moot                                                                                                  |
| cgroup memory limit                   | **None** (no memory files under `/sys/fs/cgroup`). `os.totalmem()` returns the environment's (about 2.4 GB)                                                 |
| Past 2 GB                             | **The whole environment stops** (`Runtime.OutOfMemory` → `spinDownStart`). Every in-flight request fails; a new environment was listening about 0.2 s later |
| What a child could allocate           | Up to 1900 MB without trouble                                                                                                                               |
| `/tmp`                                | 525 MB, shared by every request. `ENOSPC` past it. The code directory is read-only (`EROFS`)                                                                |
| OS                                    | Amazon Linux 2023, glibc 2.34, arm64, 2 vCPU                                                                                                                |
| V8 heap limit                         | 1408 MB (the documentation says 1024 MB)                                                                                                                    |
| Startup                               | 6–8 ms to listening (the probe alone)                                                                                                                       |
| Environment variables                 | The execution role's credentials (`AWS_ACCESS_KEY_ID` etc.) are there as values                                                                             |

Also: an endpoint's rate limit accepts only 0 or steps of 100. Two log groups are created,
`<name>` and `<name>.local`.

### 5. The child process still earns its place

What decided the child process in ADR-032 (open issue 2) was "giving back the memory a query
leaves behind" (480–525 MB stayed in-process; a child's exit returns it). Having the kernel pick
the child on OOM was the backstop covering the monitor's interval. Web Functions lose only the
backstop, and the deciding reason weighs more (2 GB shared by up to 64 requests). The parent's RSS
budget with `SIGKILL`, stopping at a timeout, isolating a native crash, and keeping credentials out
of the child's environment (last row of §Context 4) all still work.

### 6. CDK support (as of 2026-10-17)

| Layer          | State                                                                                                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CloudFormation | `AWS::Lambda::WebFunction`, `WebFunctionRevision`, `WebFunctionEndpoint`, `NetworkConnector`, `ResourcePolicy`                                                                                                               |
| CDK L1         | `aws-cdk-lib` 2.273.0 has `CfnWebFunction`, `CfnWebFunctionRevision`, `CfnWebFunctionEndpoint`, `CfnNetworkConnector`. The revision's `EgressNetworkConnectorArn` is in the next release (aws-cdk#39139, merged, unreleased) |
| CDK L2         | Unreleased. The service team's PR (aws-cdk#39210: `WebFunction`, `WebFunctionCode`, `NetworkConnector` in the stable `aws-lambda`) is in review                                                                              |
| CloudFront     | OAC origin type `lambda` (`OriginAccessControlOriginTypes.LAMBDA`), signing `always-amz-auth`. The existing L2 takes an origin's `originAccessControlId`                                                                     |

Two points the L2 PR deals with bear on KUKAN:

- **The code cannot sit in the CDK bootstrap bucket.** It needs versioning, SSE-S3 and read access
  for the Lambda service. A custom resource copies it server-side into a dedicated bucket and pins
  the written version ID on the revision (`BucketDeployment` does not return it).
- **A connector cannot cross stacks through an Export.** Its version ARN changes on every update,
  so it is referenced by a pinned version ARN.

## Options considered

### A) Stay as is (ECS Fargate + shared ALB) — the baseline

### B) Web Functions + connector + NAT Gateway — rejected

The plainest, but a NAT Gateway costs $0.062/h ($45.26/month) + $0.062/GB in Tokyo, nearly
cancelling what small saves, and breaks ADR-020's "no NAT".

### C) Web Functions + connector (DualStack) + an interface endpoint for Bedrock — adopted (proposed)

Leave over IPv6 through the existing internet gateway; reach only Bedrock, which lacks IPv6,
through an interface endpoint (one per VPC, shared by every site).

### D) No connector (use the DB and OpenSearch from outside the VPC) — rejected

RDS Data API means a different Drizzle driver, two ways to the DB between AWS and Compose (against
the rule of no adapters where environments do not differ). The DB is not made public. OpenSearch
is headed for retirement (ADR-061) and not worth the work.

### E) Make the worker an Event Function to drop the web's connector — rejected

Only the `/wake` path goes away; the DB and OpenSearch still need the connector. The worker would
itself sit in the VPC and need a NAT for Fetch — the NAT only moves.

## Decision (proposed)

### 1. Switching between the two (Fargate by default)

- Add `webCompute: 'fargate' | 'web-function'` to the environment configuration, defaulting to
  `fargate`. As with `cpuArchitecture` (`infra/lib/cpu-architecture.ts`), one table states what it
  means and every place reads it.
- Per environment. Mixing per site would need both an ALB and a connector in the shared
  infrastructure, and multiply the combinations.
- No branches in the application code. These are harmless either way and go in unconditionally:
  - Listen on `AWS_LAMBDA_HTTP_ENDPOINT` when it is set (unchanged otherwise)
  - Without a cgroup, watch the environment through `/proc/meminfo` (§Decision 4)
  - Store sign-in rate limiting in the DB (§Decision 6; also better for Fargate with several tasks)
  - Take the client's IP from `CloudFront-Viewer-Address` (CloudFront is in front either way)
  - Fetch secrets from Secrets Manager when they are not in the environment (§Decision 5; on ECS
    they are injected, as today)
- Three branches in the CDK: the site's web (`WebService` or a Web Function), the shared
  infrastructure (shared ALB and VPC origin, or IPv6, connector and the Bedrock endpoint), and the
  CloudFront origin (`cdn.ts` takes a `cloudfront.IOrigin`, so it is a swap). The worker, DB,
  OpenSearch and Cloud Map are common; only what their security groups allow changes, the web or
  the connector.
- Switching recreates the web's resources, but CloudFront and the domain stay, so DNS does not
  change. Going back is setting `fargate` again and deploying.
- `web-function` is experimental. A path nobody uses goes stale, so a test environment in Tokyo
  keeps using it, CI builds the zip, and the synth snapshots cover both.

### 2. Network

- Give the VPC and public subnets IPv6 CIDRs and add `::/0 → internet gateway`. RDS, OpenSearch
  and ECS (the worker) stay on IPv4.
- The connector is `DualStack`, in public subnets (two or more AZs), with an outbound-only
  security group. RDS, OpenSearch and the worker allow the connector's security group.
- One interface endpoint for Bedrock Runtime in the shared infrastructure (ADR-041), in one AZ.
  While that AZ is down, AI suggestions and query embedding stop and everything else works; they
  come back with the AZ.
- A connector works only with `HomeRegion` endpoints (no multi-Region).

### 3. Inbound

CloudFront → Web Function (`IamAuth` + OAC). The origin request policy is already
`AllViewerExceptHostHeader` (forwarding Host gives 404). IP restriction already happens in the
CloudFront Function, so nothing replaces the ALB's security group. Once every site has moved, the
shared ALB goes.

The last `X-Forwarded-For` value becomes a CloudFront address. Whatever uses the client's IP takes
it from `CloudFront-Viewer-Address`.

### 4. Memory and disk

- Without a cgroup, the environment-wide check (the container bound in `host.ts`) uses
  `MemTotal - MemAvailable` from `/proc/meminfo`. OData's capacity falls back to `host` with the
  right figure, but warns every start, so recognise Web Functions and name the source.
- Re-divide the 2 GB among `maxConcurrencyPerEnvironment`, `QUERY_MAX_CONCURRENT` and the OData
  slots. Without the OOM backstop, make the poll interval or the headroom conservative.
- Fit DuckDB's spill limit (`max_temp_directory_size`) to the shared `/tmp`.

### 5. Secrets

A revision takes only environment variables (KMS-encrypted); there is no reference to Secrets
Manager. Fetch from Secrets Manager at startup (reachable over IPv6). Baking values into
environment variables means a new revision for every secret change.

### 6. Sign-in rate limiting

Better Auth's rate limiter records in process memory by default. Environments come and go and
split the record, so store it in the DB.

### 7. Build and deploy

- Build a zip for AWS: Next.js standalone, `query-child.mjs`, the **glibc**
  `@duckdb/node-bindings-linux-arm64` (with `libduckdb.so` beside it), DuckDB extensions for
  `linux_arm64`, and an entry file moving the listen address into `HOSTNAME` and `PORT`. A separate
  artifact from the Docker image (alpine, musl). The glibc arm64 binaries come from the build's
  install with `libc: [glibc]` and `cpu: [arm64]` added to `supportedArchitectures` (checked in stage 2c).
- Build the zip keeping symlinks (`zip -y`), not relying on `aws lambda-web deploy`'s packaging.
- Build it on the ARM CodeBuild the pipeline already uses for assets
  (`LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0`, `infra/lib/cpu-architecture.ts`). It is the
  same Amazon Linux 2023 (glibc) as the Web Functions environment, so no QEMU and no fetching for
  another OS. Where the Docker `deps` stage installs musl only through `supportedArchitectures`,
  the zip takes the glibc binding.
- Use the L2 (aws-cdk#39210) once released; until then, the L1 with a custom resource of our own
  (the code copy and its version ID) (§Context 6). The bootstrap is left alone.
- The connector lives in the shared infrastructure; its pinned version ARN reaches the site stacks
  through an SSM parameter, like the other shared values. Updating the connector is a two-step
  deploy, shared infrastructure then each site.
- Check automatic revision cleanup (old revisions no endpoint routes to go at the limit) and what
  happens to the old revision on replacement.
- Runtime patches cannot be pinned; the web alone leaves the digest pinning (of the base image).

### 8. DB connections

Every environment gets its own pool. Set `maxEnvironments` so that it times the pool size stays
inside the DB's limit.

A tight `maxEnvironments`, though, returns 429 on ordinary use (seen in stage 2c). The dynamic limit
on what one environment takes at once **starts at two requests on a fresh environment and rises with
use toward `maxConcurrencyPerEnvironment`** (64 by default). With `maxEnvironments: 2`, repeated bursts
of parallel requests each held for 2 s were taken 4 → 18 → 63–73 → 82–100 → 115 at a time across the two
environments (`spike/adr-068/concurrency.sh`). A request over the limit is refused without waiting,
with a 429 `Platform.EndpointMaxEnvThrottle`.

Environments go to zero when unused and are rebuilt on redeploy, so the quieter a site, the more often
its first burst meets that low starting limit. The dashboard sends bursts (Next.js prefetching and the
count requests), and with a limit of 2 its loading failed now and then; with 10 it did not (a burst of
60 parallel requests started five environments and all returned 200).

So set `maxEnvironments` with room (around 10 even for small), and keep the DB's connection limit
by a small pool per environment (`WEB_DB_POOL_MAX`, 5 in the probe).

## Stage 2 (pass or fail)

In place of the stage 1 probe, a server bundling KUKAN's query parts (`runQueryInProcess`,
`@kukan/lake`'s `openDuckdb`), joined by a connector to §Decision 2's network built in a VPC of its
own (2026-10-17, `spike/adr-068/stage2a` and `stage2b`). Last, the whole web (the Next.js
standalone) went on the same connector (`stage2c`, with an `IamAuth` endpoint).

| What to check                                  | Passes when                                       | Result                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zip size and deployment                        | It deploys and listens within 10 seconds          | ✓ 167 MB unpacked (DuckDB binding 61 MB, four extensions 104 MB), 59.6 MB zipped. Listening in 8 ms. `INSTALL` and `LOAD` work with the extensions in the read-only code directory                                                                                                                                                                                                                         |
| DuckDB in the query child                      | `/query` and OData's way return results           | ✓ A 109 MB Parquet (1.2 million rows) loaded under a 256 MB limit, aggregated and sorted in 1.3–1.7 s. In-process DuckDB (OData's way) in 0.84 s                                                                                                                                                                                                                                                           |
| A heavy query                                  | The budget stops the child; the environment stays | ✓ A query with DuckDB allowed 1.5 GB was stopped at the budget (613 MB) with a 400. The environment went on                                                                                                                                                                                                                                                                                                |
| RDS, OpenSearch, `/wake` through the connector | Reached, with latency close to Fargate's          | ✓ RDS over TLS (certificate verified) connected in 141 ms; `SELECT 1` round trips had a 0.58 ms median. OpenSearch and `/wake` take the same path (a private address in the VPC), so RDS stood in                                                                                                                                                                                                          |
| IPv6 egress                                    | GA4 and Secrets Manager reached without a NAT     | ✓ Secrets Manager (107 ms), the GA4 API and OpenAI were reached; IPv4-only hosts were not. S3 through the gateway endpoint, Bedrock Runtime through its interface endpoint (an address in the VPC). The 109 MB aggregation through the connector took 2.0 s                                                                                                                                                |
| Billing                                        | What memory is billed on; the VPC transfer rate   | Open. The log when an environment stops carries the peak memory used (`maxMemoryUsageMb`); to be checked against the bill                                                                                                                                                                                                                                                                                  |
| The whole web (Next.js)                        | It starts and answers SSR and API requests        | ✓ 330 MB unpacked, 108 MB zipped (accepted past the 250 MB limit of Event Functions). SSR pages, static files, DB-backed APIs, the CKAN-compatible API, the first sign-up (sysadmin) and creating a dataset all worked. A 23 MB upload (straight to a presigned URL) took 0.3 s; a 23 MB download through the web took 2.8 s. The first request on a new environment took 2.5–2.6 s, later ones 0.08–0.4 s |

What the checks turned up:

- `aws lambda-web deploy` leaves `*.pem` out of the package (to keep private keys out). The
  certificate bundle went in under another extension; check whether a CDK build has the same rule.
- DuckDB's httplib HTTP client gets no response inside Web Functions (the default and curl do).
  KUKAN uses the default.
- A URL signed with local credentials can be refused on conditions of the signer's (such as source
  IP). The web signs with its own role, so it is unaffected.
- pnpm's standalone output holds many symlinks (235 here). The zip was built by hand (`zip -y`, links
  kept), put in a versioned bucket, and given to the revision.
- Next.js's trace takes DuckDB's `duckdb.node` but not `libduckdb.so` (as in the image).
  `duckdb.node` looks beside itself (`$ORIGIN`), so placing it there needs no `LD_LIBRARY_PATH`.
- Calling an `IamAuth` endpoint directly needs SigV4 with `X-Amz-Content-SHA256` signed. curl 7.81's
  signing got 403; the AWS SDK's signer passed (with CloudFront OAC in front, CloudFront signs).
- With `maxEnvironments: 2`, the dashboard's loading failed now and then with 429
  (`Platform.EndpointMaxEnvThrottle`), since a fresh environment takes only two requests at once. It
  never reaches the application, so its logs show nothing (§Decision 8).
- Responses felt faster than demo's Fargate (small, 0.25 vCPU / 0.5 GB). The environment has 2 vCPU /
  2 GB with CPU billed as used; holding 2 vCPU / 2 GB on Fargate (arm64) costs about $65 a month. The
  conditions differ, though: one dataset in the probe's DB, PostgreSQL search, AI off.

## Cost (small, per month)

Tokyo prices (Price List API). Web Functions have no published Tokyo price; us-east-1 is used.

| Kind                              | Item                                              | Per month                                              |
| --------------------------------- | ------------------------------------------------- | ------------------------------------------------------ |
| Goes away (per site)              | The web's Fargate (0.25 vCPU / 0.5 GB × 1, arm64) | $9.00                                                  |
|                                   | The web task's public IPv4                        | $3.65                                                  |
| Goes away (once every site moves) | Shared ALB (hourly)                               | $17.74 + LCU                                           |
|                                   | The ALB's public IPv4 (2 AZs)                     | $7.30                                                  |
| Added (shared)                    | Bedrock Runtime endpoint (1 AZ)                   | $10.22 + $0.01/GB                                      |
| Added (per site)                  | Web Functions usage (300k requests/month)         | about $5                                               |
|                                   | Transfer between Web Functions and the VPC        | Unpublished ($0.01–0.02/GB if it matches EC2 cross-AZ) |

The baseline is arm64 Fargate (vCPU $0.04045/h, GB $0.00442/h; the web and worker default to
arm64). Expected saving: about $22/month for one site ($37.69 + LCU gone, about $15 added), about
$38/month for three ($63 + LCU gone, about $25 added). Usage grows with traffic, so the point where
Fargate becomes cheaper at medium / large is left until stage 2 measures the billing.

## Out of scope

- **The worker.** Stays on ECS Fargate. Draining until the table is empty (ADR-058), reusing the
  heavy child process (ADR-059) and fetching external URLs (needs a NAT) do not suit Event
  Functions.
- **Docker Compose.** Development, on-premises and closed networks stay as they are; the web's code
  differs only in the listen address.
- **The Osaka Region.** No Web Functions there, so Fargate stays; the CDK keeps both paths.

## Open issues

1. The transfer rate between Web Functions and the VPC, the Tokyo price, and what memory is billed
   on (used or held).
2. The break-even at medium / large.
3. The effect of starting from zero on SSR (SEO), and of lru-cache leaving with an environment. In
   stage 2c the first request on a new environment took 2.5–2.6 s.
4. Should Bedrock Runtime get a dual-stack endpoint, the interface endpoint can go.
5. The release of the CDK L2 (aws-cdk#39210).

## Related

- ADR-012 (single origin), ADR-017 (server-proxied downloads), ADR-020 (web = Fargate + ALB; the web
  part is replaced if adopted), ADR-027 (CloudFront), ADR-032 (query child process), ADR-041
  (shared infrastructure), ADR-049 (shared ALB; rewritten if adopted), ADR-055 (OData), ADR-058
  (`/wake`), ADR-059 (the worker's child process), ADR-061 (retiring OpenSearch)
