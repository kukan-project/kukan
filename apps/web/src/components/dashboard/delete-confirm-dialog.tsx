'use client'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@kukan/ui'
import { Button } from '@kukan/ui'
import { useTranslations } from 'next-intl'

interface DeleteConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  onConfirm: () => void
  isDeleting?: boolean
  /** Custom label for the confirm button (defaults to "Delete" / "Deleting...") */
  confirmLabel?: string
  confirmingLabel?: string
}

export function DeleteConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  isDeleting,
  confirmLabel,
  confirmingLabel,
}: DeleteConfirmDialogProps) {
  const tc = useTranslations('common')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isDeleting}>
            {tc('cancel')}
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={isDeleting}>
            {isDeleting ? (confirmingLabel ?? tc('deleting')) : (confirmLabel ?? tc('delete'))}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
