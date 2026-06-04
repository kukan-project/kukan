> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/016-duckdb-wasm-data-explorer.md`](../jp/016-duckdb-wasm-data-explorer.md).

# ADR-016: DuckDB-WASM Data Explorer

## Status

**Accepted**

## Context

ADR-014 adopted the Parquet format for preview data, with `hyparquet` for browser-side reading. Current limitations:

1. **In-page operations only**: Filtering and sorting only work within the currently loaded 100 rows
2. **Full-data operations not possible**: Full-row sorting, conditional filtering, and aggregation require loading all data into memory
3. **All columns STRING**: Numeric sorting does not work correctly (`"9" > "80"`)
4. **Row Group statistics cannot be leveraged**: Since all types are STRING, min/max statistics for Row Group skipping are meaningless

The goal is to achieve data browsing, filtering, sorting, and aggregation features similar to CKAN's data explorer.

## Options Considered

### A) Keep hyparquet + Client-side Filtering

- Pros: No additional dependencies, lightweight
- Cons:
  - Full-data operations require loading all rows (tens of thousands of rows for a 10MB CSV)
  - No flexible querying like SQL
  - Aggregation features must be implemented from scratch

### B) Server-side API for Filtering and Sorting

- Pros: Low client load
- Cons:
  - Additional API endpoints required
  - Increased server load
  - Higher latency compared to client-side processing

### C) DuckDB-WASM — Adopted

- Pros:
  - **SQL queries**: `SELECT`, `WHERE`, `ORDER BY`, `GROUP BY`, `LIMIT/OFFSET` all available
  - **Typed Parquet utilization**: Row Group skipping via numeric/date type statistics (after type inference is added)
  - **Aggregation features**: SUM, AVG, COUNT, MIN, MAX natively supported
  - **Industry standard**: Widely adopted in the data analysis ecosystem
- Cons:
  - WASM binary ~35MB (EH bundle, initial load; 0 after browser cache)
  - Higher memory usage than hyparquet

## Decision

**Adopt DuckDB-WASM as the query engine for the data explorer.**

Type inference (all columns STRING → typed Parquet) will be added in a subsequent phase. For now, all columns are compared using `CAST(col AS VARCHAR)`, ensuring all features work even with STRING types.

### 1. DuckDB-WASM Integration

```
Browser:
  DuckDB-WASM (internal Web Worker)
    ↓ SQL query
  registerFileBuffer (in-memory)
    ↑ fetch + ArrayBuffer
  /api/v1/resources/:id/preview (same-origin proxy)
    ↓
  S3 / MinIO
```

- DuckDB-WASM instance is managed as a singleton (once loaded, no re-download on in-page navigation)
- `httpfs` extension is not used; files are registered via `fetch` + `registerFileBuffer` (avoids additional WASM loading for httpfs, no CORS issues with same-origin API)
- Lazy loading: WASM is loaded only when "analysis mode" is turned ON (`next/dynamic` + `ssr: false`)
- WASM + Worker files are placed in `public/duckdb/` (copied from `node_modules` by `scripts/copy-duckdb-wasm.mjs`)

### 2. UI Design: Analysis Mode

A Switch toggle "Analysis Mode" within the table view switches between hyparquet and DuckDB-WASM:

- **OFF (default)**: Lightweight table display via hyparquet (no WASM loading)
- **ON**: Table with filtering, sorting, and search via DuckDB-WASM

Analysis mode state is managed via `sessionStorage` + `useSyncExternalStore`:

- ON/OFF state persists across resources within the same session
- State stays in sync even when multiple `TablePreview` instances exist simultaneously in the DOM (`ResourceExplorer`'s `visitedIds` pattern)
- Resets to OFF on page reload (`sessionStorage` is per-tab)

### 3. Currently Implemented Features

| Feature              | SQL Translation Example                                          |
| -------------------- | ---------------------------------------------------------------- |
| Column sort          | `ORDER BY col ASC/DESC`                                          |
| Filter (equals)      | `CAST(col AS VARCHAR) = 'value'`                                 |
| Filter (not equals)  | `CAST(col AS VARCHAR) != 'value'`                                |
| Filter (contains)    | `CAST(col AS VARCHAR) ILIKE '%keyword%'`                         |
| Filter (starts with) | `CAST(col AS VARCHAR) ILIKE 'prefix%'`                           |
| Filter (ends with)   | `CAST(col AS VARCHAR) ILIKE '%suffix'`                           |
| Text search          | `CAST(col AS VARCHAR) ILIKE '%keyword%'` (OR) across all columns |
| Pagination           | `LIMIT 100 OFFSET n`                                             |

### 4. Future Phases

| Order | Content                                                                 |
| ----- | ----------------------------------------------------------------------- |
| 1     | DuckDB-WASM integration + basic queries (sorting, filtering, search)    |
| 2     | Type inference during Parquet writing (Extract step, ADR-014 extension) |
| 3     | Range filters (`BETWEEN`, effective after type inference)               |
| 4     | Aggregation and chart display (Phase 7 Data Editor integration)         |

### 5. Type Inference During Parquet Writing (planned for Phase 2)

After CSV parsing in the Extract step, infer the data type of each column:

| Inferred Type  | Condition                                          | Parquet Type              |
| -------------- | -------------------------------------------------- | ------------------------- |
| Integer        | All rows match integer pattern (`/^-?\d+$/`)       | INT64                     |
| Floating point | All rows match numeric pattern (`/^-?\d+\.?\d*$/`) | DOUBLE                    |
| Date           | All rows match date pattern (ISO 8601, etc.)       | STRING (future TIMESTAMP) |
| String         | None of the above                                  | STRING                    |

Notes:

- Empty strings and null values are excluded from type inference
- Numbers with leading zeros (`"01234"`) are treated as strings (postal codes, etc.)
- Columns with mixed types fall back to STRING
- Type inference is **best-effort**. The risk of misidentification is accepted, and original data is always preserved

## Impact

- `@duckdb/duckdb-wasm` dependency added to `apps/web` (lazy-loaded)
- WASM binary (~35MB) is served statically from `public/duckdb/` (included in `.gitignore`)
- When type inference is added: Changes to `@kukan/pipeline` Extract step, ADR-014's "column type: all STRING" is updated, Parquet regeneration required

## Related ADRs

- ADR-014: Parquet Format for Preview Data (column types extended when type inference is added)
- ADR-007: Data Editor Addon (Phase 7 integration with aggregation and chart features)
