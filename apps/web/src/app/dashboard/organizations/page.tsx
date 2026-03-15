'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@kukan/ui'
import { useTranslations } from 'next-intl'
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
  const t = useTranslations('organization')
  const tc = useTranslations('common')
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
      <PageHeader title={tc('organizations')}>
        {user.sysadmin && (
          <Button asChild>
            <Link href="/dashboard/organizations/new">{tc('new')}</Link>
          </Button>
        )}
      </PageHeader>

      {loading ? (
        <p className="py-12 text-center text-muted-foreground">{tc('loading')}</p>
      ) : items.length === 0 ? (
        <p className="py-12 text-center text-muted-foreground">{t('noOrganizations')}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tc('name')}</TableHead>
              <TableHead>{tc('title')}</TableHead>
              <TableHead className="text-right">{tc('datasets')}</TableHead>
              <TableHead className="w-[80px]">{tc('actions')}</TableHead>
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
                      <Link href={`/dashboard/organizations/${org.name}/members`}>
                        {tc('members')}
                      </Link>
                    </Button>
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={`/organization/${org.name}`}>{tc('view')}</Link>
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
