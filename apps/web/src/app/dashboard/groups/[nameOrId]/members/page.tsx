'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import {
  Button,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Badge,
} from '@kukan/ui'
import { clientFetch } from '@/lib/client-api'
import { PageHeader } from '@/components/dashboard/page-header'

interface Member {
  id: string
  userId: string
  role: string
  userName: string
  email: string
  displayName?: string | null
  created: string
}

interface SearchUser {
  id: string
  name: string
  email: string
  displayName?: string | null
}

export default function GroupMembersPage() {
  const params = useParams<{ nameOrId: string }>()
  const nameOrId = params.nameOrId

  const [members, setMembers] = useState<Member[]>([])
  const membersRef = useRef(members)
  membersRef.current = members
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Add member state
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchUser[]>([])
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const [selectedRole, setSelectedRole] = useState('member')
  const [adding, setAdding] = useState(false)

  const fetchMembers = useCallback(async () => {
    const res = await clientFetch(`/api/v1/groups/${encodeURIComponent(nameOrId)}/members`)
    if (res.ok) {
      const data = await res.json()
      setMembers(data.items)
    }
    setLoading(false)
  }, [nameOrId])

  useEffect(() => {
    fetchMembers()
  }, [fetchMembers])

  // Search users with debounce
  useEffect(() => {
    if (searchQuery.length < 2) {
      setSearchResults([])
      return
    }
    const timer = setTimeout(async () => {
      const res = await clientFetch(`/api/v1/users?q=${encodeURIComponent(searchQuery)}&limit=5`)
      if (res.ok) {
        const data = await res.json()
        // Filter out existing members
        const memberIds = new Set(membersRef.current.map((m) => m.userId))
        setSearchResults(data.items.filter((u: SearchUser) => !memberIds.has(u.id)))
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const handleAddMember = async () => {
    if (!selectedUserId) return
    setAdding(true)
    setError(null)

    const res = await clientFetch(`/api/v1/groups/${encodeURIComponent(nameOrId)}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: selectedUserId, role: selectedRole }),
    })

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.detail || 'メンバーの追加に失敗しました')
    } else {
      setSelectedUserId(null)
      setSearchQuery('')
      setSearchResults([])
      setSelectedRole('member')
      await fetchMembers()
    }
    setAdding(false)
  }

  const handleRemoveMember = async (userId: string) => {
    const res = await clientFetch(
      `/api/v1/groups/${encodeURIComponent(nameOrId)}/members/${userId}`,
      { method: 'DELETE' }
    )
    if (res.ok) {
      await fetchMembers()
    }
  }

  const roleBadge = (role: string) => {
    switch (role) {
      case 'admin':
        return <Badge>管理者</Badge>
      case 'editor':
        return <Badge variant="secondary">編集者</Badge>
      default:
        return <Badge variant="outline">メンバー</Badge>
    }
  }

  if (loading) {
    return <p className="py-12 text-center text-muted-foreground">読み込み中...</p>
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={`グループメンバー: ${nameOrId}`}>
        <Button variant="outline" asChild>
          <Link href="/dashboard/groups">戻る</Link>
        </Button>
      </PageHeader>

      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      )}

      {/* Add member section */}
      <div className="rounded-lg border p-4">
        <h3 className="mb-3 text-sm font-medium">メンバーを追加</h3>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Input
              placeholder="ユーザー名またはメールで検索..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value)
                setSelectedUserId(null)
              }}
            />
            {searchResults.length > 0 && !selectedUserId && (
              <div className="mt-1 rounded-md border bg-background shadow-sm">
                {searchResults.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    className="w-full px-3 py-2 text-left text-sm hover:bg-accent"
                    onClick={() => {
                      setSelectedUserId(u.id)
                      setSearchQuery(u.displayName || u.name)
                      setSearchResults([])
                    }}
                  >
                    <span className="font-medium">{u.displayName || u.name}</span>
                    <span className="ml-2 text-muted-foreground">{u.email}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <Select value={selectedRole} onValueChange={setSelectedRole}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="member">メンバー</SelectItem>
              <SelectItem value="editor">編集者</SelectItem>
              <SelectItem value="admin">管理者</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={handleAddMember} disabled={!selectedUserId || adding}>
            {adding ? '追加中...' : '追加'}
          </Button>
        </div>
      </div>

      {/* Members table */}
      {members.length === 0 ? (
        <p className="py-12 text-center text-muted-foreground">メンバーがいません</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ユーザー</TableHead>
              <TableHead>メール</TableHead>
              <TableHead>ロール</TableHead>
              <TableHead className="w-[80px]">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => (
              <TableRow key={m.id}>
                <TableCell className="font-medium">{m.displayName || m.userName}</TableCell>
                <TableCell>{m.email}</TableCell>
                <TableCell>{roleBadge(m.role)}</TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => {
                      if (
                        confirm(`${m.displayName || m.userName} をこのグループから削除しますか？`)
                      ) {
                        handleRemoveMember(m.userId)
                      }
                    }}
                  >
                    削除
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
