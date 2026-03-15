'use client'

import { Card, CardContent, CardHeader, CardTitle, Label } from '@kukan/ui'
import { useUser } from '@/components/dashboard/user-provider'
import { PageHeader } from '@/components/dashboard/page-header'

export default function ProfilePage() {
  const user = useUser()

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="プロフィール" />
      <Card>
        <CardHeader>
          <CardTitle>アカウント情報</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-1">
            <Label className="text-muted-foreground">ユーザー名</Label>
            <p>{user.name}</p>
          </div>
          <div className="grid gap-1">
            <Label className="text-muted-foreground">メールアドレス</Label>
            <p>{user.email}</p>
          </div>
          <div className="grid gap-1">
            <Label className="text-muted-foreground">ロール</Label>
            <p>{user.sysadmin ? 'システム管理者' : 'ユーザー'}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
