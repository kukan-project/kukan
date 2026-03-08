import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { FormatBadges } from './format-badges'

export interface DatasetCardItem {
  id: string
  name: string
  title?: string | null
  notes?: string | null
  formats?: string
}

export function DatasetCard({ pkg }: { pkg: DatasetCardItem }) {
  return (
    <Link href={`/dataset/${pkg.name}`}>
      <Card className="transition-colors hover:bg-accent/50">
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="text-lg">{pkg.title || pkg.name}</CardTitle>
            <FormatBadges formats={pkg.formats} />
          </div>
        </CardHeader>
        {pkg.notes && (
          <CardContent>
            <p className="line-clamp-2 text-sm text-muted-foreground">{pkg.notes}</p>
          </CardContent>
        )}
      </Card>
    </Link>
  )
}
