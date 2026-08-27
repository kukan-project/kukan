'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'
import type { VersionView } from '@kukan/shared'
import { formatBytes } from '@/lib/format-utils'
import { DateTime } from '@/components/date-time'

/** Rows shown before "show all". Fetch-origin resources accumulate versions
 *  without bound, so the long tail stays behind a click (ADR-043 open issue 13
 *  tracks moving this server-side). */
const INITIAL_ROWS = 10

interface Props {
  resourceId: string
}

/**
 * Viewer-facing version history for the public resource page: list and
 * per-version download only. Diff, purge, and provenance (the origin column —
 * publisher workflow, not a fact about the data) stay in the dashboard —
 * public diffs are Phase iii (spec §15).
 *
 * Rendered collapsed and fetched on first open, so resource views that never
 * look at history cost nothing.
 */
export function VersionHistory({ resourceId }: Props) {
  const t = useTranslations('resource.versions')
  const tc = useTranslations('common')
  const [versions, setVersions] = useState<VersionView[] | null>(null)
  const [error, setError] = useState(false)
  const [showAll, setShowAll] = useState(false)
  // A once-only guard, not view state: "loading" is versions === null.
  const requestedRef = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)

  // "Show all" removes itself, which would drop keyboard focus to the body —
  // put it on the list the click just grew instead.
  useEffect(() => {
    if (showAll) listRef.current?.focus()
  }, [showAll])

  const load = useCallback(async () => {
    setError(false)
    try {
      const res = await clientFetch(`/api/v1/resources/${resourceId}/versions`)
      if (!res.ok) throw new Error(String(res.status))
      const data = (await res.json()) as { versions: VersionView[] }
      setVersions(data.versions)
    } catch {
      setError(true)
    }
  }, [resourceId])

  const onToggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (e.currentTarget.open && !requestedRef.current) {
      requestedRef.current = true
      void load()
    }
  }

  return (
    <details className="group" onToggle={onToggle}>
      <summary className="cursor-pointer text-sm font-medium text-muted-foreground list-none flex items-center gap-2 [&::-webkit-details-marker]:hidden">
        <span className="transition-transform group-open:rotate-90">&#9654;</span>
        {t('title')}
      </summary>
      <div className="mt-4">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription className="flex items-center gap-3">
              {t('loadError')}
              <Button variant="outline" size="sm" onClick={() => void load()}>
                {tc('retry')}
              </Button>
            </AlertDescription>
          </Alert>
        ) : !versions ? (
          <p role="status" className="text-sm text-muted-foreground">
            {tc('loading')}
          </p>
        ) : versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <div
            ref={listRef}
            tabIndex={-1}
            // The ring only shows for keyboard-driven focus (focus-visible),
            // which is exactly who the programmatic focus is for.
            className="flex flex-col items-start gap-2 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-32">{t('version')}</TableHead>
                  <TableHead>{t('created')}</TableHead>
                  <TableHead>{t('size')}</TableHead>
                  <TableHead className="w-[120px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(showAll ? versions : versions.slice(0, INITIAL_ROWS)).map((v) => {
                  const purged = v.state === 'purged'
                  const purging = v.state === 'purging'
                  return (
                    <TableRow key={v.version}>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          v{v.version}
                          {v.isLive && <Badge variant="secondary">{t('live')}</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <DateTime value={v.created} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {purged ? '—' : (formatBytes(v.size) ?? '—')}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end">
                          {purged ? (
                            <Badge variant="secondary">{t('purged')}</Badge>
                          ) : purging ? (
                            <Badge variant="secondary">{t('purging')}</Badge>
                          ) : (
                            <Button variant="ghost" size="sm" asChild>
                              <a
                                href={`/api/v1/resources/${resourceId}/versions/${v.version}/download`}
                              >
                                {t('download')}
                              </a>
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
            {!showAll && versions.length > INITIAL_ROWS && (
              <Button variant="outline" size="sm" onClick={() => setShowAll(true)}>
                {t('showAll', { count: versions.length })}
              </Button>
            )}
          </div>
        )}
      </div>
    </details>
  )
}
