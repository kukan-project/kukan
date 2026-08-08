'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
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
import { useTranslations } from 'next-intl'
import { isDraftPlaceholderName, type PackageDbState } from '@kukan/shared'
import { clientFetch } from '@/lib/client-api'
import { draftEditPath } from '@/lib/paths'
import { FormatBadges } from '@/components/format-badges'
import { DeleteConfirmDialog } from '@/components/dashboard/delete-confirm-dialog'

interface DraftItem {
  id: string
  name: string
  title?: string | null
  formats?: string
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
  const router = useRouter()

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
            <TableHead>{tc('urlIdentifier')}</TableHead>
            <TableHead>{tc('title')}</TableHead>
            <TableHead className="whitespace-nowrap">{t('visibility')}</TableHead>
            <TableHead className="whitespace-nowrap">{tc('format')}</TableHead>
            <TableHead className="w-[140px] whitespace-nowrap">{tc('actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((pkg) => {
            const isPurging = pkg.state === 'purging'
            // Purging drafts are mid-deletion and not editable — no row navigation.
            const editHref = isPurging ? null : draftEditPath(pkg.id)
            return (
              <TableRow
                key={pkg.id}
                role={editHref ? 'link' : undefined}
                tabIndex={editHref ? 0 : undefined}
                className={editHref ? 'cursor-pointer hover:bg-muted/50' : undefined}
                onClick={() => editHref && router.push(editHref)}
                onKeyDown={(e) => {
                  if (editHref && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault()
                    router.push(editHref)
                  }
                }}
              >
                <TableCell className="font-mono text-sm">
                  {/* Auto-generated placeholder names are not user data — hide them */}
                  {isDraftPlaceholderName(pkg.name) ? (
                    <span className="text-muted-foreground">-</span>
                  ) : (
                    pkg.name
                  )}
                </TableCell>
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
                {/* A draft is never on the site, so the visibility the other
                    tabs name here says nothing yet (ADR-039) */}
                <TableCell className="whitespace-nowrap">
                  <Badge variant="secondary">{t('draftBadge')}</Badge>
                </TableCell>
                <TableCell>
                  <FormatBadges formats={pkg.formats} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {/* Row click opens the editor; the delete button stops propagation
                      so it doesn't also navigate. */}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation()
                      setDraftToDelete(pkg)
                    }}
                  >
                    {isPurging ? t('retryDelete') : t('purgeAction')}
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
