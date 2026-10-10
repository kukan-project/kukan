import { clientFetch } from '@/lib/client-api'

/**
 * Queue a rebuild of the search index (ADR-021), from the search admin page,
 * the reprocess on the resource processing page, or the dashboard notice.
 */
export function requestReindex(content: {
  /** Every resource's pipeline again, the content index emptied first */
  includeContent?: boolean
  /** Every resource's content indexed again from its interpretation */
  reindexContent?: boolean
}): Promise<Response> {
  return clientFetch('/api/v1/admin/reindex-metadata', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(content),
  })
}
