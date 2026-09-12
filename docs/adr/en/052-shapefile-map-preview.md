> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/052-shapefile-map-preview.md`](../jp/052-shapefile-map-preview.md).

# ADR-052: Map Preview for Shapefiles (Interpreting a SHP Inside a ZIP as GeoJSON)

## Status

**Proposed — implementation deferred**

Not implemented until the handling of large shapefiles is settled: the output caps,
whether hitting one truncates or simplifies, and whether the artifact stays GeoJSON or
becomes a spatially indexed format. This ADR stands as the record of the investigation and
its measurements.

Take a ZIP holding a shapefile set and, in the Interpret stage, **interpret it into GeoJSON
written out as the preview artifact**. Display reuses the existing GeoJSON map preview.
The interpretation runs in pure JavaScript (shpjs's `parseShp` / `parseDbf`); DuckDB
spatial is not used — it cannot decode the CP932 attributes common in Japanese open data.
Pulling files out of the ZIP stays with the existing yauzl, and **deciding the encoding
stays with KUKAN**.

The canonical object (the uploaded ZIP itself) is untouched. The GeoJSON is a preview —
a product of "interpretation" in the sense of ADR-046.

## Context

### 1. A shapefile is not one file

A shapefile is a bundle: `.shp` (geometry), `.shx` (index), `.dbf` (attributes), `.prj`
(coordinate reference system) and `.cpg` (attribute encoding). A `.shp` on its own reveals
neither attributes nor CRS, which is why these are distributed as ZIPs.

A KUKAN resource is one object, so **the entry point is always a ZIP**. A bare `.shp`
could in principle be registered on its own, but with neither attributes nor CRS there is
little worth mapping. This ADR covers ZIPs only.

### 2. What the ZIP path produces today

The Interpret ZIP branch (`apps/worker/src/pipeline/steps/interpret.ts`) builds a file
listing with `extractZipManifest` (`interpret/zip.ts`, which reads only the central
directory via yauzl) and writes it as a JSON preview artifact. Contents are never
expanded.

So registering a shapefile ZIP ends at a screen listing `townarea.shp`, `townarea.dbf`,
`townarea.prj` and so on. Even when it is obviously geographic data, the catalogue cannot
see inside it.

### 3. What already exists

Little of this has to be built.

| Part               | Where it lives                                                      | Use here                              |
| ------------------ | ------------------------------------------------------------------- | ------------------------------------- |
| Map preview        | `geojson-preview.tsx` / `geojson-map.tsx` (Leaflet, OSM/GSI switch) | Reused as is                          |
| Writing artifacts  | `getPreviewKey` + `putObject` (Interpret)                           | Writes the GeoJSON                    |
| Serving artifacts  | `GET /api/v1/resources/:id/preview` (Range-capable)                 | Returns the generated GeoJSON         |
| Encoding detection | `detectEncoding` / `bufferToUtf8` in `encoding-node.ts`             | Decides the `.dbf` attribute encoding |
| Reading ZIPs       | `interpret/zip.ts` (yauzl)                                          | Extracts `.shp`/`.dbf`/`.prj`/`.cpg`  |

One piece does not line up. The existing GeoJSON preview reads
`GET /api/v1/resources/:id/json` — **the live object itself**, not an artifact. A
shapefile map has to read an artifact, so the read side needs work.

### 4. What Japanese open data actually looks like

Three realities all but settle the choice of library.

**Attribute encoding.** `.dbf` attributes are frequently CP932 (Shift_JIS). Some
distributions carry no `.cpg`, and those that do vary between `CP932`, `932`, `SJIS` and
`Shift_JIS`. Note that `CP932` and `932` are not WHATWG encoding labels, so
`new TextDecoder('CP932')` throws `RangeError` (measured). Labels need normalizing.

**Coordinate reference systems.** Geographic coordinates (JGD2011 = EPSG:6668, the older
JGD2000 = EPSG:4612) and the Japan Plane Rectangular systems (EPSG:6669–6687, 19 zones)
both appear. GeoJSON (RFC 7946) is defined in WGS84, so projected data **cannot reach a
map without reprojection**.

**Missing `.prj`.** Some distributions never state the CRS. Whether the data is geographic
or which of the 19 plane rectangular zones it uses cannot be settled from the files alone.

## Options considered

### A) Let DuckDB spatial read it

The worker already carries DuckDB (ADR-043 layer 2), and the Dockerfile already
pre-installs extensions at image build time (for closed networks). Adding the single word
`spatial` gives `ST_Read`, which reads straight into a ZIP via
`/vsizip/foo.zip/layer.shp`, recognizes the EPSG code from `.prj` automatically, and
reprojects to WGS84 with `ST_Transform`. It is fast.

**Exactly one thing rules it out, and it is fatal: it cannot decode CP932 attributes.**
Neither a `.cpg` nor `open_options := ['ENCODING=CP932']` / `['ENCODING=SHIFT_JIS']`
produces anything but mojibake (measured). The write side fails with
`cannot convert to CP932`, so the bundled iconv carries no Japanese code pages. A hybrid —
geometry from DuckDB, attributes from reading the `.dbf` ourselves — would need a
**guarantee that GDAL's row order matches the `.dbf` record order** (`ST_Read` exposes no
FID), inviting a failure where attributes silently shift by a row. Too high a price for
speed.

### B) Extract with the existing yauzl, interpret with shpjs's `parseShp` / `parseDbf` — chosen

Alongside its top-level API that swallows a whole ZIP, shpjs (MIT, 6.2.0) **exports
`parseShp(shp, prj)`, `parseDbf(dbf, cpgLabel)` and `combine([geom, props])` by name**.
That buys:

- ZIP expansion stays with the existing yauzl (one place reads ZIPs)
- **The encoding label is chosen by KUKAN and passed in** — the existing chardet-based
  detection applies
- `.prj` interpretation and reprojection to WGS84 are done by shpjs via proj4

Through the top-level API (`shp(buffer)`) the encoding comes only from the `.cpg` inside
the ZIP, with no way to intervene. shpjs's dist build (the bundled ESM) also assumes
`self` and throws on load under Node; `lib/index.js` — the entry its package `import`
condition points at — does not. **The named-export path steps on neither mine.**

### C) Convert in the browser

shpjs was written for browsers, and downloading the ZIP to convert it client-side is the
least code. But it never passes through the pipeline, so **no artifact is kept**. Every
view transfers the whole ZIP (up to 100 MB) and converts again, with no way to judge size
limits, record a failed interpretation, or re-run one. Every other preview is "serve what
Interpret produced"; this one alone would be shaped differently.

### D) Do nothing

Leave shapefile ZIPs as file listings. A geographic catalogue is poorer for it, but there
is a defensible position that a half-working map misleads more than it helps until the
three realities above (encoding, CRS, missing `.prj`) have somewhere to land.

## Spike (measured 2026-09-11)

Since the only thing separating A from B was "can it decode Japanese attributes", both
were run over synthetic fixtures.

**Fixtures.** Three points in EPSG:6677 (JGD2011 Japan Plane Rectangular CS IX) written
out through DuckDB spatial's GDAL driver, with Japanese attributes (東京都庁 / 浅草寺 /
羽田空港). The CP932 `.dbf` was produced by re-encoding the record area of the UTF-8
`.dbf` byte by byte while preserving its fixed widths. For scale, 50,000 five-vertex
polygons (`.shp` 6.8 MB + `.dbf` 10.2 MB, 1.5 MB zipped).

| Check                                   | A: DuckDB spatial                    | B: shpjs (named exports)             |
| --------------------------------------- | ------------------------------------ | ------------------------------------ |
| Reprojection from `.prj` (6677 → WGS84) | ✅ correct coordinates               | ✅ same (agrees with A to 1e-14)     |
| UTF-8 attributes                        | ✅                                   | ✅                                   |
| **CP932 attributes**                    | ❌ neither `.cpg` nor `open_options` | ✅ decodes correctly given the label |
| Reading inside a ZIP                    | ✅ `/vsizip/…`                       | — (extracted with yauzl)             |
| Interpreting 50,000 polygons            | 157 ms                               | 492 ms                               |
| GeoJSON out                             | 11.5 MB, geometry only               | 20.7 MB with attributes (RSS 248 MB) |
| Loading under Node                      | —                                    | `lib/index.js` yes, dist no (`self`) |

**Verdict.** As one step of a pipeline, the speed difference (157 ms against 492 ms) is
negligible either way. Encoding is the only real difference, so B it is.

**Also learned.**

- 1.5 MB zipped expanded to 17 MB and became 20.7 MB of GeoJSON (**about 13×**). That is
  with trivial synthetic polygons; real municipal boundaries (hundreds of vertices per
  polygon) inflate further. Input size does not predict output size
- Without a `.prj`, DuckDB returns a `null` CRS and shpjs returns the projected
  coordinates unchanged (`[-8000, -34000]`). Both make "unknown" visible
- `TextDecoder` accepts `Shift_JIS` and `SJIS` and rejects `CP932` and `932`

The spike fixtures are not committed (this ADR is the record of the numbers).

## Decision (proposed)

### 1. Interpret shapefile ZIPs into GeoJSON in Interpret (option B)

A ZIP whose central directory holds a `.shp` **with a `.dbf` of the same name** counts as a
shapefile ZIP. `.shx` is not required, since the interpretation does not use it. The test
looks only at file names and does not touch the `resource.format` column (it is an
external contract of the CKAN-compatible API and a user's own input; a content-derived
verdict is not written back into it).

### 2. Extract with the existing yauzl, interpret with shpjs's named exports

Add, next to `extractZipManifest`, a path that expands only the entries needed — `.shp`,
`.dbf`, `.prj` and `.cpg`, and nothing else in the ZIP. The expanded total is capped
(decision 6).

### 3. Encoding is decided by `.cpg`, then detection from the `.dbf`, then UTF-8

1. If a `.cpg` exists, normalize its contents to a WHATWG label and use it (`CP932` /
   `932` → `shift_jis`, sharing the vocabulary the existing `bufferToUtf8` normalizes
   with). A label that cannot be normalized is treated as absent
2. With no usable `.cpg`, run the `.dbf`'s record area through `detectEncoding` (chardet
   plus the Japanese re-check). **Pass the record area, not the header** — DBF field names
   are limited to 10 ASCII bytes and carry no Japanese evidence
3. If neither settles it, UTF-8

### 4. Reproject by handing `.prj` to proj4; with no `.prj`, decide by coordinate range

Given a `.prj`, its WKT goes to shpjs (proj4) as is and the output is WGS84.

With no `.prj`, **do not guess the CRS**. If the bbox in the `.shp` header falls within
geographic range (|x| ≤ 180 and |y| ≤ 90), treat it as geographic and pass it through (the
difference between JGD2011 / JGD2000 and WGS84 is negligible for a preview). If it does
not, the data is projected and which of the 19 zones cannot be established, so **produce no
map: record the reason (`crs-unknown`) and fall back to the file listing**.

### 5. One GeoJSON artifact, with the ZIP listing folded into it

A resource has exactly one preview artifact key (`resource_pipeline.preview_key`). For a
shapefile ZIP, that key holds the GeoJSON. What the ZIP contained is folded into the same
artifact as a **foreign member** of the FeatureCollection — additional members RFC 7946
§6.1 explicitly permits.

```json
{
  "type": "FeatureCollection",
  "features": [...],
  "kukan:source": {
    "layer": "townarea",
    "crs": "EPSG:6677",
    "encoding": "Shift_JIS",
    "featureCount": 120000,
    "truncated": true,
    "layers": ["townarea", "buildings"],
    "files": [{ "path": "townarea.shp", "size": 6800000 }, ...]
  }
}
```

This avoids having to choose which of the manifest and the map to throw away. The `kukan:`
prefix is a namespace chosen in the expectation that a user's tools will ignore the member
if they download the GeoJSON directly (RFC 7946 requires parsers to ignore members they do
not know).

### 6. Cap both the expanded input and the output's feature count and bytes

| Stage           | Cap                    | On exceeding                                |
| --------------- | ---------------------- | ------------------------------------------- |
| Expanded input  | `.shp` + `.dbf` 100 MB | No interpretation (same as the fetch limit) |
| Output features | 50,000                 | Truncate from the start                     |
| Output bytes    | 10 MB                  | Truncate from the start                     |

Whichever output cap is hit first truncates, sets `kukan:source.truncated`, and **says so
on screen**. Never quietly show a part. The 10 MB matches the existing
`JSON_PREVIEW_LIMIT` (the cap `/json` serves under).

A small ZIP can still produce a large output (about 13× in the measurement), so a cap on
the input size alone is not enough. That is why the caps sit on the output.

### 7. With several layers, map only the first by name

A ZIP sometimes holds several `.shp` files. Map the first in name order (the order inside
the ZIP is tool-dependent and not deterministic) and list the other layer names under
`kukan:source.layers`. Switching layers is not built here.

### 8. Choose the preview by the kind of artifact

The front end's `resource-preview.tsx` picks a view from `format` alone today. A shapefile
ZIP keeps the format `ZIP`, so that branch can never reach a map. Add **the kind of preview
artifact** (`zip-manifest` / `geojson` and so on) to the resource response and branch on it
for ZIPs — the same shape CSV already uses, where the presence of a `schema` produces a
table.

The map preview gains a path that reads the artifact (`/:id/preview`). The only difference
from an existing GeoJSON resource (which reads the live object via `/json`) is where it
reads from.

## Consequences

- **worker**: shpjs joins the dependencies (transitively proj4 / parsedbf, all MIT). The
  Interpret ZIP branch splits in two
- **shared**: the shapefile-ZIP test, the `kukan:source` type, and the type for why no map
  was produced (`crs-unknown` and friends)
- **api**: the preview artifact kind joins the resource response
- **web**: the ZIP branch, and where the map preview reads from
- **Existing ZIP preview**: ZIPs that are not shapefiles behave exactly as before
- **DB**: no new column. This rides on the existing `preview_key` and the existing
  framework for recording an interpretation's reasons

Re-run behavior is unchanged from ADR-046: the GeoJSON is built from a version (an
immutable canonical file), so the same input yields the same artifact.

## Not doing

- **Full-text search over attributes** (ADR-021's territory). `.dbf` attributes do not
  enter the search index
- **Parquet for the attribute table.** Putting it on the table preview and `/query`
  (ADR-032) would give "map plus table", but it requires deciding how the geometry column
  is handled — beyond this ADR
- **Other formats — GeoPackage, FlatGeobuf, KML.** DuckDB spatial reads them, so formats
  without the encoding problem may deserve a different verdict
- **Guessing a CRS** (picking a plane rectangular zone number blind)
- **Converting the canonical object.** The uploaded ZIP stays a ZIP; the GeoJSON is an
  artifact

## Open questions

1. **Leaflet's drawing limit is unmeasured.** Whether 50,000 features actually render has
   not been checked. Confirm against real data, and if needed switch to the canvas
   renderer (`preferCanvas`) or lower the feature cap
2. How to present the case where both the `.cpg` and detection from the `.dbf` fail (read
   as UTF-8, full of replacement characters), consistent with how the existing text
   preview handles mojibake
3. The wording that explains **which features survived** a truncation. "The first 50,000"
   depends on the source's own ordering and is not necessarily a meaningful subset
4. What to do with a bare `.shp` registered on its own. Out of scope here; whether a
   geometry-only map is worth it is a separate question
5. Distributions where the `.shp` and `.dbf` record counts disagree (shpjs's `combine`
   pads to the shorter side with empty properties)

## Related ADRs

- ADR-046 (separating the canonical file from its interpretation) — the GeoJSON is a
  product of interpretation and can be rebuilt from a version
- ADR-021 (full-text search over resource content) — indexing attributes belongs there
- ADR-032 (MCP data query) — putting the attribute table on it would extend that
- ADR-043 (resource versioning) — artifacts are built from versions
