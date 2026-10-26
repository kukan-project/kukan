import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import type { BuildInfo } from '@/lib/build-info'

/**
 * What this deployment is running: the release and the Node it runs on.
 *
 * The page reads the values on the server, in this same process (ADR-012 puts
 * the API in it), so there is nothing to fetch and nothing to show while
 * waiting. Displaying props is all this does, so it stays on the server too.
 */
export function SystemInfoCard({ build }: { build: BuildInfo }) {
  const t = useTranslations('dashboard.adminSite')

  const rows: [string, string][] = [
    [t('buildVersion'), build.version],
    [t('buildNode'), build.node.replace(/^v/, '')],
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('buildTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col gap-3">
          {rows.map(([label, value]) => (
            <div key={label} className="flex flex-col gap-1">
              <dt className="text-sm font-medium">{label}</dt>
              <dd className="font-mono text-sm text-muted-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  )
}
