/**
 * KUKAN Passages REST API Routes
 * /api/v1/passages — the parts of documents a query matches (ADR-061 §決定 4)
 */

import { Hono } from 'hono'
import { zValidator, repeatedParam } from '../middleware/validator'
import { z } from 'zod'
import { resolveUserOrgIds, buildVisibilityFilters } from '../auth/permissions'
import { searchPassages } from '../services/search/passage-search'
import { MCP_SECTION_MAX_CHARS, PASSAGE_MAX_K, PASSAGE_QUERY_MAX_CHARS } from '../config'
import type { AppContext } from '../context'

export const passagesRouter = new Hono<{ Variables: AppContext }>()

// GET /api/v1/passages - Passages of documents' text that match a query, best first
passagesRouter.get(
  '/',
  zValidator(
    'query',
    z.object({
      q: z.string().regex(/\S/).max(PASSAGE_QUERY_MAX_CHARS),
      organization: z.string().optional(),
      // Both spellings: `tags[]` is what the other list endpoints document
      tags: repeatedParam,
      'tags[]': repeatedParam,
      k: z.coerce.number().int().min(1).max(PASSAGE_MAX_K).optional(),
      per_resource: z.coerce.number().int().min(1).max(PASSAGE_MAX_K).optional(),
      max_chars: z.coerce.number().int().min(1).max(MCP_SECTION_MAX_CHARS).optional(),
      semantic: z
        .enum(['true', 'false'])
        .default('true')
        .transform((v) => v === 'true'),
    })
  ),
  async (c) => {
    const query = c.req.valid('query')
    const { q, organization, k, per_resource, max_chars, semantic } = query
    const tags = [...(query.tags ?? []), ...(query['tags[]'] ?? [])]
    const db = c.get('db')
    const user = c.get('user')
    const userOrgIds = await resolveUserOrgIds(db, user)
    const result = await searchPassages(c.var, {
      q,
      filters: {
        ...(organization && { organizations: [organization] }),
        ...(tags.length > 0 && { tags }),
        ...buildVisibilityFilters(user, userOrgIds),
      },
      viewer: user,
      k,
      perResource: per_resource,
      maxChars: max_chars,
      semantic,
    })
    return c.json({
      passages: result.passages.map((passage) => {
        const source = result.sources.get(passage.resourceId)!
        return {
          ...passage,
          resourceName: source.name,
          format: source.format,
          packageName: source.packageName,
          packageTitle: source.packageTitle,
          // The version to cite is the one the text is from: a failed Interpret
          // leaves the text of an earlier file behind (as get_document_section says)
          latestVersion: source.latestVersion,
          describesLiveContent: source.text.describesLiveContent,
          sourceVersion: source.text.describesLiveContent
            ? source.latestVersion
            : source.text.sourceVersion,
        }
      }),
      semantic: result.semantic,
      via: result.via,
      truncated: result.truncated,
      more: result.more,
    })
  }
)
