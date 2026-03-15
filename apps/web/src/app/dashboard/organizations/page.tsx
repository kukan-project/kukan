'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@kukan/ui'
import { clientFetch } from '@/lib/client-api'
import { useUser } from '@/components/dashboard/user-provider'
import { PageHeader } from '@/components/dashboard/page-header'

interface OrgItem {
  id: string
  name: string
  title?: string
  datasetCount: number
}

export default function OrganizationsManagePage() {
  const user = useUser()
  const [items, setItems] = useState<OrgItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    clientFetch('/api/v1/organizations?limit=100').then(async (res) => {
      if (res.ok) {
        const data = await res.json()
        setItems(data.items)
      }
      setLoading(false)
    })
  }, [])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="組織">
        {user.sysadmin && (
          <Button asChild>
            <Link href="/dashboard/organizations/new">新規作成</Link>
          </Button>
        )}
      </PageHeader>

      {loading ? (
        <p className="py-12 text-center text-muted-foreground">読み込み中...</p>
      ) : items.length === 0 ? (
        <p className="py-12 text-center text-muted-foreground">組織がありません</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名前</TableHead>
              <TableHead>タイトル</TableHead>
              <TableHead className="text-right">データセット数</TableHead>
              <TableHead className="w-[80px]">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((org) => (
              <TableRow key={org.id}>
                <TableCell className="font-medium">{org.name}</TableCell>
                <TableCell>{org.title || '-'}</TableCell>
                <TableCell className="text-right">{org.datasetCount}</TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={`/dashboard/organizations/${org.name}/members`}>メンバー</Link>
                    </Button>
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={`/organization/${org.name}`}>表示</Link>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
