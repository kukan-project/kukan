'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'

interface MaintenanceNoticeProps {
  title: string
  /** One line per piece of work left; the card is the caller's to hide when empty */
  lines: string[]
  action: string
  running: string
  queued: string
  onRun: () => Promise<boolean>
}

/**
 * The shell for a one-time migration prompt on the dashboard: work an upgrade
 * left behind, an action that starts it, and nothing at all once it is done.
 *
 * Shared rather than copied because the shape is the contract — an admin who
 * has seen one of these knows what the next one is asking of them.
 */
export function MaintenanceNotice({
  title,
  lines,
  action,
  running,
  queued,
  onRun,
}: MaintenanceNoticeProps) {
  const tc = useTranslations('common')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<'queued' | 'failed' | null>(null)

  async function handleRun() {
    setBusy(true)
    setOutcome(null)
    try {
      setOutcome((await onRun()) ? 'queued' : 'failed')
    } catch {
      // A rejected fetch is a failure like any other; without this the button
      // would sit disabled reading "running" until the page is reloaded
      setOutcome('failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1 text-sm text-muted-foreground">
          {lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
        <div className="flex items-center gap-4">
          <Button onClick={handleRun} disabled={busy || outcome === 'queued'}>
            {busy ? running : action}
          </Button>
          {outcome === 'queued' && (
            <p role="status" className="text-sm text-muted-foreground">
              {queued}
            </p>
          )}
          {outcome === 'failed' && (
            <p role="alert" className="text-sm text-destructive">
              {tc('queueFailed')}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
