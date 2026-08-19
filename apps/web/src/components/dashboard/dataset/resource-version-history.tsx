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
  origin: 'upload' | 'fetch' | 'revert'
  /** The version this one re-published, for `revert` origins (ADR-044 §4).
   *  From the server: repeated content makes it underivable here. */
  restoredFrom: number | null
  /** `superseded` only on rows written before a revert published forward
   *  (ADR-044 §4); they are ordinary versions and render as such. */
  state: 'active' | 'purging' | 'purged' | 'superseded'
  /** Whether the resource is serving this version, and where serving would land
   *  if it were purged. Both from the server: see the dialog below. */
  isLive: boolean
  purgeFallsBackTo: number | null
  size: number | null
  /** Content hash, withheld for a tombstone — which no longer holds content. */
  hash: string | null
  /** Why this version produced no table, when it produced none (ADR-046). */
  noTableReason: NoTableReason | null
  created: string
  purgedAt: string | null
}

/**
 * Flat keys, because `origin` is already the column heading.
 *
 * `revert` maps to the **number-less** message. The one carrying the version is
 * rendered separately, because this entry is what a revert without a number
 * falls back to — rows written before it was recorded, and, on current data,
 * a version whose provenance the server withholds because one end is a
 * tombstone (ADR-044 §4). Pointed at the parameterized message instead, that
 * branch renders the translation key.
 */
const ORIGIN_LABEL = {
  upload: 'originUpload',
  fetch: 'originFetch',
  revert: 'originRevertUnknown',
} as const

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

  // **Which of the three cases this is** (spec §9.6). Both inputs come from the
  // server — `isLive`, because the live pointer names an object rather than a
  // version, and `purgeFallsBackTo`, because where a restore may land is its rule
  // to change. Deriving either here is what the field exists to stop; the reasons
  // each attempt fails are on `VersionView` in `resource-version-service.ts`.
  //
  // **Named, but still said conditionally.** Live can move between opening this
  // dialog and confirming it, so the case is what will happen if it does not, not
  // a promise — `purgeCaseMayMove` says so, in every branch.
  const target = versions.find((v) => v.version === purgeTarget) ?? null
  const purgeCase = !target
    ? null
    : !target.isLive
      ? 'purgeCaseNotLive'
      : target.purgeFallsBackTo === null
        ? 'purgeCaseLiveLast'
        : 'purgeCaseLive'

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
  const targetHash = target?.hash
  const sameContent = targetHash
    ? versions
        .filter(
          (v) =>
            v.version !== purgeTarget &&
            v.hash === targetHash &&
            // A version on its way out does not keep this content either.
            v.state !== 'purged' &&
            v.state !== 'purging'
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
                        {v.origin === 'revert' && v.restoredFrom !== null
                          ? t('originRevert', { version: v.restoredFrom })
                          : t(ORIGIN_LABEL[v.origin])}
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
            <DialogDescription>{t('purgeWarning')}</DialogDescription>
          </DialogHeader>
          <div className="text-muted-foreground flex flex-col gap-2 text-sm">
            {/* A string, not the number: ICU groups digits, so v1000 would read
                "v1,000". */}
            {purgeCase && (
              <p>{t(purgeCase, { fallback: String(target?.purgeFallsBackTo ?? '') })}</p>
            )}
            <p>{t('purgeCaseMayMove')}</p>
            <p>{t('purgeWarningTail')}</p>
          </div>
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
