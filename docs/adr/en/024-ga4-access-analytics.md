> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/024-ga4-access-analytics.md`](../jp/024-ga4-access-analytics.md).

# ADR-024: Access Analytics with GA4

## Status

Accepted (2026-05-25)

## Context

When KUKAN is publicly accessible on the internet, there is a requirement to view access statistics such as dataset page views, download counts, and search keywords from the admin dashboard. CKAN had a `tracking_summary` feature for measuring views and downloads, but KUKAN's design documents and schema had no access analytics in scope.

### Issues

1. **No visibility into usage**: Cannot determine which datasets are being utilized or what keywords users are searching for
2. **Cost of self-implementation**: Recording page views and downloads in the DB requires table design, write load handling, and bot exclusion logic — a heavy undertaking
3. **LGWAN compatibility**: Air-gapped networks (LGWAN, etc.) cannot communicate with the internet, so features dependent on external services must be conditionally disabled

### Requirements

- In internet-facing environments, view dataset page views, download counts, and search keywords in a ranking format
- Can be disabled in LGWAN / offline environments without affecting application behavior
- Configuration approach consistent with the existing brand override layer (ADR-023)
- Avoid self-built measurement infrastructure, minimize operational cost

## Decision

**Use Google Analytics 4 (GA4) as the measurement platform: conditionally embed gtag.js on the frontend, and retrieve data via the GA4 Data API for display in the admin dashboard.**

## Rationale

### Alternatives Comparison

| Approach                     | Pros                                        | Cons                                                       | Verdict      |
| ---------------------------- | ------------------------------------------- | ---------------------------------------------------------- | ------------ |
| **GA4 Data API (adopted)**   | No measurement infrastructure needed, rich metrics, free | External dependency, data delay (hours–48h), LGWAN incompatible | **Adopted** |
| Self-built counting (DB)     | LGWAN compatible, real-time                 | Requires table design, write load handling, bot exclusion  | Deferred     |
| Matomo self-hosted           | LGWAN compatible, GA4-equivalent features   | Additional Docker service, increased operational cost      | Deferred     |
| Via GTM                      | Tag management flexibility                  | Unnecessary complexity for a data catalog, additional JS load | Deferred  |

**Reasons for choosing GA4:**

1. **Internet-facing only**: GA4 cannot be used on LGWAN air-gapped networks, but the demand for access analytics itself is limited to internet-facing environments
2. **No measurement infrastructure needed**: Simply embedding gtag.js starts automatic measurement of page views, file downloads, and site search
3. **Automatic download capture**: GA4 Enhanced Measurement detects link clicks by file extension; in KUKAN, the `DownloadButton` component also sends custom events
4. **Automatic search keyword measurement**: Since the search form navigates via `GET /dataset?q=...`, GA4 Enhanced Measurement's "site search" automatically detects the `q` URL parameter
5. **GTM not adopted**: A data catalog does not need to dynamically swap ad tags or heatmaps, and since the deployer is typically the admin, non-engineer tag management is unnecessary. Performance and control simplicity are prioritized with direct gtag.js embedding

### 2-Phase Structure

This feature consists of 2 independent subtasks.

#### 4a: Conditional gtag.js Embedding (Frontend Measurement)

**Control via `brandConfig`:**

An optional field `gaMeasurementId` is added to the `BrandConfig` type. This naturally integrates with ADR-023's brand override layer, using no environment variables. The fork side writes the Measurement ID directly in `brand-config.ts`.

```typescript
export interface BrandConfig {
  // ...existing fields
  gaMeasurementId?: string | null
}
```

Main default (GA4 disabled):

```typescript
export const brandConfig: BrandConfig = {
  // ...existing settings
  gaMeasurementId: null,
}
```

Fork side (GA4 enabled):

```typescript
export const brandConfig: BrandConfig = {
  // ...existing settings
  gaMeasurementId: 'G-XXXXXXXXXX',
}
```

Why no environment variable: The GA4 Measurement ID varies per deployment environment, but `brand-config.ts` itself is a per-fork configuration file, and managing it in `brand-config.ts` is natural following ADR-023's policy (consolidating fork-side changes in `src/brand/`).

**Conditional embedding in layout.tsx:**

Only when `brandConfig.gaMeasurementId` is truthy, gtag.js is loaded via Next.js's `<Script>` component. `strategy="afterInteractive"` ensures page rendering is not blocked.

**Measurement targets:**

| Measurement Item   | Method                       | Implementation                                                                     |
| ------------------ | ---------------------------- | ---------------------------------------------------------------------------------- |
| Page views         | GA4 auto-measurement         | gtag.js loading only                                                               |
| File downloads     | Custom event                 | `gtag('event', 'file_download', {...})` in `DownloadButton`'s `onClick`            |
| Site search        | Enhanced Measurement auto-detection | Automatically measured from URL's `?q=` parameter (no additional code needed) |

**Download event design:**

KUKAN's download URL (`/api/v1/resources/:id/download`) has no file extension, so GA4 Enhanced Measurement's auto-detection does not capture it. The `DownloadButton` component (the single point where all download operations are consolidated) explicitly sends a custom event.

```typescript
gtag('event', 'file_download', {
  file_name: displayFilename,
  link_url: href,
  // KUKAN-specific custom parameters
  dataset_name: datasetNameOrId,
  resource_id: resourceId,
  format: format,
})
```

Using GA4's `file_download` event name ensures data appears in GA4's standard reports.

#### 4b: Admin Dashboard Statistics (GA4 Data API)

**Authentication:**

Authenticate with the GA4 Data API using a GCP service account JSON key.

| Environment Variable     | Purpose                                     | When Unset                       |
| ------------------------ | ------------------------------------------- | -------------------------------- |
| `GA4_PROPERTY_ID`        | GA4 property ID (numeric)                   | Show setup instructions on page  |
| `GA4_CREDENTIALS_JSON`   | Service account JSON key (string)           | Same                             |

**Statistics Items:**

| Ranking                  | GA4 Dimension                                                 | GA4 Metric        | URL Pattern                              |
| ------------------------ | ------------------------------------------------------------- | ----------------- | ---------------------------------------- |
| Dataset views            | `pagePath`                                                    | `screenPageViews` | Filter by `/dataset/{name}`              |
| Resource views           | `pagePath`                                                    | `screenPageViews` | Filter by `/dataset/.../resource/{id}`   |
| Resource downloads       | `customEvent:file_download`'s `dataset_name`, `resource_id`  | `eventCount`      | Aggregated from custom event             |
| Search keywords          | `searchTerm`                                                  | `eventCount`      | Enhanced Measurement auto-collection     |

**Date range:**

- Presets: Last 7 days / 30 days / 90 days / 1 year
- Calendar: Free-form start and end date selection

**Ranking display:**

- Paginated (controlled by GA4 Data API's `offset` / `limit`)

**Data retrieval:**

- Calls the GA4 Data API in real-time, cached with lru-cache (existing infrastructure)
- Cache TTL: 1 hour (given GA4 Data API's data delay, frequent re-fetching is pointless)
- Future migration to batch retrieval + DB storage is possible, but real-time retrieval is sufficient for now

**Behavior when unconfigured:**

- Statistics menu always appears in the admin navigation
- When `GA4_PROPERTY_ID` / `GA4_CREDENTIALS_JSON` are unset, setup instructions are displayed on the page
- No errors in LGWAN environments — only the setup instructions are shown

### Target Users

sysadmin role only. Per-organization filtering for organization admins (admin role) is positioned as a future extension.

### API Access Statistics

Statistics for direct API calls without a browser are not measurable with GA4. This is carved out as a separate task, with server-side measurement (log aggregation or DB counting) to be considered separately.

### GA4 Data API Quotas

| Limit                                   | Value  |
| --------------------------------------- | ------ |
| Daily requests per property             | 25,000 |
| Concurrent requests                     | 10     |

With lru-cache (TTL 1 hour), even if an admin reloads the page repeatedly, API calls max out at 24/day/query pattern. The risk of quota exhaustion is extremely low.

### Frontend/Backend Structure

```
apps/web/src/
  app/
    layout.tsx                         ← Conditional gtag.js embedding (4a)
    dashboard/admin/
      analytics/
        page.tsx                       ← Statistics dashboard (4b)

  components/
    download-button.tsx                ← gtag custom event addition (4a)
    analytics/
      analytics-ranking.tsx            ← Ranking display component (4b)
      analytics-date-range.tsx         ← Date range selection component (4b)

packages/api/src/
  routes/
    admin.ts                           ← GET /admin/analytics/* endpoint addition (4b)
  services/
    analytics-service.ts               ← GA4 Data API call + cache (4b)
```

## Implementation Plan

### Step 1: 4a — Conditional gtag.js Embedding

1. Add `gaMeasurementId?: string | null` to `BrandConfig` type
2. Set `gaMeasurementId: null` as default in `brand-config.ts`
3. Conditionally embed gtag.js via `<Script>` in `layout.tsx`
4. Add custom event sending via `onClick` in `DownloadButton`

### Step 2: 4b — Admin Dashboard Statistics

6. Add `@google-analytics/data` package to `packages/api`
7. Implement GA4 Data API call + lru-cache in `analytics-service.ts`
8. Add `/admin/analytics/*` API endpoints
9. Implement frontend statistics dashboard page (ranking table + date range selection)
10. Implement setup instructions display when unconfigured
11. Add GA4 setup guide to the documentation site

## Consequences

### Advantages

1. **No measurement infrastructure**: Measurement is delegated to GA4; KUKAN is read-only. No DB table additions, write load, or bot exclusion logic needed
2. **Leveraging auto-measurement**: Page views and site search start measuring just by embedding gtag.js. Additional code is only needed for the download event
3. **Staged implementation**: Even 4a (tag embedding) alone allows data to be viewed in the GA4 admin console. 4b can be added later
4. **brandConfig integration**: Naturally integrates with ADR-023's brand override layer; fork-side configuration changes are also consolidated in `brand-config.ts`
5. **LGWAN safe**: No external communication occurs when environment variables are unset

### Disadvantages

1. **External dependency**: Depends on Google's service (alternative needed if GA4 is deprecated)
2. **Data delay**: GA4 data has a delay of hours to up to 48 hours. Real-time statistics are not available
3. **Missing API access statistics**: API calls without a browser cannot be measured (addressed in a separate task)
4. **GA4 setup effort**: The deployer needs to create a GA4 property and configure a service account

### Neutral

1. **Overlap with GA4 admin console**: 4b displays statistics in the admin dashboard, but the same data is also available in the GA4 admin console. The value of 4b is the convenience of "completing everything within KUKAN's admin dashboard"
2. **Custom dimensions**: `dataset_name` and `resource_id` need to be registered as GA4 custom dimensions. The setup guide explains the procedure

## Related ADRs

- ADR-023: Brand override layer (`brandConfig` integration)
- ADR-017: Server-proxied download (prerequisite for download URL structure)
- ADR-019: Logging strategy (role separation with server-side logs)
