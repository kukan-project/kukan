> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/015-unified-preview-url.md`](../jp/015-unified-preview-url.md).

# ADR-015: Unified preview-url Endpoint

## Status

**Superseded** — Consolidated into server-proxied `/preview`.

`preview-url` (which returned presigned URLs) was replaced by `/preview` (server-side streaming) to avoid CORS issues and simplify the architecture. `download-url` was similarly replaced by `/download` in ADR-017.

As a result, the only endpoint that returns a presigned URL is `upload-url` (for uploads).

## Context

KUKAN's resource preview uses different display methods depending on the format:

- **CSV/TSV**: Converted to Parquet by the pipeline, displayed in the browser via hyparquet
- **PDF**: Original file from Storage displayed inline in an iframe
- **TXT**: Raw text fetched from the `/text` endpoint for display

In the initial implementation, CSV/TSV used `preview-url` and PDF used `download-url?inline=true`, requiring different endpoints per format. This increased conditional branching on the frontend and reduced extensibility when adding new formats.

## Decision (original)

`GET /api/v1/resources/:id/preview-url` was established as the unified entry point for preview URL retrieval.

## Reason for Superseding

1. **CORS issue**: hyparquet's `asyncBufferFromUrl` sends a HEAD request, but a presigned URL signed for GET returns a CORS error on HEAD
2. **Architecture simplification**: Eliminates the need for presigned URL expiration management
3. **Centralized authentication**: Server proxy allows unified access control on the server side
4. **Consistency with download-url**: Same rationale as the download-url → download replacement in ADR-017

## Current Preview Architecture

| Endpoint        | Purpose                          | Method                                |
| --------------- | -------------------------------- | ------------------------------------- |
| `GET /preview`  | Preview delivery (Range-capable) | Server-side streaming                 |
| `GET /text`     | Text preview                     | Server-side (with charset conversion) |
| `GET /download` | File download                    | Server-side / 302 for external URLs   |

Frontend component branching:

```
ResourcePreview
  ├── PDF     → PdfPreview      → /preview (iframe src)
  ├── CSV/TSV → TablePreview    → /preview (hyparquet) + /text (raw toggle)
  ├── GeoJSON → GeoJsonPreview  → /text (Leaflet + raw toggle)
  ├── ZIP     → ZipPreview      → /preview (JSON manifest)
  ├── Text    → TextOnlyPreview → /text
  └── Other   → PreviewNotAvailable
```

## Related ADRs

- ADR-014: Adopt Parquet as the Storage Format for Preview Data
- ADR-017: Server-Proxied Download URL (`download-url` → `download` replacement)
