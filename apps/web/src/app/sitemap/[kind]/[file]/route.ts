import { sitemapResponse } from '@/lib/sitemap'

// Checked here too, before any path is built: a param must not carry a dot
// segment that would step out of the API's sitemap path
const KIND = /^[a-z]+$/
const FILE = /^(0|[1-9]\d*)\.xml$/

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ kind: string; file: string }> }
) {
  const { kind, file } = await params
  if (!KIND.test(kind) || !FILE.test(file)) return new Response(null, { status: 404 })
  return sitemapResponse(`/${kind}/${file}`)
}
