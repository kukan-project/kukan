import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { brandConfig } from '@/brand/brand-config'
import { getPackage } from '@/lib/catalog-api'
import { metaDescription } from '@/lib/page-metadata'
import { DatasetDetailLayout } from '@/components/dataset/dataset-detail-layout'
import { datasetJsonLd, jsonLdScript } from '@/lib/dataset-jsonld'
import { siteOrigin } from '@/lib/site-origin'

interface Props {
  params: Promise<{ nameOrId: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { nameOrId } = await params
  const pkg = await getPackage(nameOrId)
  if (!pkg) return {}

  return { title: pkg.title || pkg.name, description: metaDescription(pkg.notes) }
}

export default async function DatasetDetailPage({ params }: Props) {
  const { nameOrId } = await params

  const pkg = await getPackage(nameOrId)
  if (!pkg) notFound()

  // For crawlers: not on a noindex brand, and not for a dataset only a
  // member can open (the page of a private one is never crawled anyway)
  const jsonLd = !brandConfig.noindex && !pkg.private

  return (
    <>
      {jsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLdScript(datasetJsonLd(pkg, siteOrigin())) }}
        />
      )}
      <DatasetDetailLayout pkg={pkg} />
    </>
  )
}
