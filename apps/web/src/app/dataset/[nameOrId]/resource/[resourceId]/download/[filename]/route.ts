import { getApp } from '@/lib/hono-app'

/**
 * CKAN-compatible download permalink:
 * /dataset/{nameOrId}/resource/{resourceId}/download/{filename}
 *
 * Delegates to the Hono API download endpoint.
 * nameOrId and filename are for URL compatibility only — resourceId drives the logic.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ resourceId: string }> }
) {
  const { resourceId } = await params
  const app = await getApp()
  const url = new URL(`/api/v1/resources/${encodeURIComponent(resourceId)}/download`, request.url)
  return app.fetch(new Request(url, { headers: request.headers }))
}
