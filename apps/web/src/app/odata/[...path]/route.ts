/**
 * OData feed (ADR-055), served by the same Hono app as `/api` (ADR-012).
 *
 * It sits outside `/api` so CloudFront can cache it — `/api/*` is
 * `CACHING_DISABLED` — which is why the path needs a route of its own here.
 */
import { getApp } from '@/lib/hono-app'

export async function GET(req: Request) {
  const app = await getApp()
  return app.fetch(req)
}
