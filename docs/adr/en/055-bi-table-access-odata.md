# ADR-055: BI Tool Access to Table Data (Read-Only OData Endpoint)

> This is a machine-assisted translation of the Japanese original
> (`docs/adr/jp/055-bi-table-access-odata.md`), which is authoritative.

## Status

**Proposed** — this ADR does not settle an implementation. It compares the routes by which a BI tool
(Tableau as the originating request, and with it Power BI and Excel) can reach KUKAN's table data,
and assembles the material for a decision.

The loop ADR-032 established — catalog, schema, query — is a route **for agents**. What this ADR
covers is a person sitting in a desktop BI tool, which asks for something different.

## Context

KUKAN's table data exists in these forms:

- The canonical original file in S3 (CSV/TSV and so on), **streamed through the server** (ADR-017).
  Signed URLs for reading were introduced once and then removed; presigned URLs are for uploads only
- CSV/TSV up to 100 MB converted to a **preview Parquet** (ADR-014 / ADR-029)
- Row-level differences in DuckLake (ADR-043), catalogued in the PostgreSQL `ducklake` schema
- Queries at `POST /api/v1/resources/{id}/query` (ADR-032 Part B)

A request arrived to connect from Tableau. Phrased naively it becomes "is there a connector for
DuckDB", but **KUKAN has no DuckDB for anything to connect to**. The DuckDB in ADR-032 is created
per query, locked down with `enable_external_access = false`, and destroyed when the query ends. It
is not a standing endpoint. So the real question is which protocol publishes the table data.

### Research (Tableau, as of 2026-09)

Recorded because the design rests on it. **All of it is vendor behaviour and can change.**

| Item                     | What was confirmed                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DuckDB connector         | **It exists.** MotherDuck maintains `duckdb_jdbc.taco`, listed on the Tableau Exchange (v1.1.1, 2026-02). It connects to a **local DuckDB file, an in-memory database, or MotherDuck**                                                                                                                                                                        |
| Own connector (.taco)    | **Cannot be deployed to Tableau Cloud.** Partner-built connectors are not supported for publishing to Tableau Cloud; only Tableau-managed connectors run there                                                                                                                                                                                                |
| OData versions           | **V4 / V4.01 supported** (JSON). V1 / V2 use XML/Atom                                                                                                                                                                                                                                                                                                         |
| OData connection mode    | **Extracts only. No live connection**                                                                                                                                                                                                                                                                                                                         |
| OData query options      | **`$select` and `$expand` are not supported** (named as "interactive query arguments")                                                                                                                                                                                                                                                                        |
| Other OData limits       | Collection-valued properties are read as null. Metadata documents are assumed to be XML                                                                                                                                                                                                                                                                       |
| OData connection dialog  | Two inputs only — **Server (a service URL or a single feed URL) and Authentication**. Authentication offers **"Username and Password" or "No Authentication"**; there is no OAuth, no custom header, no API-key field                                                                                                                                         |
| Parquet                  | **The Amazon S3 connector reads Parquet** (SNAPPY/GZIP/ZSTD/LZ4_RAW, UTF-8 only) — but connecting **requires an IAM access key**                                                                                                                                                                                                                              |
| Local .parquet           | Community sources describe opening one through "To a File → More → .parquet", but this **could not be confirmed in Tableau's own help**. Needs checking against a real install                                                                                                                                                                                |
| CSV over HTTP            | **Not reachable natively.** The text-file connector expects a local or UNC path, and a published flat file is **not refreshed** on Cloud or Server                                                                                                                                                                                                            |
| REST API Connector       | **Built by Tableau.** Reads CSV/JSON over HTTP GET (2023.3 and later, extract-only). But a **JDBC driver (.jar) has to be placed by hand in each machine's Drivers folder**, and the Exchange lists **Desktop only** (Prep Builder also works). **Not available on Cloud**, where no driver can be installed — a scheduled refresh there needs Tableau Bridge |
| WDC (Web Data Connector) | **On its way out.** The official repository states it is removed with the Tableau 26.3 release                                                                                                                                                                                                                                                                |

Two facts out of that table decide the design.

1. **Tableau's OData is extract-only and cannot push down a projection.** With `$select` inert, every
   refresh pulls **the whole entity set, every column**. "Pull just the columns we need" is not available
2. **The S3 connector demands an IAM access key.** Handing IAM credentials to the readers of a public
   catalog is not possible, so that route serves organizations that own their bucket, not KUKAN's users

## Options Considered

### A. A hand-built `.taco` connector (Tableau Connector SDK)

Wrap a KUKAN query endpoint in a JDBC driver plus a `.taco`.

- For: complete control of types, dialect and authentication; appears as a named connector in Tableau
- Against: **cannot be deployed to Tableau Cloud** (above), leaving Desktop and Server only. A JDBC
  driver — a JVM implementation — becomes ours to maintain. **It serves exactly one client**

### B. A read-only OData endpoint

Serve the service document, `$metadata` and entity sets under `/odata/`.

- For: **Tableau, Power BI and Excel all read it out of the box.** No driver to install. HTTPS and a
  token are enough, and it rides the existing access control. Self-describing (`$metadata`)
- Against: row-oriented JSON over HTTP is weak on large tables; with Tableau it is always a full
  extract. Mapping column types onto the EDM is new work

### C. The existing download route (what exists today)

Download the Parquet or CSV through ADR-017's server-side streaming and open it in the BI tool.

- For: **no implementation.** It already works, and as a way to fetch everything it is the most
  efficient (columnar, compressed)
- Against: **in Tableau it is manual on every refresh.** Tableau cannot reach a CSV over HTTP natively,
  and a published flat file is not refreshed on Cloud or Server. Excel and Power BI read a URL directly
  and can refresh, so this drawback is **Tableau's alone**. Nothing in the catalog leads from a table to
  a BI tool either. Whether Tableau opens a local .parquet is unconfirmed — if not, the file is a CSV

### C'. Have the API generate the whole table and stream it

Rather than handing over a stored object, **assemble a CSV or Parquet on the spot** from the preview
Parquet (or from a DuckLake version) and stream it into the response.

- For: rides ADR-017's existing pattern. **Every byte passes under the access check.** Encoding can be
  normalized to UTF-8 even when the original is Shift_JIS, and the format is ours to choose.
  **A version reconstructed from DuckLake's row differences exists as no object in S3**, so generating
  it is the only way to serve it
- Against: it holds a task for the length of the response, and being generated it cannot be resumed
  with a Range request

### D. A PostgreSQL wire-protocol endpoint

Present as PostgreSQL, one of Tableau's first-class connectors.

- For: the broadest BI support there is, and live connections
- Against: the table data is not in PostgreSQL (Parquet in S3 plus the DuckLake catalog). A
  compatibility layer becomes ours to build and run, and **a database protocol would face the public
  internet**. Plainly out of proportion to the request

### E. Connecting Tableau's Amazon S3 connector straight to the bucket

- For: no implementation, and Parquet stays columnar
- Against: **an IAM access key is required**, so it cannot be offered to catalog users. It remains a
  useful note for operators who run their own bucket

## Decision (Proposed)

**Take B (OData) as the front door and send whole-table reads to C (files) — two routes.**

### 1. What earns OData its place is "paste a URL and it works"

The requirement that outranks the rest is **being easy to try**. Copy a URL from a KUKAN resource
page, paste it into a BI tool, and the table opens — whether a route delivers that is what decides it.

| Route              | Tableau                                                 | Power BI | Excel   |
| ------------------ | ------------------------------------------------------- | -------- | ------- |
| **B. OData**       | **Paste the URL**                                       | **Yes**  | **Yes** |
| C. A CSV URL       | **No** — the text-file connector wants a local/UNC path | Yes      | Yes     |
| REST API Connector | **A JDBC driver (.jar) has to be installed first**      | —        | —       |
| C. Download a file | Someone has to download it                              | Same     | Same    |

**OData is the only one where pasting works in all three.** A (`.taco`) and the REST API Connector
both begin with an installation, which is the opposite of this requirement. E (the S3 connector) wants
an IAM access key, and D (PostgreSQL compatibility) wants connection settings.

Refresh comes along as **a consequence, not the reason**. A pasted URL stays as a data source, so
fetching it again is not manual work.

### 1'. Which makes "the URL is visible" part of the implementation

Serving the protocol does not meet the requirement on its own. **Showing the OData URL on the resource
page, ready to copy**, is inside this ADR's scope. That URL has to be:

- **Guessable and stable** — determined by the resource id, resolving to the current version unless a
  version is named
- **Openable without authentication for public resources.** Tableau's OData connector offers only
  username/password or no authentication; asking for a token on public data means pasting is no longer
  the whole story
- **Readable in a browser** (it returns JSON), so someone can see what is in it before taking it to a
  BI tool

The affordance itself carries conditions too.

- **Keep it apart from the developer's.** The readers differ — the Data API panel (ADR-032) belongs to
  whoever writes SQL, and someone who wants to paste a URL has no reason to open it. The resource page
  gets an entry point of its own
- **Where the feed cannot be served, keep the affordance and say why.** Step 1 refuses a whole resource
  whose headings are not EDM identifiers (open item 1), so **the refused are the majority**. Removing
  the entry point silently leaves a publisher looking at two resources, one with it and one without,
  and no reason given. It stays, dimmed, and names the headings at fault — because a heading is the
  kind of problem a publisher can fix

### 2. ADR-032's sandbox is not reused

That sandbox — a disposable instance, `enable_external_access = false`, SQL validation,
`memory_limit = 256MB` with a concurrency of one — exists to contain **arbitrary user SQL**. OData
carries no user SQL; the shape of the query is ours. Therefore:

- The OData route **does not go through the sandbox**, and needs no SQL validation (KUKAN composes
  the SQL it issues)
- What it needs is not a query engine but **a read that can be paged**

Conflating the two would leave a BI tool's full extract hammering limits that were deliberately sized
for one question from an agent, and break both requirements at once.

### 3. Whole-table reads leave OData for the download route

An entity set past a row threshold is not served whole through OData. ~~It is not paged (no endless
`@odata.nextLink`); taking it in one response beats several hundred JSON round trips, for the reader
and for the server.~~ (Step 1's measurements replaced both the reason and the mechanism — see the
addendum below.) **What it points at is ADR-017's server-side streaming, not a signed URL** —
presigned URLs for reading were removed in ADR-017.

> **Measured during Step 1 (addendum)**: taking 92,180 rows by 9 columns through the feed, every page,
> costs **3 round trips, 1.94 s and 19.1 MB of JSON** — 2.7 times the 7.13 MB source file. The cost per
> page is flat (137 ms for the last against 147 ms for the first), so a million rows is about 20 round
> trips. "Several hundred round trips" assumed a 1,000-row page; it does not describe a 50,000-row one.
> Condition 1 below — never materialize — is also met **by the feed itself**, so the download route is
> no longer the safer of the two on memory.
>
> What survives is **volume**: the JSON is 2.7 times the file, and every refresh pays it again.
>
> The mechanism changes too. Stopping by withholding `@odata.nextLink` is a **silent truncation** — the
> BI tool shows what looks like a complete table. That is the opposite of Step 1 refusing `$filter`
> with a 501 rather than ignoring it, so the feed has to **refuse explicitly and name where to go
> instead**.
>
> And **that destination is not the same artifact**. ADR-017 streams the stored original file; the feed
> serves the interpreted table (dropped rows, types, `RowId`). Handing over the same table as a file
> means generating it — the next paragraph's "assemble on the spot".

That response may stream the stored preview Parquet as it is, or assemble the bytes on the spot as in
C'. **A version reconstructed from DuckLake's row differences exists as no object in S3**, so serving
one leaves generation as the only option. Either shape has to satisfy three things.

1. **Never materialize.** ADR-032 materializes the Parquet **into an in-memory table** before locking
   down; pushing a whole table through that drops the web container (small = 512 MB). Read in chunks
   and stream into the response under backpressure — the same construction as ADR-017's download
2. **Account for what sits in front, and for deploys.** The response passes through CloudFront
   (ADR-027) and the ALB, so a gap where no bytes flow gets it cut. A rolling update killing the old
   task mid-response is likewise something to expect
3. **Keep a concurrency limit separate from ADR-032's.** The sandbox's concurrency of one is sized for
   a single question from an agent. Merging whole-table reads into it would let a BI extract lock
   agents out with 429s

### 4. Unit of publication

An entity set is **one resource**, and only resources that have a preview Parquet (`queryable`) are
published. Versions (ADR-043) resolve to the current one by default; publishing older versions is open.

### 5. v1 publishes public resources only

Tableau's dialog offers only "Username and Password" or "No Authentication" (see the research table).
Publishing non-public resources would mean accepting HTTP Basic on `/odata`, and **v1 does not**.

The reason is not the cost of the mechanism but **where the credential ends up**. Tableau saves what
was typed into the workbook or data source, and publishing embeds it. **A long-lived token then lives
inside a deliverable and travels with it when the workbook is shared.** Restricting v1 to public
resources removes the authentication path entirely, and pasting a URL works unconditionally.

**Where this goes later**: if non-public resources are published, the credential should not be an
account's. Issue a **disposable Basic credential with an expiry** — created from the resource page,
scoped to that resource and to reading, revocable at any time. A leaked workbook then costs that one
resource until the expiry, and never the account. A person's real password is not accepted even then.

### 6. Build it light, because the caller is a machine

What calls this route is a BI tool, not a person, and it **fetches the same URL over and over**.
Keeping the work per request small is a design constraint.

- **No per-request ceremony.** Sessions, cookies, CSRF and authorization resolution are not needed here
  (decision §5 makes it public-only). Rather than wrapping it in the existing API middleware, `/odata`
  is its own thin route
- **Let HTTP caching work.** A version is immutable, so return `ETag` / `Last-Modified` and answer
  **304** when nothing changed. The ETag is computable from (resource id, version id, format, query)
  **without reading any data**. Where it pays is not the reader but **CloudFront revalidating** — a BI
  tool's extract does not necessarily send a conditional request, but CloudFront comes back when the
  TTL expires, and a 304 there saves rebuilding the table. **As configured today, though, CloudFront
  caches none of this** (below). **Note that "immutable, so it can be held" does not set the TTL**
  (learned in implementation). What sets it is withdrawal — purging the version being served, making
  the dataset private, deleting the resource — where the origin refuses from that moment and a copy
  already in a cache does not. Purging an _older_ version is not among them: the feed never served it
- **Do not re-read the schema per page.** `$metadata` and the column mapping are fixed per version, so
  cache them in the process. **Step 1 does not** (learned in implementation): the read measures
  0.36 ms against a page's ~60, and no cheap key stands in for it — a re-interpretation of unchanged
  bytes leaves the content hash alone while the preview changes, which is the case this feed's
  validator exists to catch, so a cache keyed on that hash serves the old table for its whole TTL
- **Spell the special numbers the way OData does.** `nan`, `inf` and `-inf` in a CSV are read as a
  DOUBLE column, and `JSON.stringify` writes those as `null` — a value the file had arriving as a
  gap, against a `Nullable="false"` property. OData JSON 4.01 spells them `"NaN"`, `"INF"` and
  `"-INF"` (learned in implementation)
- **No ornament in the response.** Emit no OData annotation a client does not use, and stream the JSON
  rather than building it and then sending it
- **Keep the log to one line.** ADR-032's `query` log records the SQL; this route is hit dozens of
  times by one extract. One line per request, and nothing about the rows

#### `/odata/*` needs a CloudFront behaviour of its own

There are three behaviours today and **none of them fits this route** (`infra/lib/constructs/cdn.ts`).

| Path                | Policy                       | Why it does not fit                                                                                                                   |
| ------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `/_next/static/*`   | `CACHING_OPTIMIZED`          | Not applicable                                                                                                                        |
| `/auth/*`, `/api/*` | **`CACHING_DISABLED`**       | Placed under `/api/`, **whatever `Cache-Control` says is ignored**                                                                    |
| Default (HTML)      | `minTtl 60s` / `maxTtl 300s` | `minTtl` holds a response for 60s even when the origin says not to cache; `maxTtl` caps "immutable version, long TTL" at five minutes |

So a behaviour and cache policy for `/odata/*` have to be added — **an infrastructure change, not an
API one**. That policy must:

- **Keep the query string in the cache key.** Drop it and `$skip=0` and `$skip=1000` collide, so **the
  reader receives the same thousand rows forever**. Nothing reports an error
- Keep cookies out of the key. This route has none (decision §5)

#### What it takes for a stream to be cached

CloudFront can cache a chunked response, with conditions.

- **The response has to complete.** A response cut short is not stored. Decision §3's "a rolling
  update cuts a response" lands twice here: the cache does not fill either
- **Bytes have to keep flowing.** CloudFront's origin response timeout is not a total duration but
  "how long it waits for a response" and "the gap between packets". **Emitting the first bytes early
  becomes a condition of caching, not a performance nicety** — materializing for tens of seconds
  before the first byte fails it
- The object-size ceiling (around 30 GB) does not bind at this scale

As a side effect, **CloudFront collapses simultaneous misses on one key into a single origin fetch**.
Several people refreshing their extracts at the same hour cost one generation, not several.

## Consequences

- **A new public surface.** Authentication, rate limiting and access control
  (`getByIdWithAccessCheck`) have to follow the same rules as the existing routes
- ~~**ADR-032's open item §4 (a temp-file cache) turns from an optimization into a precondition.**~~
  **The implementation removed the need (Step 1).** `QueryService.query()` downloads the Parquet to a
  temp file on every call, but the feed has **DuckDB read `s3://` directly and fetch only the byte
  ranges a page needs**. Measured against MinIO over a million rows in 8.9 MB: **0.11–0.18 MB per
  page**, first page and last alike, and nothing written to disk. The web image already ships `httpfs`
  and `aws`, and the credentials are passed the way the lake passes them (`credential_chain` plus
  `REFRESH auto` on AWS). **It does mean external access stays open while a page is read**, so
  everything else is closed instead (`disabled_filesystems` for LocalFileSystem and HTTPFileSystem,
  then `lock_configuration`). Where ADR-032 can materialize and then shut everything off, this reads
  as it writes and keeps only the object store
- **The concurrency budget has to be separate from ADR-032's.** `withDuckdbSlot()` allows
  `QUERY_MEMORY_LIMIT_MB = 256` times one, and a BI tool's full extract running through it would lock
  agents out with 429s
- **The public UI gains a "open in a BI tool" affordance** (decision §1'): an entry point of its own on
  the resource page, and a reason where the resource cannot be served
- **Mapping `$metadata` types is a new responsibility.** Column types come from the schema already
  persisted by ADR-032 Part A, and the DuckDB-type-to-EDM-type table lives in one place
- **Whole-table reads spend the web container's time.** With the option of offloading to S3 through a
  signed URL closed by ADR-017, the response time and the held task are KUKAN's to carry (open question 11)
- No effect on the existing API, MCP or preview paths — this is additive

## What It Costs to Build

Part of this rides on what exists; the rest is new judgement.

**What it rides on**: column names and types are already persisted as a `ResourceSchema` (ADR-032
Part A) in `resource_pipeline.metadata`, and `PipelineService.getQueryTarget()` returns them together
with the Parquet key in one query. Visibility is `ResourceService.getByIdWithAccessCheck()`, and
`isQueryable()` decides what can be published. The CKAN-compatible router (`/api/3/action`, 299 lines)
stands as an example of carrying a foreign protocol.

**The weight is in the decisions, not the line count** — chiefly open questions 1 and 2.

| Piece                                                    | Rough size | Difficulty |
| -------------------------------------------------------- | ---------- | ---------- |
| Service document and router skeleton                     | ~80 lines  | Low        |
| `$metadata` (CSDL XML generation)                        | ~150 lines | Medium     |
| Name normalization, collision handling, the mapping back | ~120 lines | **High**   |
| Type mapping and JSON serialization                      | ~100 lines | Medium     |
| Reading an entity set (paging, identifying a row)        | ~150 lines | Medium     |
| ~~Temp-file cache (ADR-032 open item §4)~~ not needed    | —          | —          |
| Its own semaphore, limits, and the pointer to a file     | ~80 lines  | Low        |
| CloudFront behaviour and cache policy (**infra**)        | ~60 lines  | Low        |
| Showing the URL on the resource page                     | ~60 lines  | Low        |
| Tests (integration, the variety of column names)         | ~400 lines | Medium     |

Roughly 1,100–1,400 lines — a little over twice the CKAN-compatible router (299 lines plus 402 of tests).

### Phases

**Step 1 (small, a proof)**: publish a minimal V4 implementation for resources whose column names are
already valid EDM identifiers. A synthetic key, `$top` and `$skip` only, no `$filter`. **Paste the URL
into Tableau, Power BI and Excel and confirm the table opens** (~400 lines). If it does not open there,
building the rest is pointless.

> **Measured while implementing (addendum)**: the ~400-line estimate did not hold. Reading moved to
> S3 (above), the page is streamed rather than held, an extract is pinned to one version, and the
> lockdown and its tests came with it — about 2,000 lines including tests. And **what Step 1's terms
> can serve is 25.4% of the development catalogue's public tabular resources** (66 of 260); the rest
> wait on the normalization in open item 1 (below).

**Step 2**: settle the name normalization rules and extend it to every resource. This is the body of the work.

**Step 3**: the pointer to a file and `$filter` (~~the temp-file cache~~ — see the impact section).

## Open Questions

1. **Normalizing column names (the heavy one).** **Measured: without these rules, 74.6% of the
   development catalogue's public tabular resources cannot be served** (194 of 260). The characters
   doing it: `/` 930, `(` and `)` 576 each, full-width brackets ~380, `-` 322, `[` and `]` 280 each.
   `$metadata` declares each column as a property name,
   and an EDM identifier starts with a letter and continues with letters, digits and `_`. **Japanese
   characters themselves are fine**, but Japanese open-data headers routinely read `人口（人）`,
   `面積 (km²)`, `H31.4.1現在` — **parentheses, spaces, symbols and periods are the norm**, and none
   of them can be declared. Three things need deciding: the transformation, what happens when two
   headers collide after it (`面積 (km2)` and `面積（km2）` land on the same name), and **where the
   original header survives** (an annotation such as `@Core.Description` is the natural home). Since
   the transformed name reads poorly to a person, display name and identifier end up separate things
2. **Identifying a row.** An OData EntityType **requires a key**, and a KUKAN table does not
   necessarily have one (ADR-043 ii-b made a primary key expressible, not present). A synthetic key —
   the row number — is the fallback, but it assumes **the Parquet's row order is stable** (as does
   `$top`/`$skip` paging), and **a new version changes what a row number means**, so the same key does
   not follow the same row across versions. Whether a declared primary key should be used when there
   is one is undecided
3. **Serializing integers and timestamps** (Step 1 emits Int64 as a JSON number and a zoneless
   timestamp as `Edm.DateTimeOffset` with `Z` appended — both shipped undecided)**.** `integer` is INT64, which raises exactly the problem
   `ColumnStats` already names — INT64 exceeds JavaScript's safe range, so it holds bounds as strings.
   OData JSON writes `Edm.Int64` as a number by default and as a string under
   `IEEE754Compatible=true`, and **the choice changes how a BI tool reads it**. `Edm.DateTimeOffset`
   requires an offset, so what KUKAN's timestamps actually carry has to be checked
4. **Designing the disposable Basic credential (later).** v1 does not publish non-public resources
   (decision §5). When it does, what remains undecided is the unit it is issued for (a resource or a
   site), the default expiry, how it is revoked, and whether it rides on `api-token-service`'s existing
   tokens or is its own thing. The Basic path stays confined to `/odata`
5. **Which OData version.** V4 (JSON) is the natural start, though an older client may want V2
   (XML/Atom). Begin with V4 alone and revisit if asked
6. **The threshold for sending a reader to a file, and how to say so.** At how many rows? Can the
   refusal be **explicit** in OData's own vocabulary (a custom annotation, or an error body) — never a
   withheld `@odata.nextLink` (see the addendum to decision §3)? And does the destination stay the
   stored file, or is the interpreted table generated instead?
7. **How much of `$filter` to support.** Tableau will not use it, but Power BI may push one down.
   Which operators are accepted, and how an accepted expression maps safely onto SQL
8. **Publishing past versions.** Whether ADR-043's versions become entity sets, and what the URLs look like
9. **Whether Tableau opens a local .parquet**, checked against a real install. If not, the pointer is a CSV
10. **Rate limiting.** A full extract is not one request. Whether the OData route gets its own
    concurrency limit
11. **Caching keyed by version.** ADR-043's versions are immutable, so **a given version's CSV is
    immutable too**. Keying the URL by version puts it behind CloudFront with a long TTL, which turns
    the cost of generating it from per-request into **per-version** and largely removes C''s drawback.
    The shape of that key (`/resources/{id}/versions/{v}/export.csv`, say), the TTL, and what a URL for
    the current version does are undecided

## Related ADRs

- ADR-014 / ADR-029: preview Parquet and column type inference (what an entity set is made of)
- ADR-017: server-proxied download and preview (where whole-table reads land; read-side signed URLs were removed)
- ADR-032: MCP data query platform (source of the column schema; its sandbox is not reused)
- ADR-033: external SQL data sources (proposed; shares the query-execution discussion)
- ADR-043: resource versioning (the unit a version publishes as)
