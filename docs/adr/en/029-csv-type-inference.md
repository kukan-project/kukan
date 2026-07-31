> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/029-csv-type-inference.md`](../jp/029-csv-type-inference.md).

# ADR-029: Automatic Column Type Inference for CSV/TSV Preview Parquet

## Status

**Accepted** — but **the implementation was replaced by ADR-046**. Typing the columns is still the
decision; the hand-written `inferColumnType()` this ADR specified became DuckDB's sniffer, and
`type-inference.ts` is gone. File paths below are the ones current at the time.

A design that extends phase 2 of ADR-016 ("DuckDB-WASM Data Explorer") and the "column type: all STRING" decision of ADR-014 ("Parquet preview format"). Integer, float, and boolean inference is implemented in the Extract step.

## Context

Currently, the Extract step (`apps/worker/src/pipeline/steps/extract.ts`) writes every CSV/TSV column to Parquet as `type: 'STRING'` (physical `BYTE_ARRAY` + logical `UTF8`). This causes the following limitations (see ADR-016 context):

1. **Incorrect numeric sorting**: in the DuckDB explorer `"9" > "80"` (lexicographic comparison)
2. **Useless Row Group statistics**: with all columns STRING, min/max-based Row Group skipping does not work
3. **Worthless type display in the field list**: the "type" in the field list (`ResourceFields`) is always "string"
4. **No range filtering**: the prerequisite for numeric range filters such as `BETWEEN` (ADR-016 phase 3) is missing

CSV/TSV is already fully parsed in the pipeline, so the cost of scanning each column's values to infer a type and writing typed Parquet is small.

## Options Considered

### A) Keep all columns STRING (status quo)

- Pros: simplest, zero misclassification risk
- Cons: all of the above limitations remain

### B) Automatic column type inference — adopted

- Pros: establishes the basis for numeric sorting, statistics, type display, and range filters
- Cons: risk of misinference (e.g., turning postal codes or line codes into integers and losing leading zeros)

### C) Manual type specification by users (schema editing UI)

- Pros: no misclassification
- Cons: high implementation cost and editing effort. Not mutually exclusive with auto-inference; a future add-on

## Decision

**In the Extract step, conservatively infer each CSV/TSV column's type and write typed Parquet.**

Because misinference can be fatal for open data, we **only assign a type when all rows reliably match**, and fall back to STRING at the slightest ambiguity. Since the original raw file is always retained (ADR-014), inference is acceptable as best-effort.

### 1. Target Types

| Inferred type | Parquet type (physical / logical) | Value representation (hyparquet-writer) |
| ------------- | --------------------------------- | --------------------------------------- |
| Integer       | `INT64`                           | `bigint`                                |
| Float         | `DOUBLE`                          | `number`                                |
| Boolean       | `BOOLEAN`                         | `boolean`                               |
| String        | `BYTE_ARRAY` / `UTF8` (current)   | `string`                                |

- **Dates/datetimes are out of scope** (kept as STRING for now). The risk of misinference due to date format ambiguity (`YYYY/MM/DD` vs `MM/DD/YYYY`, Japanese era, separators, presence/absence of time) is high. TIMESTAMP support will be considered in a future ADR.

### 2. Inference Algorithm (per column, full-row scan)

1. Scan all cells in the column and consider the set of **non-empty values excluding empty cells (`=== ''`)**.
2. A column with 0 non-empty values (all rows empty) is **STRING** (cannot infer).
3. Adopt the first type for which **all** non-empty values match the following patterns (in order of precision):
   - **Boolean**: all are only `true` / `false` (case-insensitive). `0`/`1`, `はい`/`いいえ`, `yes`/`no` are **excluded** (kept strict to avoid collisions with integers or language differences).
   - **Integer (INT64)**: all match `/^-?\d+$/` and satisfy all of the following conservative guards:
     - no leading zero (`"0"` alone is allowed, `"01234"` is not → treated as a code → STRING)
     - within signed 64-bit integer range (`|v| ≤ 2^63 − 1`). Overflow → STRING (preserve digits)
   - **Float (DOUBLE)**: all match `/^-?\d+\.\d+$/` (both integer and fractional parts required).
     - a leading zero in the integer part (`"01.5"`) is not allowed → STRING. Scientific notation (`1e5`) and thousands separators (`1,000`) are out of scope
   - none of the above → **STRING**
4. A column containing cells with surrounding whitespace will not match the regexes and automatically becomes STRING (no trimming).

> Integer is a subset of float, but the narrower type (INT64) takes precedence. Mixed types (e.g., a mix of numbers and strings) → STRING. Note that an integer-pattern value outside the INT64 range is not treated as numeric (a DOUBLE would change its digits); even when mixed with decimals it forces the whole column to STRING (the same treatment as the pure-integer overflow rule).

### 3. Representation of null (missing values)

- **Typed columns (integer, float, boolean)**: write empty cells as actual `null` (`repetition_type: OPTIONAL`). This enables Parquet's `null_count` statistics, usable later for a "missing count" display or statistics-based skipping.
- **STRING columns**: keep the empty string `''` as today (to limit the scope of change).
- Refining the required/optional (REQUIRED/OPTIONAL) semantics is out of scope for this ADR (separate). Typed columns are uniformly OPTIONAL.

### 4. Value Conversion (at write time)

Specify the inferred type in `columnData[].type` and convert each cell as follows (empty cells become `null` in typed columns):

| Type    | Conversion                                                      |
| ------- | --------------------------------------------------------------- |
| Integer | `cell === '' ? null : BigInt(cell)`                             |
| Float   | `cell === '' ? null : Number(cell)`                             |
| Boolean | `'true'→true` / `'false'→false` (case-insensitive), `'' → null` |
| String  | `row[colIndex] ?? ''` (unchanged)                               |

`hyparquet-writer` requires `INT64=bigint` / `DOUBLE=number` / `BOOLEAN=boolean`, and type mismatches raise runtime errors, so inference and conversion must correspond exactly.

### 5. Inference Scope and Cost

- **Full-row scan** (no sampling). The data is already in memory (within `MAX_PARQUET_SOURCE_SIZE` = 50MB), and we prioritize avoiding misinference caused by anomalous trailing values.
- The complexity is one additional O(rows × columns) pass, negligible compared to network I/O or parsing itself.

### 6. Frontend Impact

- **Field list (`ResourceFields`)**: since `mapFieldType()` determines the type from the logical/physical type, emitting typed Parquet **automatically displays** "integer", "float", "boolean" (no frontend change needed).
- **hyparquet preview (`ParquetPreview`)**: typed columns are read as numbers/booleans, but cell rendering uses `String(value)`, so display is preserved (`bigint`/`number`/`boolean` can all be stringified).
- **DuckDB explorer**: works without breaking even with the current `CAST(col AS VARCHAR)` approach. However, **correct numeric sorting requires type-aware SQL that drops CAST for typed columns** (to be handled in ADR-016 phase 3). Within this ADR's scope, the direct outcomes are type display and Parquet statistics.

### 7. Backward Compatibility and Regeneration

- Existing Parquet previews remain all-STRING. The new logic applies **only on new uploads and reprocessing**.
- No bulk regeneration. Resources are gradually updated to typed via reprocessing (`reprocess`).

## Consequences

- Add type inference and value conversion logic to `apps/worker/src/pipeline/steps/extract.ts`. Factor out the inference function as a pure function (`inferColumnType(values): FieldType`) so it is unit-testable.
- ADR-014's "column type: all STRING" is extended by this ADR for CSV/TSV (numbers and booleans are typed).
- Realizes ADR-016 phase 2 and sets up the prerequisites for phase 3 (range filters, type-aware SQL).
- Configuration values (e.g., the accepted boolean literals) may be placed as constants in `apps/worker/src/config.ts`.
- Testing: unit tests for the inference pure function (integer, float, boolean, leading zero, overflow, mixed, empty column, mixed nulls) are required.

## Open Issues

Items not addressed by this ADR, left to future consideration/implementation.

1. **TIMESTAMP support for dates/datetimes**: to be a separate ADR after deciding how to resolve format ambiguity (separators, Japanese era, presence of time, `MM/DD` vs `DD/MM`). Design notes (investigated):
   - **Types**: date-only → `INT32` + logical type `DATE` (timezone-free and safe; no wall-clock problem). Datetime → `INT64` + **naive TIMESTAMP** (`isAdjustedToUTC: false`). The frontend `mapFieldType()` already maps `DATE` → date and `TIMESTAMP_MILLIS/MICROS` → datetime (no display change needed).
   - **Timezone-less datetimes are supported**: `logical_type: { type: 'TIMESTAMP', unit: 'MILLIS', isAdjustedToUTC: false }`. DuckDB reads it as `TIMESTAMP` (without time zone), which is appropriate for CSV datetimes that carry no timezone.
   - **hyparquet-writer constraint**: value conversion (`unconvert`) branches on `converted_type`, so without also setting `converted_type: 'TIMESTAMP_MILLIS'` the `Date → bigint` conversion never runs. Therefore set both `converted_type: 'TIMESTAMP_MILLIS'` and `logical_type(isAdjustedToUTC: false)` (dates use `INT32` + `converted_type: 'DATE'`).
   - **Schema specification**: `parquetWriteBuffer` does not accept `schemaOverrides` directly. Build the full schema via `schemaFromColumnData({ columnData, schemaOverrides })` and pass it as `schema`, removing `type` from `columnData` (providing both `schema` and `columnData[].type` throws).
   - **Encoding pitfall**: `unconvert` uses `Date.getTime()` (UTC epoch millis), so passing a `Date` built in the local timezone shifts the value by the server's timezone offset. Convert the **wall-clock components to UTC-based millis** (build via `Date.UTC(...)` or pass a precomputed number/bigint directly) to eliminate the server timezone's influence.
2. **Type-aware SQL in the DuckDB explorer**: drop `CAST(... AS VARCHAR)` for typed columns so numeric sorting and range filters (`BETWEEN`) work correctly (ADR-016 phase 3). With this ADR alone, numeric sorting remains lexicographic.
3. **Refining REQUIRED/OPTIONAL (required/optional)**: since typed columns are uniformly OPTIONAL, the field list's "Nullable" is always "Yes". Determine REQUIRED from the presence of empty cells to make it meaningful.
4. **Real-null for STRING columns and `null_count` statistics**: STRING columns keep empty strings, so a missing count cannot be shown. Consider after verifying the impact of making all columns real-null (preview, search).
5. **Bulk backfill of existing Parquet**: existing previews remain all-STRING until reprocessed. Decide whether a bulk regeneration batch is needed.
6. **Statistics display in the field list**: show `null_count`, min/max, etc. in the field list (assuming the writer emits statistics).
7. **Extending boolean literals**: currently only `true`/`false`. Whether to accept `0`/`1`, `yes`/`no`, `はい`/`いいえ`, etc. via configuration.
8. **Extending the float pattern and exact DECIMAL**: handling of scientific notation (`1e5`), thousands separators (`1,000`), and integer-only DOUBLE columns.
   - **DOUBLE precision**: latitude/longitude (needs ~9–11 digits) is well within double's ~15–16 significant digits and is accurate; display is faithful thanks to `Number.toString()`'s shortest round-trip representation (e.g., `0.1` prints as `0.1`). Error only surfaces during arithmetic such as DuckDB aggregation (SUM/AVG). So coordinates are fine as DOUBLE, and DOUBLE is kept for now.
   - **The "round-trip guard" idea is rejected**: the proposal to "demote any decimal column where `String(Number(v)) !== v` to STRING" would demote trailing-zero coordinates (`35.680000` → `35.68`) en masse, losing sorting/statistics — so it is not adopted.
   - **If exact base-10 becomes a requirement, use DECIMAL**: adopt Parquet's `DECIMAL(precision, scale)` (a scaled integer stored physically as INT32/INT64/FIXED_LEN_BYTE_ARRAY) per column. Design:
     - Full-scan the column: `scale` = max number of fractional digits (counted from the **text**, since `Number` loses trailing zeros); `precision` = max integer-part digits + `scale`.
     - Choose the physical type by precision (≤9 INT32 / ≤18 INT64 / >18 FIXED_LEN_BYTE_ARRAY). Specify `{ type, converted_type: 'DECIMAL', scale, precision }` via `schemaOverrides` (the basic `type` has no DECIMAL).
     - **hyparquet-specific constraint**: the writer's DECIMAL path goes through a JS `number` (`Math.round(v × 10^scale)`). It is exact only when the scaled integer fits `Number.MAX_SAFE_INTEGER` (2^53) — roughly **precision ≲ 15**. Columns exceeding this cannot be written exactly by hyparquet, so fall back to STRING.
     - Real-world data such as money (2 digits) and coordinates (6–8 digits) is mostly under precision 15; within this range DECIMAL is exact (exact base-10 on disk, and DuckDB reads it as a native, exact DECIMAL).
9. **Manual type specification (schema editing UI)**: a mechanism for users to override auto-inference mistakes (option C, a future add-on).

## Related ADRs

- ADR-014: Parquet preview format (this ADR extends the "column type")
- ADR-016: DuckDB-WASM data explorer (this ADR concretizes phase 2)
- ADR-021: Resource content full-text search (the Index step is unaffected by this change)
