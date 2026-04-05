import { notFound } from 'next/navigation'
import { serverFetch } from '@/lib/server-api'
import { DatasetDetailLayout } from '@/components/dataset-detail-layout'

interface Props {
  params: Promise<{ nameOrId: string; resourceId: string }>
}

export default async function ResourceDetailPage({ params }: Props) {
  const { nameOrId, resourceId } = await params

  const res = await serverFetch(`/api/v1/packages/${encodeURIComponent(nameOrId)}`).catch(
    () => null
  )
  if (!res?.ok) notFound()

  const pkg = await res.json()

  // Verify the resource exists in this package
  if (!pkg.resources?.some((r: { id: string }) => r.id === resourceId)) {
    notFound()
  }

  return <DatasetDetailLayout pkg={pkg} initialResourceId={resourceId} />
}
