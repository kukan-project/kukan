> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/017-server-proxied-download.md`](../jp/017-server-proxied-download.md).

# ADR-017: Server-Proxied Download URL (Permalink)

## Status

**Accepted**

## Context

Currently, resource downloads use a two-step process: obtain a Signed URL (S3 presigned URL) via `GET /api/v1/resources/:id/download-url`, then the client accesses that URL.

### Current Issues

1. **No permalink**: Signed URLs have an expiration, making them unusable for sharing, bookmarks, or links from external sites
2. **CKAN incompatibility**: CKAN has a stable URL pattern: `/dataset/{name}/resource/{id}/download/{filename}`
3. **Two-step access**: Two steps required — fetch URL via API → redirect

## Decision

### 1. Download: Server-Side Streaming

**Establish CKAN-compatible permalink URLs where the server streams as a proxy from Storage.**

#### URL Patterns

| URL                                                             | Purpose                           | Implementation        |
| --------------------------------------------------------------- | --------------------------------- | --------------------- |
| `/dataset/{nameOrId}/resource/{resourceId}/download/{filename}` | Public permalink (CKAN-compatible)| Next.js Route Handler |
| `GET /api/v1/resources/:id/download`                            | API endpoint                      | Hono route            |

Both use the same logic: fetch the file from Storage and stream it to the response.

#### Response Headers

```
Content-Type: {resource.mimetype || application/octet-stream}
Content-Disposition: attachment; filename="{filename}"
Content-Length: {resource.size}  (when known)
Cache-Control: private, max-age=0
```

#### Handling External URL Resources

External URL resources (`urlType !== 'upload'`) are redirected to the original URL without server-side proxying:

```
HTTP 302 Found
Location: {resource.url}
```

#### Authentication

- Resources of public datasets: No authentication required
- Resources of private datasets: Authentication required (401 if unauthenticated)
- External URL resources: Redirect only (access control is on the external site)

#### Streaming Safety

Node.js streaming does not block the event loop:

- `pipe()` / `Readable.toWeb()` supports backpressure
- Data is processed in chunks (~64KB), with the event loop yielding between chunks
- With a 10MB file size limit, dozens of concurrent downloads are handled without issues
- The existing `/text` endpoint already operates with the same pattern

### 2. Preview: Consolidated into Server-Side Proxy

The `preview-url`, initially kept as a Signed URL, was also consolidated into a server proxy `/preview` for the following reasons:

- hyparquet's `asyncBufferFromUrl` sends HEAD requests, which result in CORS errors on presigned URLs signed for GET
- Range header forwarding works without issues on the server side (implemented in the `/preview` endpoint)
- Eliminates the need for presigned URL expiration management, simplifying the architecture

### 3. Deprecated Endpoints

| Endpoint                                 | Status                             |
| ---------------------------------------- | ---------------------------------- |
| `GET /api/v1/resources/:id/download-url` | **Deprecated** → replaced by `download` |
| `GET /api/v1/resources/:id/preview-url`  | **Deprecated** → replaced by `preview`  |

### 4. Current Endpoint Structure

The only endpoint returning a presigned URL is `upload-url` (for PUT uploads). All read endpoints use server-side streaming:

| Endpoint           | Purpose                            | Method                             |
| ------------------ | ---------------------------------- | ---------------------------------- |
| `GET /download`    | File download                      | Server-side / 302 for external URLs|
| `GET /preview`     | Preview delivery (Range-capable)   | Server-side streaming              |
| `GET /text`        | Text preview                       | Server-side (with charset conversion) |
| `POST /upload-url` | Presigned URL for upload           | Signed URL (for PUT)               |

## Frontend Impact

| Component           | Before                                    | After                                       |
| ------------------- | ----------------------------------------- | ------------------------------------------- |
| `DownloadButton`    | `download-url` → `window.open(signedUrl)` | `<a href="/api/v1/resources/:id/download">` |
| `useParquetPreview` | `preview-url` → Signed URL → hyparquet    | `/preview` → hyparquet (server proxy)       |
| `PdfPreview`        | `preview-url` → Signed URL → iframe       | `/preview` as direct iframe src             |
| `ZipPreview`        | `preview-url` → Signed URL → fetch JSON   | Fetch JSON from `/preview`                  |

## Related ADRs

- ADR-015: Unified preview-url Endpoint (superseded by this ADR)
- ADR-016: DuckDB-WASM Data Explorer
