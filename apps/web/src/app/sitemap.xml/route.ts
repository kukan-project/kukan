import { sitemapResponse } from '@/lib/sitemap'

// Rendered per request: built statically, it would query the database at build time
export const dynamic = 'force-dynamic'

// A route handler, not the metadata route sitemap.ts: that one returns entries
// and cannot answer 404, which a noindex brand needs
export const GET = () => sitemapResponse('')
