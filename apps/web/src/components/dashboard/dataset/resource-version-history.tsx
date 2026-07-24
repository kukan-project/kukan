'use client'

import { useCallback, useEffect, useState } from 'react'
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
import { formatBytes } from '@/lib/format-utils'
import { useUser } from '@/components/dashboard/user-provider'

interface VersionView {
  version: number
  origin: 'upload' | 'fetch'
  state: 'active' | 'purging' | 'purged'
  size: number | null
  created: string
  purgedAt: string | null
  purgeReason: string | null
}

interface Props {
  resourceId: string
  /** Download filename base (resource name/url), used only for the link label. */
}

export function ResourceVersionHistory({ resourceId }: Props) {
  const t = useTranslations('resource.versions')
  const { sysadmin } = useUser()
  const [versions, setVersions] = useState<VersionView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [purgeTarget, setPurgeTarget] = useState<number | null>(null)
  const [reason, setReason] = useState('')
  const [purging, setPurging] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await clientFetch(`/api/v1/resources/${resourceId}/versions`)
      if (!res.ok) throw new Error(String(res.status))
      const data = await res.json()
      setVersions(data.versions)
    } catch {
      setError(t('loadError'))
    }
  }, [resourceId, t])

  useEffect(() => {
    void load()
  }, [load])

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
          {versions.map((v) => {
            const purged = v.state === 'purged'
            const purging = v.state === 'purging'
            return (
              <TableRow key={v.version}>
                <TableCell>v{v.version}</TableCell>
                <TableCell className="text-muted-foreground">
                  {new Date(v.created).toLocaleString()}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {purged ? '—' : (formatBytes(v.size) ?? '—')}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">
                    {v.origin === 'upload' ? t('originUpload') : t('originFetch')}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    {purged ? (
                      <Badge variant="secondary">{t('purged')}</Badge>
                    ) : purging ? (
                      <Badge variant="secondary">{t('purging')}</Badge>
                    ) : (
                      <>
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
