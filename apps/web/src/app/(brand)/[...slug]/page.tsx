import type { Metadata } from 'next'
import { cache } from 'react'
import { notFound } from 'next/navigation'
import { type BrandPage, pages } from '@/brand/pages'

const loadPage = cache(async (path: string): Promise<BrandPage | null> => {
  const loader = pages[path]
  return loader ? loader() : null
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
