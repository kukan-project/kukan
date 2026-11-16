'use client'

import { AlertTriangle } from 'lucide-react'
import { IconHint } from '@/components/icon-hint'

interface LinkHealthWarningProps {
  message: string
}

/** Why a link may no longer work, behind an icon */
export function LinkHealthWarning({ message }: LinkHealthWarningProps) {
  return (
    <IconHint
      label={message}
      hint={message}
      icon={<AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />}
      className="ml-1 p-1 text-warning-tint-foreground"
    />
  )
}
