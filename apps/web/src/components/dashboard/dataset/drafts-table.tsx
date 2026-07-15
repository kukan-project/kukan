'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@kukan/ui'
import { useLocale, useTranslations } from 'next-intl'
import { isDraftPlaceholderName, type PackageDbState } from '@kukan/shared'
import { clientFetch } from '@/lib/client-api'
import { draftEditPath } from '@/lib/paths'
import { formatDateTimeCompact } from '@/components/date-time'
import { DeleteConfirmDialog } from '@/components/dashboard/delete-confirm-dialog'

interface DraftItem {
  id: string
  name: string
  title?: string | null
  updated?: string
  // 'purging' marks a draft whose deletion crashed mid-flight (ADR-039);
  // it stays listed so the user can retry the DELETE
  state?: PackageDbState
}

interface DraftsTableProps {
  items: DraftItem[]
  /** Called after a successful deletion so the caller can refetch the list */
  onDeleted: () => void
}

/** Draft dataset listing with delete confirmation (ADR-039) */
export function DraftsTable({ items, onDeleted }: DraftsTableProps) {
  const t = useTranslations('dataset')
  const tc = useTranslations('common')
  const locale = useLocale()

  // Draft deletion (ADR-039): skips the trash, permanently removed
  const [draftToDelete, setDraftToDelete] = useState<DraftItem | null>(null)
  const [deletingDraft, setDeletingDraft] = useState(false)

  async function handleDeleteDraft() {
    if (!draftToDelete) return
    setDeletingDraft(true)
    try {
      const res = await clientFetch(`/api/v1/packages/${draftToDelete.id}`, { method: 'DELETE' })
      if (res.ok) {
        setDraftToDelete(null)
        onDeleted()
      }
    } finally {
      setDeletingDraft(false)
    }
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{tc('title')}</TableHead>
            <TableHead>{tc('urlIdentifier')}</TableHead>
            <TableHead className="whitespace-nowrap">{t('updatedShort')}</TableHead>
            <TableHead className="w-[140px] whitespace-nowrap">{tc('actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((pkg) => {
            const isPurging = pkg.state === 'purging'
            return (
              <TableRow key={pkg.id}>
                <TableCell>
                  {pkg.title ? (
                    <span className="font-medium">{pkg.title}</span>
                  ) : (
                    <span className="text-muted-foreground">{t('untitled')}</span>
                  )}
                  {isPurging && (
                    <Badge
                      variant="outline"
                      className="ml-2 border-destructive/50 text-destructive"
                    >
                      {t('draftPurging')}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="font-mono text-sm">
                  {/* Auto-generated placeholder names are not user data — hide them */}
                  {isDraftPlaceholderName(pkg.name) ? (
                    <span className="text-muted-foreground">-</span>
                  ) : (
                    pkg.name
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm">
                  {pkg.updated ? formatDateTimeCompact(pkg.updated, locale) : '-'}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {/* Purging rows are mid-deletion — no edit, only the delete retry */}
                  {!isPurging && (
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={draftEditPath(pkg.id)}>{tc('edit')}</Link>
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setDraftToDelete(pkg)}
                  >
                    {isPurging ? t('retryDelete') : tc('delete')}
                  </Button>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      <DeleteConfirmDialog
        open={draftToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setDraftToDelete(null)
        }}
        title={draftToDelete?.state === 'purging' ? t('retryDelete') : t('deleteDraft')}
        description={
          draftToDelete?.state === 'purging' ? t('retryDeleteConfirm') : t('deleteDraftConfirm')
        }
        onConfirm={handleDeleteDraft}
        isDeleting={deletingDraft}
        confirmLabel={t('purgeDataset')}
      />
    </>
  )
}
