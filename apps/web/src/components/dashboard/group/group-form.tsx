'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { createGroupSchema, type CreateGroupInput } from '@kukan/shared'
import { Button, Input, Label, Textarea } from '@kukan/ui'
import { clientFetch } from '@/lib/client-api'

export function GroupForm() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CreateGroupInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(createGroupSchema) as any,
  })

  const onSubmit = async (values: CreateGroupInput) => {
    setError(null)
    const res = await clientFetch('/api/v1/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.detail || '作成に失敗しました')
      return
    }
    router.push('/dashboard/groups')
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor="name">名前（必須）</Label>
        <Input
          id="name"
          placeholder="my-group"
          {...register('name')}
          aria-invalid={!!errors.name}
        />
        <p className="text-xs text-muted-foreground">
          半角英数字、ハイフン、アンダースコアのみ（2〜100文字）
        </p>
        {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="title">タイトル</Label>
        <Input id="title" placeholder="グループの表示名" {...register('title')} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="description">説明</Label>
        <Textarea
          id="description"
          placeholder="グループの説明"
          rows={4}
          {...register('description')}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="image_url">画像URL</Label>
        <Input
          id="image_url"
          type="url"
          placeholder="https://example.com/logo.png"
          {...register('image_url')}
          aria-invalid={!!errors.image_url}
        />
        {errors.image_url && <p className="text-sm text-destructive">{errors.image_url.message}</p>}
      </div>
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? '作成中...' : '作成'}
      </Button>
    </form>
  )
}
