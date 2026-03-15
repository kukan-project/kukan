'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kukan/ui'
import { useTranslations, useLocale } from 'next-intl'
import { clientFetch } from '@/lib/client-api'
import { PageHeader } from '@/components/dashboard/page-header'
import { DeleteConfirmDialog } from '@/components/dashboard/delete-confirm-dialog'

interface ApiToken {
  id: string
  name: string | null
  lastUsed: string | null
  expiresAt: string | null
  created: string
}

export default function ApiTokensPage() {
  const t = useTranslations('apiToken')
  const tc = useTranslations('common')
  const locale = useLocale()

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '-'
    return new Date(dateStr).toLocaleDateString(locale)
  }

  const [tokens, setTokens] = useState<ApiToken[]>([])
  const [newToken, setNewToken] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [tokenName, setTokenName] = useState('')
  const [expiresDays, setExpiresDays] = useState('90')
  const [creating, setCreating] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [copied, setCopied] = useState(false)

  const fetchTokens = useCallback(async () => {
    const res = await clientFetch('/api/v1/api-tokens')
    if (res.ok) {
      const data = await res.json()
      setTokens(data.items)
    }
  }, [])

  useEffect(() => {
    fetchTokens()
  }, [fetchTokens])

  async function handleCreate() {
    setCreating(true)
    try {
      const body: Record<string, unknown> = {}
      if (tokenName) body.name = tokenName
      if (expiresDays !== 'none') body.expiresInDays = Number(expiresDays)
      const res = await clientFetch('/api/v1/api-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        const data = await res.json()
        setNewToken(data.token)
        setShowCreate(false)
        setTokenName('')
        setExpiresDays('90')
        await fetchTokens()
      }
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete() {
    if (!deleteId) return
    setDeleting(true)
    try {
      const res = await clientFetch(`/api/v1/api-tokens/${deleteId}`, { method: 'DELETE' })
      if (res.ok) {
        setDeleteId(null)
        await fetchTokens()
      }
    } finally {
      setDeleting(false)
    }
  }

  async function copyToken() {
    if (!newToken) return
    await navigator.clipboard.writeText(newToken)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')}>
        <Button onClick={() => setShowCreate(true)}>{tc('new')}</Button>
      </PageHeader>

      {newToken && (
        <Card className="border-primary/30 bg-primary/5">
          <CardHeader>
            <CardTitle className="text-sm">{t('tokenCreated')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">{t('tokenCopyNote')}</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded bg-muted px-3 py-2 text-sm break-all">
                {newToken}
              </code>
              <Button variant="outline" size="sm" onClick={copyToken}>
                {copied ? t('copied') : t('copy')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {tokens.length === 0 ? (
        <p className="py-12 text-center text-muted-foreground">{t('noTokens')}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tc('name')}</TableHead>
              <TableHead>{t('createdAt')}</TableHead>
              <TableHead>{t('lastUsed')}</TableHead>
              <TableHead>{t('expiresAt')}</TableHead>
              <TableHead className="w-[80px]">{tc('actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.map((token) => (
              <TableRow key={token.id}>
                <TableCell>{token.name || '-'}</TableCell>
                <TableCell>{formatDate(token.created)}</TableCell>
                <TableCell>{formatDate(token.lastUsed)}</TableCell>
                <TableCell>{formatDate(token.expiresAt)}</TableCell>
                <TableCell>
                  <Button variant="ghost" size="sm" onClick={() => setDeleteId(token.id)}>
                    {tc('delete')}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('createToken')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="token-name">{t('nameOptional')}</Label>
              <Input
                id="token-name"
                value={tokenName}
                onChange={(e) => setTokenName(e.target.value)}
                placeholder={t('namePlaceholder')}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="expires">{t('expiresIn')}</Label>
              <Select value={expiresDays} onValueChange={setExpiresDays}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="30">{t('days30')}</SelectItem>
                  <SelectItem value="90">{t('days90')}</SelectItem>
                  <SelectItem value="180">{t('days180')}</SelectItem>
                  <SelectItem value="365">{t('year1')}</SelectItem>
                  <SelectItem value="none">{t('noExpiry')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              {tc('cancel')}
            </Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? tc('creating') : tc('create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DeleteConfirmDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title={t('deleteToken')}
        description={t('deleteTokenConfirm')}
        onConfirm={handleDelete}
        isDeleting={deleting}
      />
    </div>
  )
}
