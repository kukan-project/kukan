import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Card, CardContent, Separator } from '@kukan/ui'
import { serverFetch } from '@/lib/server-api'
import { getFormatColorClass } from '@/lib/format-colors'
import { renderSimpleMarkdown } from '@/lib/render-markdown'

interface Resource {
  id: string
  packageId: string
  name?: string | null
  url?: string | null
  description?: string | null
  format?: string | null
  size?: number | null
  mimetype?: string | null
  hash?: string | null
  resourceType?: string | null
  created: string
  updated: string
  lastModified?: string | null
}

interface Package {
  id: string
  name: string
  title?: string | null
  licenseId?: string | null
}

interface Props {
  params: Promise<{ nameOrId: string; resourceId: string }>
}

export default async function ResourceDetailPage({ params }: Props) {
  const { nameOrId, resourceId } = await params

  // Fetch resource and package in parallel
  const [resRes, pkgRes] = await Promise.all([
    serverFetch(`/api/v1/resources/${encodeURIComponent(resourceId)}`).catch(() => null),
    serverFetch(`/api/v1/packages/${encodeURIComponent(nameOrId)}`).catch(() => null),
  ])

  if (!resRes?.ok) notFound()

  const resource: Resource = await resRes.json()
  const pkg: Package | null = pkgRes?.ok ? await pkgRes.json() : null

  return (
    <div className="mx-auto max-w-[var(--kukan-container-max-width)] px-4 py-8">
      <div className="flex flex-col gap-6">
        {/* パンくず */}
        <nav className="flex items-center gap-1 text-sm text-muted-foreground">
          <Link href="/dataset" className="hover:text-foreground">
            データセット一覧
          </Link>
          <span>/</span>
          <Link href={`/dataset/${nameOrId}`} className="hover:text-foreground">
            {pkg?.title || pkg?.name || nameOrId}
          </Link>
          <span>/</span>
          <span className="text-foreground">{resource.name || 'リソース'}</span>
        </nav>

        {/* タイトル + フォーマットバッジ */}
        <div className="flex items-start gap-3">
          <span
            className={`mt-1 inline-flex min-w-[56px] items-center justify-center rounded px-2 py-1 text-xs font-bold uppercase ${getFormatColorClass(resource.format)}`}
          >
            {resource.format || '?'}
          </span>
          <h1 className="text-3xl font-bold tracking-tight">
            {resource.name || 'Unnamed Resource'}
          </h1>
        </div>

        {/* URL */}
        {resource.url && (
          <div>
            <a
              href={resource.url}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-sm text-primary underline-offset-4 hover:underline"
            >
              {resource.url}
            </a>
          </div>
        )}

        {/* 説明 */}
        {resource.description && (
          <>
            <Separator />
            <div className="prose max-w-none text-muted-foreground">
              {renderSimpleMarkdown(resource.description)}
            </div>
          </>
        )}

        {/* プレビュー（後のフェーズ） */}
        <Separator />
        <section>
          <h2 className="mb-4 text-xl font-semibold">プレビュー</h2>
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              データプレビューは今後のフェーズで対応予定です
            </CardContent>
          </Card>
        </section>

        {/* 追加情報 */}
        <Separator />
        <section>
          <h2 className="mb-4 text-xl font-semibold">追加情報</h2>
          <ResourceMetadataTable resource={resource} licenseId={pkg?.licenseId} />
        </section>
      </div>
    </div>
  )
}

function ResourceMetadataTable({
  resource,
  licenseId,
}: {
  resource: Resource
  licenseId?: string | null
}) {
  const rows = [
    { label: '最終更新日', value: formatDate(resource.lastModified || resource.updated) },
    { label: 'メタデータ最終更新日時', value: formatDate(resource.updated) },
    { label: '作成日', value: formatDate(resource.created) },
    { label: 'データ形式', value: resource.format?.toUpperCase() },
    { label: 'MIMEタイプ', value: resource.mimetype },
    { label: 'サイズ', value: formatBytes(resource.size) },
    { label: 'リソースタイプ', value: resource.resourceType },
    { label: 'ハッシュ', value: resource.hash },
    { label: 'ライセンス', value: licenseId },
  ].filter((row) => row.value)

  if (rows.length === 0) return null

  return (
    <div className="overflow-hidden rounded-lg border">
      <table className="w-full">
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.label} className={i % 2 === 0 ? 'bg-muted/50' : ''}>
              <th className="w-1/3 px-4 py-3 text-left text-sm font-medium">{row.label}</th>
              <td className="px-4 py-3 text-sm">{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function formatDate(dateString: string | null | undefined): string | null {
  if (!dateString) return null
  const date = new Date(dateString)
  if (isNaN(date.getTime())) return null
  return date.toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes == null || bytes < 0) return null
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
