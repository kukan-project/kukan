import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getPackage, getResource } from '@/lib/catalog-api'
import { metaDescription, stackTitle } from '@/lib/page-metadata'
import { DatasetDetailLayout } from '@/components/dataset-detail-layout'

interface Props {
  params: Promise<{ nameOrId: string; resourceId: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { nameOrId, resourceId } = await params
  const [pkg, resource] = await Promise.all([
    getPackage(nameOrId),
    getResource(nameOrId, resourceId),
  ])
  if (!pkg || !resource) return {}

  return {
    title: stackTitle(resource.name || resourceId, pkg.title || pkg.name),
    description: metaDescription(resource.description) ?? metaDescription(pkg.notes),
  }
}

export default async function ResourceDetailPage({ params }: Props) {
  const { nameOrId, resourceId } = await params
  const [pkg, resource] = await Promise.all([
    getPackage(nameOrId),
    getResource(nameOrId, resourceId),
  ])
  if (!pkg || !resource) notFound()

  return <DatasetDetailLayout pkg={pkg} initialResourceId={resourceId} />
}
