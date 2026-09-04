import type { Metadata } from 'next'
import { getLocale, getTranslations } from 'next-intl/server'
import { resolveBrandConfig } from '@/lib/resolved-brand'
import type { Entity } from '@/lib/catalog-api'

const TITLE_SEPARATOR = ' | '
const MAX_DESCRIPTION_LENGTH = 200

/** Half of a surrogate pair left behind by the cut — it would render as U+FFFD. */
const TRAILING_HALF_PAIR = /[\uD800-\uDBFF]$/

/**
 * Title for a segment that also titles the segments below it: the pages get
 * "<page> | <site>", the segment itself `defaultTitle`. Next.js does not chain
 * templates, so every segment that sets a title must re-declare one.
 */
export async function siteTitle(defaultTitle?: string): Promise<Metadata['title']> {
  const brand = resolveBrandConfig(await getLocale())
  return {
    default: defaultTitle ?? brand.siteName,
    template: `%s${TITLE_SEPARATOR}${brand.siteName}`,
  }
}

/** Stack title parts above the site name, e.g. "<resource> | <dataset>". */
export function stackTitle(...parts: string[]): string {
  return parts.join(TITLE_SEPARATOR)
}

/** `generateMetadata` that titles a page from a message key. */
export function titleMetadata(namespace: string, key: string) {
  return async (): Promise<Metadata> => {
    const t = await getTranslations(namespace)
    return { title: t(key) }
  }
}

/** Metadata for an organization or group page. */
export function entityMetadata(entity: Entity | null): Metadata {
  if (!entity) return {}
  return { title: entity.title || entity.name, description: metaDescription(entity.description) }
}

/**
 * Layout for routes whose page is a client component — a client component
 * cannot export `generateMetadata`, so the title lives in the layout.
 */
export function PassThroughLayout({ children }: { children: React.ReactNode }): React.ReactNode {
  return children
}

/** Collapse a free-text field into a single-line meta description of usable length. */
export function metaDescription(text?: string | null): string | undefined {
  const flat = text?.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  if (flat.length <= MAX_DESCRIPTION_LENGTH) return flat
  return `${flat.slice(0, MAX_DESCRIPTION_LENGTH - 1).replace(TRAILING_HALF_PAIR, '')}…`
}
