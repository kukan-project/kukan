/**
 * The sitemap: an index naming one file per page of each kind, and the
 * files, /sitemap/<kind>/<n>.xml from 0, each listing public pages with when
 * they last changed. Public means what an anonymous viewer sees — active, not
 * private — whoever asks. Each kind is read a page at a time in a fixed order,
 * so pages never overlap.
 */

import { and, asc, eq, inArray, max, not, or, sql } from 'drizzle-orm'
import { group, organization, packageTable, packageTag, resource, tag } from '@kukan/db'
import type { Database } from '@kukan/db'
import {
  datasetPath,
  groupPath,
  organizationPath,
  PATHLESS_TAG_NAMES,
  resourcePath,
  TAG_SEPARATOR_CLASS,
  tagPath,
} from '@kukan/shared'
import { publicPackageSql } from '../auth/permissions'

/** URLs per sitemap file: well under the protocol's 50,000, and a few MB of XML */
const SITEMAP_PAGE_SIZE = 10_000

const SITEMAP_KINDS = ['datasets', 'resources', 'organizations', 'groups', 'tags'] as const
type SitemapKind = (typeof SITEMAP_KINDS)[number]

interface SitemapEntry {
  /** Dataset, organization, group or tag name; for a resource, its dataset's */
  name: string
  /** Resources only */
  resourceId?: string
  lastModified: Date | null
}

/** Tag names tagNameSchema refuses, which saved earlier ones may still hold */
const linkableTag = () =>
  not(or(inArray(tag.name, [...PATHLESS_TAG_NAMES]), sql`${tag.name} ~ ${TAG_SEPARATOR_CLASS}`)!)

export class SitemapService {
  constructor(private db: Database) {}

  /** How many entries each kind has, which decides the files the index lists */
  private async counts(): Promise<Record<SitemapKind, number>> {
    const [datasets, resources, organizations, groups, tags] = await Promise.all([
      this.db.$count(packageTable, publicPackageSql()),
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(resource)
        .innerJoin(packageTable, eq(resource.packageId, packageTable.id))
        .where(and(eq(resource.state, 'active'), publicPackageSql()))
        .then(([r]) => r.n),
      this.db.$count(organization, eq(organization.state, 'active')),
      this.db.$count(group, eq(group.state, 'active')),
      this.db
        .select({ n: sql<number>`count(DISTINCT ${tag.name})::int` })
        .from(tag)
        .innerJoin(packageTag, eq(packageTag.tagId, tag.id))
        .innerJoin(packageTable, eq(packageTag.packageId, packageTable.id))
        .where(and(publicPackageSql(), linkableTag()))
        .then(([r]) => r.n),
    ])
    return { datasets, resources, organizations, groups, tags }
  }

  /** Page `page` (0-based) of one kind */
  private async entries(kind: SitemapKind, page: number): Promise<SitemapEntry[]> {
    const offset = page * SITEMAP_PAGE_SIZE
    const limit = SITEMAP_PAGE_SIZE
    switch (kind) {
      case 'datasets':
        return this.db
          .select({ name: packageTable.name, lastModified: packageTable.updated })
          .from(packageTable)
          .where(publicPackageSql())
          .orderBy(asc(packageTable.id))
          .limit(limit)
          .offset(offset)
      case 'resources':
        return this.db
          .select({
            name: packageTable.name,
            resourceId: resource.id,
            lastModified: resource.updated,
          })
          .from(resource)
          .innerJoin(packageTable, eq(resource.packageId, packageTable.id))
          .where(and(eq(resource.state, 'active'), publicPackageSql()))
          .orderBy(asc(resource.id))
          .limit(limit)
          .offset(offset)
      case 'organizations':
        return this.db
          .select({ name: organization.name, lastModified: organization.updated })
          .from(organization)
          .where(eq(organization.state, 'active'))
          .orderBy(asc(organization.id))
          .limit(limit)
          .offset(offset)
      case 'groups':
        return this.db
          .select({ name: group.name, lastModified: group.updated })
          .from(group)
          .where(eq(group.state, 'active'))
          .orderBy(asc(group.id))
          .limit(limit)
          .offset(offset)
      case 'tags':
        // A tag page changes when a dataset carrying it does
        return this.db
          .select({ name: tag.name, lastModified: max(packageTable.updated) })
          .from(tag)
          .innerJoin(packageTag, eq(packageTag.tagId, tag.id))
          .innerJoin(packageTable, eq(packageTag.packageId, packageTable.id))
          .where(and(publicPackageSql(), linkableTag()))
          .groupBy(tag.name)
          .orderBy(asc(tag.name))
          .limit(limit)
          .offset(offset)
    }
  }

  /** The index: one file per page of each kind that has entries, on `origin` */
  async indexXml(origin: string): Promise<string> {
    const counts = await this.counts()
    return xmlDoc(
      'sitemapindex',
      SITEMAP_KINDS.flatMap((kind) =>
        Array.from(
          { length: Math.ceil(counts[kind] / SITEMAP_PAGE_SIZE) },
          (_, page) =>
            `  <sitemap><loc>${xmlEscape(`${origin}/sitemap/${kind}/${page}.xml`)}</loc></sitemap>`
        )
      )
    )
  }

  /** `<kind>`, `<n>.xml` as one file's urlset, or null for no such file (a 404) */
  async fileXml(origin: string, kind: string, file: string): Promise<string | null> {
    const digits = /^(0|[1-9]\d*)\.xml$/.exec(file)?.[1]
    if (digits === undefined || !(SITEMAP_KINDS as readonly string[]).includes(kind)) return null
    // A page whose OFFSET is no safe integer is far past any catalog; asking would
    // hand PostgreSQL "1e+28" for a bigint
    const page = Number(digits)
    if (!Number.isSafeInteger(page * SITEMAP_PAGE_SIZE)) return null
    const entries = await this.entries(kind as SitemapKind, page)
    if (entries.length === 0) return null
    return xmlDoc(
      'urlset',
      entries.map((e) => {
        const lastmod = e.lastModified ? `<lastmod>${e.lastModified.toISOString()}</lastmod>` : ''
        return `  <url><loc>${xmlEscape(origin + PATH[kind as SitemapKind](e))}</loc>${lastmod}</url>`
      })
    )
  }
}

const PATH: Record<SitemapKind, (e: SitemapEntry) => string> = {
  datasets: (e) => datasetPath(e.name),
  resources: (e) => resourcePath(e.name, e.resourceId!),
  organizations: (e) => organizationPath(e.name),
  groups: (e) => groupPath(e.name),
  tags: (e) => tagPath(e.name),
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`)
}

function xmlDoc(root: 'sitemapindex' | 'urlset', items: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${items.join('\n')}
</${root}>
`
}
