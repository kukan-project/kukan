# ADR-055: BI Tool Access to Table Data (Read-Only OData Endpoint)

> This is a machine-assisted translation of the Japanese original
> (`docs/adr/jp/055-bi-table-access-odata.md`), which is authoritative.

## Status

**Accepted** — Step 1 implemented on 2026-09-24 (see "Phases"). The feed serves public resources
whose column names pass as EDM identifiers as they are. Step 2 (column-name normalization, open
question 1) and Step 3 have not been started.

This ADR compares the routes by which a BI tool (Tableau as the originating request, and with it Power BI
and Excel) can reach KUKAN's table data, and takes B (OData) as the entry point.

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

### What was checked against the real clients (added after Step 1)

The table above comes from vendor documentation. With Step 1 implemented, **Tableau Desktop 2026.2 and
Excel (Power Query, `Microsoft.Data.Mashup`) were pointed at the feed** and what they sent was recorded
server-side. **Power BI connected and read the table too** — that one was checked for whether it works,
not measured the way the table below measures the other two.

| Observation           | Excel / Power Query                                        | Tableau Desktop                           | Power BI Desktop                      |
| --------------------- | ---------------------------------------------------------- | ----------------------------------------- | ------------------------------------- |
| `IEEE754Compatible`   | **Never sent** (`application/json;odata.metadata=minimal`) | **Never sent** (`Accept: */*`)            | **Never sent**                        |
| Integers past 2^53    | **Rounded** (JSON read as doubles)                         | **Exact** (read as 64-bit integers)       | **Exact**                             |
| `Accept-Encoding`     | Sent                                                       | **Not sent** — no compression             | Sent (`gzip, deflate`)                |
| `OData-MaxVersion`    | `4.0`                                                      | Not sent                                  | `4.0`                                 |
| Trailing slash        | Not appended                                               | Not appended                              | Not appended                          |
| `$select` / `$filter` | Not sent                                                   | **Not sent** — filters act on the extract | **Not sent** (no query string at all) |
| 200,000 rows          | 4 pages **plus a second fetch of page 1**, ~4 s            | 4 pages exactly, **~2.2 s**               | Fetched page 1 four times (not timed) |
| Version fingerprint   | Carried through the next links                             | Carried through                           | Not observed (next links go direct)   |

The Power BI column was recorded through a logging proxy. Its user agent is `Microsoft.Data.Mashup`, the
same engine as Excel's, and **the HTTP conversation is much the same**. Where they part is the integers:
an Excel worksheet holds doubles and rounds, while Power BI's model keeps 64-bit integers —
`9007199254740993` and a 19-digit column counting up from 10^18 both came through digit for digit.

Three things follow.

1. **`IEEE754Compatible` (open item 3) would serve nobody.** **None of the three sends it.** Tableau and
   Power BI are already exact and Excel does not ask. And writing an Int64's digits straight into the JSON, as the implementation does, works exactly as
   designed: a client that parses into 64 bits gets the value back, and one that parses into a double is
   where it was. Had this followed the spec's "serialize as strings", Tableau's numbers would have
   degraded into text columns.
2. **Excel fetches page 1 twice on every refresh** (a schema probe before `$metadata`) — 25% more bytes on
   this table. Behind CloudFront that is a cache hit on the same query-less URL; against the origin it is a
   plain duplicate.
3. **Tableau asks for no compression**, so the "JSON is 2.7× the file" figure decision §3 rests on is what
   actually crosses the wire there.

Two facts out of that table decide the design.

1. **No client pushes a projection down.** Tableau's OData is extract-only and `$select` is inert there;
   Excel and Power BI do not send one either. Every refresh pulls **the whole entity set, every column**,
   so "pull just the columns we need" is not available
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

## Decision

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
> trips. "Several hundred round trips" assumed a 1,000-row page; it does not describe a 65,536-row one.
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
  caches none of this** (below). **A response that names no interpretation revalidates every time** (learned in
  implementation) — `$metadata`, a page carrying no fingerprint, and `$count`. The first declares
  the columns the rows are read under and a client holds it for the whole extract. Closing only one
  of the two leaves **the same fault the other way round**: a page a minute old beside the current
  CSDL, and a table that fits in one page never reaches a next link to have its version checked.
  Neither response says so. The validator comes out without reading data (`notModified()` runs before
  `openPage()`), so revalidating costs **two database reads, measured at 0.36 ms**, and an unchanged
  version answers 304 without touching the Parquet. **Pinning the first page by redirecting into a
  versioned URL is not the answer**: a BI tool that saves the URL it resolved would meet a 410 on its
  next refresh after any re-interpretation — a broken refresh path traded for a narrow window. What
  remains is one request's worth of race between `$metadata` and the first page, which only pinning
  across versions would close (open item 11). **The service document may be held**: it names the
  entity set and says nothing about the table, so a copy a minute old is the same bytes as a fresh
  one. **Note that "immutable, so it can be held" does not set the TTL**
  (learned in implementation). What sets it is withdrawal — purging the version being served, making
  the dataset private, deleting the resource — where the origin refuses from that moment and a copy
  already in a cache does not. Purging an _older_ version is not among them: the feed never served it
- **Do not re-read the schema per page.** `$metadata` and the column mapping are fixed per version, so
  cache them in the process. **Step 1 does not** (learned in implementation): the read measures
  0.36 ms against a page's ~60, and no cheap key stands in for it — a re-interpretation of unchanged
  bytes leaves the content hash alone while the preview changes, which is the case this feed's
  validator exists to catch, so a cache keyed on that hash serves the old table for its whole TTL
- **Do not build a DuckDB instance per page** (improved after implementation). Preparing one —
  loading extensions, creating the secret, locking it down — cost about 18 ms per page with static
  keys. Prepared instances are now kept per bucket, and a page starts at `connect()`. An instance
  unused for 60 s is closed, and one in steady use is rebuilt 15 minutes after it was prepared, as a
  backstop for a lapsed credential that the secret's `REFRESH auto` missed. No more are in use at once than there are slots. Measured locally
  (MinIO, medians):

  | Case                           | Built each time | Kept   |
  | ------------------------------ | --------------- | ------ |
  | One page (3-row table)         | 24.5ms          | 10.1ms |
  | One page (3.8 MB response)     | 98.7ms          | 78.9ms |
  | Full extract, 4 pages (narrow) | 345ms           | 255ms  |
  | Full extract, 4 pages (wide)   | 438ms           | 347ms  |

  Three conditions, all found by measurement:
  - **Set httpfs's `http_timeout` / `http_retries` with `SET GLOBAL`.** A plain `SET` binds only
    the connection it ran on, and the next one is back at the default 30 s × 4. The guard against
    an unresponsive S3 would silently stop applying from the second page on
  - **Hand an instance back only after a page read to its end.** One that timed out may still hold
    a request that could not be stopped. A stream abandoned partway holds its buffers (5.7 MB
    measured) until garbage collection, eating into the next page's memory limit
  - **Turn off both the external file cache and the Parquet metadata cache.** The metadata cache
    is another 10–25 ms faster, but grows with every distinct file read (+200 MB RSS over 60 wide
    files), and an instance under steady traffic never closes, so it has no bound. With both off,
    reading 180 files stayed flat

  A kept instance holds about 44 MB of RSS until it is closed (no allocator or httpfs setting moved
  it). That is inside one slot's budget (64 MB)

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

#### A page's size is decided by the row group (found in implementation)

**Pages are not a fixed size.** Parquet decodes a whole row group to hand out even one row of it, so
what a page reads is `groups touched × the group's decoded bytes`, and **a page that crosses a
boundary holds two groups at once**. Bounded by rows and cells as it first was, a 20-column Japanese
table served its first page and failed on the third — the one that straddled a boundary. **What
arrives is not a broken table**: the page is opened before a byte is written and the read fails at
`conn.stream()`, so the extract meets an unexplained 500 (measured). From the BI tool's side, a table
that worked yesterday simply errors today.

So a page is held to **as many groups as the budget affords, and cut at that boundary**. Where
`$skip` lands part way into a group, the page is shorter and the next link resumes on the boundary. A
narrow table's groups are small, the count is high, and the boundary never binds (11 groups at once
reads); a wide table's page stays inside one.

Measured one page per process, with 4,096-row groups:

| slot   | group reads that serve | that fail |
| ------ | ---------------------- | --------- |
| 64 MB  | 28 MB                  | 38 MB     |
| 128 MB | 38 MB                  | 70 MB     |
| 256 MB | 140 MB                 | 210 MB    |

**The ceiling tracks the slot at roughly half of it** — not the slot less a fixed overhead, which
would have let 210 MB through at 256. The implementation budgets a quarter of the slot and spends the
other half of that headroom on the row-size estimate being an estimate.

A consequence: **`ROW_GROUP_SIZE` is kept to a multiple of 2,048**, DuckDB's vector size, because it
rounds up to one. A file written asking for `5000` holds 6,144 rows, which nothing in the code said
and every reader had to discover. It is now 4,096, and the value the file was actually written with
is recorded in the preview's metadata.

**A preview that recorded no figure is treated as unknown rather than guessed at.** Two
implementations have written previews — before DuckDB took over, hyparquet-writer wrote the 5,000
rows it was asked for exactly — and both eras are still served (a preview with no `sourceHash` is
trusted). Nothing distinguishes them from outside, so cutting on either multiple would manufacture
the straddled read this exists to prevent. Pages are cut at boundaries only where the boundaries are
known; elsewhere the byte budget alone bounds them, until a re-interpretation records what the file
holds.

**Existing previews catch up through one operator-run pass.** The new group size applies to previews
written from now on, so the rest are read once — a footer apiece — when a sysadmin presses "Prepare
tables for BI tools" (`GET /api/v1/admin/row-group-status` /
`POST /api/v1/admin/record-row-groups`). Only the ones recording cannot save — a group over budget
that a 4,096-row one would bring under it — are also re-interpreted with `rebuildOnly`, which
**does not re-fetch external URLs**. The prompt disappears once nothing is left.

**The read side does not write.** Taking the footer during the first page read and writing it back
was considered and rejected: this is an unauthenticated public surface a BI tool hits hundreds of
times, and putting a database write on it makes a public read write, while still leaving the first
page of every unrecorded table slow. The footer read itself is the same work either way — only who
pays for it, and when, has moved.

**A table that cannot be served is decided by the read, not predicted** (a single group over budget
is 3.9 KB a row with 4,096-row groups; a group cannot be divided, so no smaller page reaches it). The
original design refused such tables up front from the row-size estimate, and **the estimate refused
tables that read** — 27 MB of group against a 25.6 MB ceiling, where reads actually begin to fail at
38 MB. The estimate has no breakdown of the bytes, so that error does not shrink. So the refusal
comes from the read: `conn.stream()`'s out-of-memory is caught and answered with `501` and "This
table cannot be served as OData … download the file instead". The page is opened before a byte of
the body is written, so this arrives as a whole RFC 7807 body rather than a truncated one (measured).
**The estimate is kept only as a caution** — the resource page's OData dialog says the table's rows
are large and may not read. It does not say the table is refused.

## Consequences

- **A new public surface.** Authentication, rate limiting and access control
  (`getByIdWithAccessCheck`) have to follow the same rules as the existing routes
- ~~**ADR-032's open item §4 (a temp-file cache) turns from an optimization into a precondition.**~~
  **The implementation removed the need (Step 1).** `QueryService.query()` downloaded the Parquet to a
  temp file on every call at the time (**it has since moved to reading in place too** — ADR-032 Part
  B-3), while the feed has **DuckDB read `s3://` directly and fetch only the byte ranges a page
  needs**. Measured against MinIO over a million rows in 8.9 MB: **0.11–0.18 MB per
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
   not follow the same row across versions.

   > **Decided (addendum)**: **a designated primary key becomes the key where OData allows it, and the
   > synthetic one is the fallback.** Three conditions — a single column; that column identifies a row
   > (`unique`, frozen per version by ADR-046: every value distinct, none missing); and its type is one
   > CSDL 4.01 §6.5 permits for a key.
   >
   > **A floating-point column is not a key.** Binary floating point does not correspond one-to-one
   > with the decimal text it travels as, so a value that round-trips through JSON is not guaranteed to
   > come back as the same bits — which is to say it is not an identifier other systems can share
   > (measured: `'1.0'` and `'1'` collapse to one key). CSDL 4.01 §6.5 admitting `Edm.Decimal` and not
   > `Edm.Double` follows from that; the reason is the round trip, not the list. Inside DuckDB
   > **`NaN = NaN` is true**, so layer 2's `MERGE` is not broken by one (an earlier claim here that it
   > was is wrong) — the problem is at the boundary. KUKAN will stop offering a floating-point column
   > as a primary key at all, which it now does (spec §6.4). **The condition stays in the feed
   > regardless**: the refusal applies to changing a key, so one set earlier — or one whose column
   > has since re-read as `float` — still stands, and the feed falls back to the synthetic key and
   > reports the same `key-float`. Where the conditions hold, no `RowId` column is added: the
   > key keeps its meaning across versions, and the reader's table gains no column of ours.
   >
   > **A composite key rides on layer 2's verdict.** The frozen counts are per column and say nothing
   > about a combination (spec §6.3) — but the ingest asks the same question of the real data **per
   > version** (spec §6.6): a version whose key repeats never enters layer 2, and one that does records
   > the key it was taken under (`lake_key_columns`). What it read is the Parquet the interpretation
   > produced, **the same rows this feed serves**, so a recorded key is a verdict about this content.
   > So a key is used when it is either a single `unique` column or the one its version entered layer 2
   > under, and falls back otherwise. Declaring it unchecked would hand a BI tool a key that repeats,
   > and it folds rows together without saying so.
   >
   > Two costs. **The lag before a version reaches layer 2** — a new version falls back to the
   > synthetic key until its ingest lands; the key is part of the interpretation fingerprint's seed, so the switch
   > arrives as a 410 rather than a shape that changes silently mid-extract. And **a deployment not
   > running layer 2 cannot use a composite key** (a single-column key is answered by the frozen counts
   > and is unaffected).

3. **Serializing integers and timestamps** (Step 1 emits Int64 as a JSON number and a zoneless
   timestamp as `Edm.DateTimeOffset` with `Z` appended — both shipped undecided)**.** `integer` is INT64, which raises exactly the problem
   `ColumnStats` already names — INT64 exceeds JavaScript's safe range, so it holds bounds as strings.
   OData JSON writes `Edm.Int64` as a number by default and as a string under
   `IEEE754Compatible=true`, and **the choice changes how a BI tool reads it**. `Edm.DateTimeOffset`
   requires an offset, so what KUKAN's timestamps actually carry has to be checked

   > **What Step 1 does (addendum)**: an integer outside the safe range goes out as **its own digits,
   > as a JSON number** (`JSON.rawJSON`, ES2024). JSON puts no limit on how many there are, so a client that parses into a
   > 64-bit integer (Power Query, .NET, Java) gets the value back, and one that parses into a double
   > is where it was — but **the server has stopped altering the value** (`Number(9007199254740993n)`
   > is …92). Emitting strings instead needs `IEEE754Compatible` negotiated, and a client that did not
   > ask for it would receive a string where the metadata promised `Edm.Int64`. Which of the two is
   > the default is what stays open, and it is this item. **The condition on a key stays either way**:
   > the digits arrive, but in the hands of a client that parses them into a double two keys become
   > one — a rounded figure anywhere else, two rows merged where it is the key

   > **Closing this item (addendum)**: measured against both clients, neither sends
   > `IEEE754Compatible`, and the same response is read exactly by Tableau and rounded by Excel
   > ("What was checked against the real clients", 1). Defaulting to strings would turn values Tableau reads today
   > into a type mismatch. **Numbers it stays.**

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

   > **Read before starting (addendum)**: **what protects the feed today is not the lockdown
   > but the absence of any way to run arbitrary SQL.** The one statement this path gives
   > DuckDB is `SELECT * FROM read_parquet(<key>) LIMIT <int> OFFSET <int>`; `$top` and
   > `$skip` are validated as integers, and every other shaping option is refused with 501.
   >
   > The session does carry the `aws` extension (where the deployment uses the credential
   > chain). The `load_aws_credentials()` it registers is **not a filesystem call**, so
   > neither `enable_external_access = false` nor `lock_configuration = true` reaches it,
   > and it answers with the task role's key id and session token in the clear (measured).
   > ADR-032's query path hit exactly this and moved to a signed URL so the extension is
   > never loaded.
   >
   > So an implementation that maps `$filter` onto SQL **breaks that premise**. Either the
   > grammar has to make a function call unwritable, or the feed's session has to drop `aws`
   > too (a signed URL, say) — decided in the same change as the push-down, not after it.

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
