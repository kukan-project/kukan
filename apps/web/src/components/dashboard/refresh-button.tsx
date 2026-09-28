'use client'

import { useTranslations } from 'next-intl'
import { RefreshCw } from 'lucide-react'
import { Button } from '@kukan/ui'

/** The page header's refresh button; `spinning` also covers polls it did not start */
export function RefreshButton({
  onClick,
  disabled,
  spinning,
}: {
  onClick: () => void
  disabled: boolean
  spinning: boolean
}) {
  const tc = useTranslations('common')
  return (
    <Button
      variant="outline"
      size="icon"
      className="h-8 w-8"
      onClick={onClick}
      disabled={disabled}
      aria-label={tc('refresh')}
      title={tc('refresh')}
    >
      <RefreshCw className={`h-4 w-4 ${spinning ? 'animate-spin' : ''}`} />
    </Button>
  )
}
