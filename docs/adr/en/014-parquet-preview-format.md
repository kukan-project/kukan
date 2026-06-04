> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/014-parquet-preview-format.md`](../jp/014-parquet-preview-format.md).

# ADR-014: Adopt Parquet as the Storage Format for Preview Data

## Status

**Accepted**

## Context

KUKAN's pipeline parses resources (CSV/TSV) and stores preview data in Storage. The frontend retrieves this data to display it as tables.

The initial implementation stored only the first 200 rows in JSON format, which has the following issues:

1. **No pagination**: JSON requires fetching all data at once, which is inefficient for large row counts
2. **Size with full-row storage**: JSON has poor storage efficiency for tabular data (repeated key names, string escaping, etc.)
3. **Duplicate raw data management**: Including "raw text before parsing" in the preview JSON creates duplicate management with the original file

## Options Considered

### A) JSON (first N rows only)

- Pros: Simplest implementation. Just `JSON.parse()` on the frontend
- Cons:
  - Only the first 200 rows can be viewed (no pagination)
  - File size bloats when storing all rows (can become larger than the CSV)
  - No random access by row

### B) gzip-compressed JSON

- Pros: Size reduction. Can be handled transparently via S3's Content-Encoding
- Cons: Does not solve the pagination problem. Full decompression required

### C) Parquet — Adopted

- Pros:
  - **Pagination via HTTP Range requests**: Byte-range fetching possible per Row Group
  - **Full-row storage**: Columnar compression efficiently stores even string data from CSV
  - **Embedded schema**: Header information is included in file metadata
  - **Row count metadata**: `num_rows` is included in the footer, allowing total row count without fetching all data
  - **Industry standard**: Widely used in the data analysis ecosystem
- Cons:
  - Additional library dependency
  - Parquet reader required for frontend reading

## Decision

**Use Parquet as the storage format for preview data.**

### Library Selection

| Purpose              | Library            | Rationale                                                                       |
| -------------------- | ------------------ | ------------------------------------------------------------------------------- |
| Server-side writing  | `hyparquet-writer` | Pure JS, 137KB, zero dependencies (hyparquet only), ESM support                 |
| Browser-side reading | `hyparquet`        | Pure JS, 200KB, zero dependencies, Range-based reading via `asyncBufferFromUrl` |

Other libraries considered:

- `parquet-wasm`: WASM bundle 1.2MB (after Brotli compression), no Range Read support
- `@dsnp/parquetjs`: 12 dependencies, 6.9MB, no Range Read support
- `@duckdb/duckdb-wasm`: 144MB, far too large for this purpose

### Design

```
Pipeline (server-side):
  CSV buffer → parseBuffer() → ExtractedData → parquetWriteBuffer() → Storage upload
                                                  ↓
                                  previews/{packageId}/{resourceId}.parquet

Frontend (browser-side):
  Storage URL → asyncBufferFromUrl() → parquetMetadataAsync() → get num_rows
                                      → parquetReadObjects({ rowStart, rowEnd }) → table display
```

### Parquet Write Settings

- **Compression**: `SNAPPY` (hyparquet-writer default)
  - Reduces storage size with pure JS Snappy compression
  - hyparquet supports Snappy decompression on the browser side, usable in combination with Range Read
- **Row Group size**: 5,000 rows
  - Fine-grained enough relative to UI page size (50-100 rows)
  - ~10 Row Groups for a 10MB CSV (~50,000 rows)
- **Column type**: All columns `STRING` (string data as-is from CSV)

### Raw Data Display

Raw data (before parsing) is not included in the preview Parquet file. Since the original file is stored at `resources/{packageId}/{resourceId}`, the frontend downloads and displays it directly from there.

### Storage Key Structure

| Data           | Key                                         |
| -------------- | ------------------------------------------- |
| Original file  | `resources/{packageId}/{resourceId}`        |
| Parsed preview | `previews/{packageId}/{resourceId}.parquet` |

### Types and Concepts No Longer Needed

- `StoredPreviewData` type (JSON structure definition) → Removed
- `rawText` / `raw_text` (raw text) → Removed (fetched directly from the original file)
- `MAX_PREVIEW_ROWS` (200-row limit) → Removed (all rows stored, pagination via Range Read)

## Impact

- `hyparquet-writer` dependency added to `@kukan/pipeline`
- `hyparquet` dependency added to `apps/web` (during Phase 3 Step 6 frontend implementation)
- Extract step generates Parquet instead of JSON
- Frontend preview component updated for Parquet reading (Phase 3 Step 6)
- Storage adapter requires no changes (binary file upload/download works with existing API)

## Related ADRs

- ADR-005: Four Adapters Only (StorageAdapter)
