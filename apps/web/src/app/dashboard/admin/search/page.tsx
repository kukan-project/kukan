'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Search } from 'lucide-react'
import { Button, Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { useUser } from '@/components/dashboard/user-provider'
import { PageHeader } from '@/components/dashboard/page-header'
import { clientFetch } from '@/lib/client-api'

export default function AdminSearchPage() {
  const user = useUser()
  const router = useRouter()
  const t = useTranslations('dashboard.adminSearch')

  const [reindexing, setReindexing] = useState(false)
  const [result, setResult] = useState<number | null>(null)

  if (!user.sysadmin) {
    router.replace('/dashboard')
    return null
  }

  async function handleReindex() {
    setReindexing(true)
    setResult(null)
    try {
      const res = await clientFetch('/api/v1/admin/reindex', { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        setResult(data.indexed)
      }
    } finally {
      setReindexing(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('reindexTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">{t('reindexDescription')}</p>
          <div className="flex items-center gap-4">
            <Button onClick={handleReindex} disabled={reindexing}>
              <Search className="mr-2 h-4 w-4" />
              {reindexing ? t('reindexing') : t('reindex')}
            </Button>
            {result !== null && (
              <p className="text-sm text-muted-foreground">
                {t('reindexResult', { count: result })}
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
