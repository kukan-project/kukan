import type { Metadata } from 'next'
import { cache } from 'react'
import { notFound } from 'next/navigation'
import { type BrandPage, pages } from '@/brand/pages'

const loadPage = cache(async (path: string): Promise<BrandPage | null> => {
  // `/constructor` and the like would otherwise find Object.prototype's
  return Object.hasOwn(pages, path) ? pages[path]() : null
})

interface Props {
  params: Promise<{ slug: string[] }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const mod = await loadPage(slug.join('/'))
  return mod?.metadata ?? {}
}

export default async function BrandPage({ params }: Props) {
  const { slug } = await params
  const mod = await loadPage(slug.join('/'))
  if (!mod) notFound()
  const Content = mod.default
  return <Content />
}
