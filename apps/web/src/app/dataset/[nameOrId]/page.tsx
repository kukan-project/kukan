import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getPackage } from '@/lib/catalog-api'
import { metaDescription } from '@/lib/page-metadata'
import { DatasetDetailLayout } from '@/components/dataset-detail-layout'

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

  return <DatasetDetailLayout pkg={pkg} />
}
