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

function formatDate(dateStr: string | null) {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleDateString('ja-JP')
}

export default function ApiTokensPage() {
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
      <PageHeader title="APIトークン">
        <Button onClick={() => setShowCreate(true)}>新規作成</Button>
      </PageHeader>

      {newToken && (
        <Card className="border-primary/30 bg-primary/5">
          <CardHeader>
            <CardTitle className="text-sm">トークンが作成されました</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              以下のトークンをコピーしてください。再度表示されません。
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded bg-muted px-3 py-2 text-sm break-all">
                {newToken}
              </code>
              <Button variant="outline" size="sm" onClick={copyToken}>
                {copied ? 'コピー済み' : 'コピー'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {tokens.length === 0 ? (
        <p className="py-12 text-center text-muted-foreground">APIトークンがありません</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名前</TableHead>
              <TableHead>作成日</TableHead>
              <TableHead>最終使用</TableHead>
              <TableHead>有効期限</TableHead>
              <TableHead className="w-[80px]">操作</TableHead>
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
                    削除
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
            <DialogTitle>APIトークン作成</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="token-name">名前（任意）</Label>
              <Input
                id="token-name"
                value={tokenName}
                onChange={(e) => setTokenName(e.target.value)}
                placeholder="例: CI/CD用トークン"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="expires">有効期限</Label>
              <Select value={expiresDays} onValueChange={setExpiresDays}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="30">30日</SelectItem>
                  <SelectItem value="90">90日</SelectItem>
                  <SelectItem value="180">180日</SelectItem>
                  <SelectItem value="365">1年</SelectItem>
                  <SelectItem value="none">無期限</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              キャンセル
            </Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? '作成中...' : '作成'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DeleteConfirmDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title="トークンを削除"
        description="このトークンを削除すると、このトークンを使用しているアプリケーションは認証できなくなります。"
        onConfirm={handleDelete}
        isDeleting={deleting}
      />
    </div>
  )
}
