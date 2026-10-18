import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { searchPackages } from '@/lib/catalog-api'
import { tagPath } from '@/lib/paths'
import { EntityDatasets } from '@/components/dataset/entity-datasets'

interface Props {
  params: Promise<{ name: string[] }>
  searchParams: Promise<{ offset?: string; limit?: string }>
}

/**
 * A tag name may hold `/`, and the segments arrive undecoded: `a%2Fb` as one,
 * `a/b` as two if something on the way decoded it. Both read back as `a/b`.
 */
function tagName(segments: string[]): string | null {
  try {
    return segments.map(decodeURIComponent).join('/')
  } catch {
    return null
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const name = tagName((await params).name)
  if (!name) return {}
  const t = await getTranslations('tag')
  return { title: t('heading', { name }) }
}

export default async function TagDatasetsPage({ params, searchParams }: Props) {
  const [{ name: segments }, sp] = await Promise.all([params, searchParams])
  const name = tagName(segments)
  if (!name) notFound()
  const offset = Number(sp.offset) || 0
  const limit = Number(sp.limit) || 20

  // The same search as `/dataset?tags=`, so the two never disagree
  const query = new URLSearchParams({ tags: name, offset: String(offset), limit: String(limit) })
  const [data, t, td] = await Promise.all([
    searchPackages(query),
    getTranslations('tag'),
    getTranslations('dataset'),
  ])
  // A tag lives only while a visible dataset carries it
  if (!data || data.total === 0) notFound()

  return (
    <EntityDatasets
      parent={{ href: '/dataset', label: td('title') }}
      title={t('heading', { name })}
      basePath={tagPath(name)}
      data={data}
    />
  )
}
