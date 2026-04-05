import { notFound } from 'next/navigation'
import { serverFetch } from '@/lib/server-api'
import { DatasetDetailLayout } from '@/components/dataset-detail-layout'

interface Props {
  params: Promise<{ nameOrId: string }>
}

export default async function DatasetDetailPage({ params }: Props) {
  const { nameOrId } = await params

  const res = await serverFetch(`/api/v1/packages/${encodeURIComponent(nameOrId)}`).catch(
    () => null
  )
  if (!res?.ok) notFound()

  const pkg = await res.json()

  return <DatasetDetailLayout pkg={pkg} />
}
