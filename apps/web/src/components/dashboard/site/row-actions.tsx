'use client'

import { useTranslations } from 'next-intl'
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import { Button } from '@kukan/ui'

/** Move up, move down and remove for one row of an editable list */
export function RowActions({
  index,
  count,
  onMove,
  onRemove,
}: {
  index: number
  count: number
  onMove: (by: -1 | 1) => void
  onRemove: () => void
}) {
  const t = useTranslations('dashboard.adminSite')
  return (
    <div className="flex gap-1">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => onMove(-1)}
        disabled={index === 0}
        aria-label={t('rowMoveUp')}
      >
        <ArrowUp />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => onMove(1)}
        disabled={index === count - 1}
        aria-label={t('rowMoveDown')}
      >
        <ArrowDown />
      </Button>
      <Button variant="ghost" size="icon" onClick={onRemove} aria-label={t('rowRemove')}>
        <Trash2 />
      </Button>
    </div>
  )
}
