'use client'

import { useState } from 'react'
import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Badge,
} from '@kukan/ui'
import { clientFetch } from '@/lib/api'
import { DeleteConfirmDialog } from '@/components/delete-confirm-dialog'

interface Resource {
  id: string
  name?: string | null
  url?: string | null
  format?: string | null
  description?: string | null
}

interface ResourceListProps {
  resources: Resource[]
  onDeleted: () => void
}

export function ResourceList({ resources, onDeleted }: ResourceListProps) {
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  async function handleDelete() {
    if (!deleteId) return
    setDeleting(true)
    try {
      const res = await clientFetch(`/api/v1/resources/${deleteId}`, { method: 'DELETE' })
      if (res.ok) {
        setDeleteId(null)
        onDeleted()
      }
    } finally {
      setDeleting(false)
    }
  }

  if (resources.length === 0) {
    return <p className="py-4 text-center text-sm text-muted-foreground">リソースがありません</p>
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名前</TableHead>
            <TableHead>フォーマット</TableHead>
            <TableHead>URL</TableHead>
            <TableHead className="w-[80px]">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {resources.map((r) => (
            <TableRow key={r.id}>
              <TableCell>{r.name || '-'}</TableCell>
              <TableCell>
                {r.format ? <Badge variant="secondary">{r.format}</Badge> : '-'}
              </TableCell>
              <TableCell className="max-w-[200px] truncate">
                {r.url ? (
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline"
                  >
                    {r.url}
                  </a>
                ) : (
                  '-'
                )}
              </TableCell>
              <TableCell>
                <Button variant="ghost" size="sm" onClick={() => setDeleteId(r.id)}>
                  削除
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <DeleteConfirmDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title="リソースを削除"
        description="このリソースを削除してもよろしいですか？"
        onConfirm={handleDelete}
        isDeleting={deleting}
      />
    </>
  )
}
