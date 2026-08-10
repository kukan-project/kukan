'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'
import type { NoTableReason } from '@kukan/shared'
import { formatBytes } from '@/lib/format-utils'
import { useUser } from '@/components/dashboard/user-provider'
import { VersionDiffPanel } from './version-diff-panel'

interface VersionView {
  version: number
  origin: 'upload' | 'fetch'
  state: 'active' | 'purging' | 'purged' | 'superseded'
  size: number | null
  /** Content hash, withheld for a tombstone — which no longer holds content. */
  hash: string | null
  /** Why this version produced no table, when it produced none (ADR-046). */
  noTableReason: NoTableReason | null
  created: string
  purgedAt: string | null
  purgeReason: string | null
}

interface Props {
  resourceId: string
  /** Any change reloads the table in place. The owner passes whatever tells it
   *  the resource gained a version — a replaced file's run finishing — which a
   *  remount would also do, at the cost of closing an open diff. */
  reloadKey?: number
}

export function ResourceVersionHistory({ resourceId, reloadKey }: Props) {
  const t = useTranslations('resource.versions')
  const { sysadmin } = useUser()
  const [versions, setVersions] = useState<VersionView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [purgeTarget, setPurgeTarget] = useState<number | null>(null)
  const [reason, setReason] = useState('')
  const [purging, setPurging] = useState(false)
  const [openDiff, setOpenDiff] = useState<number | null>(null)

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError(null)
      try {
        const res = await clientFetch(`/api/v1/resources/${resourceId}/versions`, { signal })
        if (!res.ok) throw new Error(String(res.status))
        const data = await res.json()
        if (!signal?.aborted) setVersions(data.versions)
      } catch {
        if (!signal?.aborted) setError(t('loadError'))
      }
    },
    [resourceId, t]
  )

  // A reload supersedes the one before it, so the older request is cancelled
  // rather than left to land last and put the table back a version.
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load, reloadKey])

  async function handlePurge() {
    if (purgeTarget === null) return
    setPurging(true)
    setError(null)
    try {
      const res = await clientFetch(
        `/api/v1/resources/${resourceId}/versions/${purgeTarget}/purge`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: reason.trim() }),
        }
      )
      if (!res.ok) throw new Error(String(res.status))
      setPurgeTarget(null)
      setReason('')
      await load()
    } catch {
      setError(t('purgeError'))
    } finally {
      setPurging(false)
    }
  }

  if (!versions || versions.length === 0) return null

  // Purging the only remaining version leaves the resource with no file at all,
  // so the dialog warns about that instead of promising a rollback.
  const isLastActiveVersion = versions.filter((v) => v.state === 'active').length === 1

  // Versions that will still be holding these bytes afterwards. Each version
  // owns its own copy, so purging one leaves theirs served (ADR-046 §3) — the
  // dialog names them rather than widening the purge.
  //
  // Only the ones that survive: a tombstone has no hash to match, and one
  // already claimed for purging is being destroyed too, so naming it would
  // promise a survivor and send the operator after a second purge the resource
  // refuses while the first is in flight.
  //
  // Answered from the table rather than the server, which is what makes it
  // free — and what it rests on: the list carries every version of the
  // resource. Paginate it and this reads one page and reports the rest as
  // nothing, so the decision moves server-side with it (ADR-043 open issue 13).
  const targetHash = versions.find((v) => v.version === purgeTarget)?.hash
  const sameContent = targetHash
    ? versions
        .filter(
          (v) =>
            v.version !== purgeTarget &&
            v.hash === targetHash &&
            (v.state === 'active' || v.state === 'superseded')
        )
        .map((v) => v.version)
    : []

  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-medium">{t('title')}</h4>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">{t('version')}</TableHead>
            <TableHead>{t('created')}</TableHead>
            <TableHead>{t('size')}</TableHead>
            <TableHead>{t('origin')}</TableHead>
            <TableHead className="w-[160px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {versions.map((v, i) => {
            const purged = v.state === 'purged'
            const purging = v.state === 'purging'
            // Versions are newest-first, so the last row is the oldest and has
            // nothing to diff against.
            const hasPrevious = i < versions.length - 1
            const diffOpen = openDiff === v.version
            return (
              <Fragment key={v.version}>
                <TableRow>
                  <TableCell>v{v.version}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(v.created).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {purged ? '—' : (formatBytes(v.size) ?? '—')}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Badge variant="outline">
                        {v.origin === 'upload' ? t('originUpload') : t('originFetch')}
                      </Badge>
                      {/* Why there is no preview, where the absence is noticed.
                          The empty schema behind it says only that the version
                          was interpreted (ADR-046). */}
                      {!purged && v.noTableReason && (
                        <span className="text-xs text-muted-foreground">
                          {t(`noTable.${v.noTableReason}`)}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {/* Superseded still has its content, so it keeps the
                          diff, download and purge actions — the badge only says
                          it is not what the resource serves. */}
                      {v.state === 'superseded' && (
                        <Badge variant="secondary">{t('superseded')}</Badge>
                      )}
                      {purged ? (
                        <Badge variant="secondary">{t('purged')}</Badge>
                      ) : purging ? (
                        <Badge variant="secondary">{t('purging')}</Badge>
                      ) : (
                        <>
                          {hasPrevious && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setOpenDiff(diffOpen ? null : v.version)}
                            >
                              {diffOpen ? t('diffHide') : t('diff')}
                            </Button>
                          )}
                          <Button variant="ghost" size="sm" asChild>
                            <a
                              href={`/api/v1/resources/${resourceId}/versions/${v.version}/download`}
                            >
                              {t('download')}
                            </a>
                          </Button>
                          {sysadmin && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive"
                              onClick={() => {
                                setPurgeTarget(v.version)
                                setReason('')
                              }}
                            >
                              {t('purge')}
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
                {diffOpen && (
                  <TableRow>
                    <TableCell colSpan={5} className="bg-muted/30">
                      <VersionDiffPanel resourceId={resourceId} version={v.version} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            )
          })}
        </TableBody>
      </Table>

      <Dialog open={purgeTarget !== null} onOpenChange={(o) => !o && setPurgeTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('purgeTitle', { version: purgeTarget ?? 0 })}</DialogTitle>
            <DialogDescription>
              {isLastActiveVersion ? t('purgeWarningLastVersion') : t('purgeWarning')}
            </DialogDescription>
          </DialogHeader>
          {sameContent.length > 0 && (
            <Alert variant="warning">
              <AlertDescription>
                {t('purgeWarningSameContent', {
                  versions: sameContent.map((v) => `v${v}`).join(', '),
                })}
              </AlertDescription>
            </Alert>
          )}
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('reasonPlaceholder')}
            rows={3}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPurgeTarget(null)} disabled={purging}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handlePurge}
              disabled={purging || reason.trim().length === 0}
            >
              {purging ? t('purging') : t('purgeConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
