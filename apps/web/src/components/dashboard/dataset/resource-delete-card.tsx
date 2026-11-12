'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@kukan/ui'
import { clientFetch, readProblem } from '@/lib/client-api'
import { useProblemMessage } from '@/hooks/use-problem-message'
import { DeleteConfirmDialog } from '@/components/dashboard/delete-confirm-dialog'

/**
 * Deleting a resource, in a card of its own at the foot of the Basic tab as the
 * dataset page does, away from Save.
 */
export function ResourceDeleteCard({
  resource,
  disabled,
  onDeleted,
}: {
  resource: { id: string; name?: string | null }
  /** A save or an upload under way, which a delete would race */
  disabled?: boolean
  onDeleted: () => void
}) {
  const t = useTranslations('resource')
  const describeProblem = useProblemMessage()
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  async function handleDelete() {
    setDeleting(true)
    setFailure(null)
    try {
      const res = await clientFetch(`/api/v1/resources/${resource.id}`, { method: 'DELETE' })
      if (res.ok) {
        setConfirming(false)
        onDeleted()
        return
      }
      setFailure(describeProblem(await readProblem(res)) ?? t('failedToDelete'))
    } catch {
      setFailure(t('failedToDelete'))
    } finally {
      setDeleting(false)
    }
    setConfirming(false)
  }

  return (
    <Card className="border-warning/40">
      <CardHeader>
        <CardTitle className="text-warning-tint-foreground">{t('deleteResource')}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-sm text-muted-foreground">{t('deleteResourceDescription')}</p>
        {failure && (
          <Alert variant="destructive" className="mb-3">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}
        <Button variant="outline" onClick={() => setConfirming(true)} disabled={disabled}>
          {t('deleteThisResource')}
        </Button>
      </CardContent>
      <DeleteConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('deleteResource')}
        description={t('deleteResourceConfirm', { name: resource.name || t('unnamed') })}
        onConfirm={handleDelete}
        isDeleting={deleting}
      />
    </Card>
  )
}
