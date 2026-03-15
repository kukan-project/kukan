import { Card, CardContent, Separator, Skeleton } from '@kukan/ui'

export default function HomeLoading() {
  return (
    <div className="mx-auto flex max-w-[var(--kukan-container-max-width)] flex-col items-center gap-8 px-4 py-16">
      <div className="flex flex-col items-center gap-4 text-center">
        <Skeleton className="h-12 w-48" />
        <Skeleton className="h-6 w-80" />
      </div>

      <Skeleton className="h-10 w-full max-w-lg" />

      <div className="grid w-full max-w-lg grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="flex flex-col items-center gap-2 py-6">
              <Skeleton className="h-9 w-16" />
              <Skeleton className="h-4 w-20" />
            </CardContent>
          </Card>
        ))}
      </div>

      <Separator className="w-full max-w-2xl" />

      <div className="flex w-full max-w-2xl flex-col gap-4">
        <Skeleton className="h-7 w-40" />
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-lg" />
        ))}
      </div>
    </div>
  )
}
