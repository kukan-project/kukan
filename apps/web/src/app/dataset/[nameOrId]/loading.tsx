import { Separator, Skeleton } from '@kukan/ui'

export default function DatasetDetailLoading() {
  return (
    <div className="mx-auto max-w-[var(--kukan-container-max-width)] px-4 py-8">
      <div className="flex flex-col gap-6">
        {/* Breadcrumb */}
        <Skeleton className="h-4 w-48" />

        {/* Title */}
        <Skeleton className="h-9 w-96" />

        {/* Organization */}
        <Skeleton className="h-4 w-32" />

        {/* Tags */}
        <div className="flex gap-1">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-16 rounded-full" />
          ))}
        </div>

        <Separator />

        {/* Description */}
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>

        <Separator />

        {/* Resources */}
        <Skeleton className="h-7 w-48" />
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>

        <Separator />

        {/* Metadata table */}
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    </div>
  )
}
