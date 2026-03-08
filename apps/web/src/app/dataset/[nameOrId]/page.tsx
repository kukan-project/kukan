import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Badge, Button, Card, CardContent, Separator } from '@kukan/ui'
import { serverFetch } from '@/lib/api'
import { getFormatColorClass } from '@/lib/format-colors'
import { renderSimpleMarkdown } from '@/lib/render-markdown'

interface Resource {
  id: string
  name?: string | null
  url?: string | null
  description?: string | null
  format?: string | null
  size?: number | null
  mimetype?: string | null
}

interface Organization {
  id: string
  name: string
  title?: string | null
}

interface Package {
  id: string
  name: string
  title?: string | null
  notes?: string | null
  url?: string | null
  version?: string | null
  licenseId?: string | null
  author?: string | null
  authorEmail?: string | null
  maintainer?: string | null
  maintainerEmail?: string | null
  private: boolean
  metadataCreated: string
  metadataModified: string
  extras?: Record<string, unknown> | null
  resources: Resource[]
  tags: { id: string; name: string }[]
  organization: Organization | null
}

interface Props {
  params: Promise<{ nameOrId: string }>
}

export default async function DatasetDetailPage({ params }: Props) {
  const { nameOrId } = await params

  let res: Response
  try {
    res = await serverFetch(`/api/v1/packages/${encodeURIComponent(nameOrId)}`)
  } catch {
    notFound()
  }

  if (!res.ok) {
    notFound()
  }

  const pkg: Package = await res.json()

  return (
    <div className="mx-auto max-w-[var(--kukan-container-max-width)] px-4 py-8">
      <div className="flex flex-col gap-6">
        <nav className="flex items-center gap-1 text-sm text-muted-foreground">
          <Link href="/dataset" className="hover:text-foreground">
            データセット一覧
          </Link>
          <span>/</span>
          <span className="text-foreground">{pkg.title || pkg.name}</span>
        </nav>

        {/* タイトル */}
        <h1 className="text-3xl font-bold tracking-tight">{pkg.title || pkg.name}</h1>

        {/* 組織名 */}
        {pkg.organization && (
          <p className="text-sm text-muted-foreground">
            {pkg.organization.title || pkg.organization.name}
          </p>
        )}

        {/* タグ */}
        {pkg.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {pkg.tags.map((t) => (
              <Badge key={t.id} variant="secondary">
                {t.name}
              </Badge>
            ))}
          </div>
        )}

        {/* 説明 */}
        {pkg.notes && (
          <>
            <Separator />
            <div className="prose max-w-none text-muted-foreground">
              {renderSimpleMarkdown(pkg.notes)}
            </div>
          </>
        )}

        {/* データとリソース */}
        <Separator />
        <section>
          <h2 className="mb-4 text-xl font-semibold">
            データとリソース{pkg.resources.length > 0 && ` (${pkg.resources.length})`}
          </h2>
          {pkg.resources.length === 0 ? (
            <p className="text-sm text-muted-foreground">リソースはありません</p>
          ) : (
            <div className="flex flex-col gap-3">
              {pkg.resources.map((r) => (
                <ResourceCard key={r.id} resource={r} packageName={pkg.name} />
              ))}
            </div>
          )}
        </section>

        {/* 追加情報 */}
        <Separator />
        <section>
          <h2 className="mb-4 text-xl font-semibold">追加情報</h2>
          <MetadataTable pkg={pkg} />
        </section>
      </div>
    </div>
  )
}

function ResourceCard({ resource, packageName }: { resource: Resource; packageName: string }) {
  return (
    <Card className="py-0">
      <CardContent className="flex items-center gap-4 px-4 py-3">
        <span
          className={`inline-flex min-w-[56px] items-center justify-center rounded px-2 py-1 text-xs font-bold uppercase ${getFormatColorClass(resource.format)}`}
        >
          {resource.format || '?'}
        </span>

        <div className="min-w-0 flex-1">
          <Link
            href={`/dataset/${packageName}/resource/${resource.id}`}
            className="truncate font-medium hover:underline"
          >
            {resource.name || 'Unnamed Resource'}
          </Link>
          {resource.description && (
            <p className="truncate text-sm text-muted-foreground">{resource.description}</p>
          )}
        </div>

        {resource.url && (
          <div className="flex shrink-0 gap-2">
            <Button asChild variant="outline" size="sm">
              <a href={resource.url} target="_blank" rel="noopener noreferrer">
                探索
              </a>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function MetadataTable({ pkg }: { pkg: Package }) {
  const rows = [
    { label: 'メンテナー', value: pkg.maintainer },
    { label: '作成者', value: pkg.author },
    { label: 'ライセンス', value: pkg.licenseId },
    { label: 'バージョン', value: pkg.version },
    { label: '作成日', value: formatDate(pkg.metadataCreated) },
    { label: '最終更新', value: formatDate(pkg.metadataModified) },
    { label: '更新頻度', value: getExtra(pkg.extras, '更新頻度') },
    {
      label: 'ソースURL',
      value: pkg.url ? (
        <a
          href={pkg.url}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-primary underline-offset-4 hover:underline"
        >
          {pkg.url}
        </a>
      ) : null,
    },
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

function formatDate(dateString: string): string | null {
  const date = new Date(dateString)
  if (isNaN(date.getTime())) return null
  return date.toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function getExtra(extras: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!extras) return null
  const value = extras[key]
  return typeof value === 'string' ? value : null
}
