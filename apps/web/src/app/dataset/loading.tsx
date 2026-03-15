import { Separator, Skeleton } from '@kukan/ui'

export default function DatasetListLoading() {
  return (
    <div className="mx-auto max-w-[var(--kukan-container-max-width)] px-4 py-8">
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-16" />
        </div>
        <Skeleton className="h-10 w-full" />
        <Separator />

        <div className="flex flex-col gap-6 md:flex-row">
          {/* Filter sidebar skeleton */}
          <aside className="w-full shrink-0 md:w-56">
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-2">
                <Skeleton className="h-4 w-28" />
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-7 w-full" />
                ))}
              </div>
              <div className="flex flex-col gap-2">
                <Skeleton className="h-4 w-32" />
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-7 w-full" />
                ))}
              </div>
            </div>
          </aside>

          {/* Dataset list skeleton */}
          <div className="min-w-0 flex-1">
            <div className="flex flex-col gap-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-24 w-full rounded-lg" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
