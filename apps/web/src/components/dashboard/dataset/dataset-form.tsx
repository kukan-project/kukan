'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { createPackageSchema, type CreatePackageInput } from '@kukan/shared'
import {
  Button,
  Input,
  Label,
  Textarea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@kukan/ui'
import { clientFetch } from '@/lib/client-api'

interface Organization {
  id: string
  name: string
  title?: string
}

interface DatasetFormProps {
  mode: 'create' | 'edit'
  defaultValues?: Partial<CreatePackageInput>
  nameOrId?: string
  organizations: Organization[]
}

export function DatasetForm({ mode, defaultValues, nameOrId, organizations }: DatasetFormProps) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [tagsInput, setTagsInput] = useState(
    defaultValues?.tags?.map((t) => t.name).join(', ') ?? ''
  )

  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
  } = useForm<CreatePackageInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(createPackageSchema) as any,
    defaultValues: {
      private: false,
      type: 'dataset',
      extras: {},
      tags: [],
      resources: [],
      ...defaultValues,
    },
  })

  const onSubmit = async (values: CreatePackageInput) => {
    setError(null)

    // Parse comma-separated tags
    const tags = tagsInput
      .split(/[,、]/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((name) => ({ name }))

    const body = { ...values, tags }

    const url = mode === 'create' ? '/api/v1/packages' : `/api/v1/packages/${nameOrId}`
    const method = mode === 'create' ? 'POST' : 'PUT'

    const res = await clientFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.detail || `${mode === 'create' ? '作成' : '更新'}に失敗しました`)
      return
    }

    router.push('/dashboard/datasets')
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-6">
      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="name">名前（必須）</Label>
        <Input
          id="name"
          placeholder="my-dataset"
          {...register('name')}
          aria-invalid={!!errors.name}
          disabled={mode === 'edit'}
        />
        <p className="text-xs text-muted-foreground">
          半角英数字、ハイフン、アンダースコアのみ（2〜100文字）
        </p>
        {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="title">タイトル</Label>
        <Input id="title" placeholder="データセットの表示名" {...register('title')} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="notes">説明</Label>
        <Textarea id="notes" placeholder="データセットの説明" rows={4} {...register('notes')} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="owner_org">組織（必須）</Label>
        <Controller
          name="owner_org"
          control={control}
          render={({ field }) => (
            <Select value={field.value ?? ''} onValueChange={field.onChange}>
              <SelectTrigger aria-invalid={!!errors.owner_org}>
                <SelectValue placeholder="組織を選択" />
              </SelectTrigger>
              <SelectContent>
                {organizations.map((org) => (
                  <SelectItem key={org.id} value={org.id}>
                    {org.title || org.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        {errors.owner_org && <p className="text-sm text-destructive">{errors.owner_org.message}</p>}
      </div>

      <div className="flex items-center gap-3">
        <Controller
          name="private"
          control={control}
          render={({ field }) => (
            <Switch id="private" checked={field.value} onCheckedChange={field.onChange} />
          )}
        />
        <Label htmlFor="private">非公開</Label>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="tags">タグ</Label>
        <Input
          id="tags"
          placeholder="タグをカンマ区切りで入力（例: 統計, 人口, 東京都）"
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">カンマ区切りで複数入力</p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="license_id">ライセンス</Label>
        <Input id="license_id" placeholder="CC-BY-4.0" {...register('license_id')} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="author">作成者</Label>
          <Input id="author" {...register('author')} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="author_email">作成者メール</Label>
          <Input
            id="author_email"
            type="email"
            {...register('author_email')}
            aria-invalid={!!errors.author_email}
          />
          {errors.author_email && (
            <p className="text-sm text-destructive">{errors.author_email.message}</p>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="maintainer">管理者</Label>
          <Input id="maintainer" {...register('maintainer')} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="maintainer_email">管理者メール</Label>
          <Input
            id="maintainer_email"
            type="email"
            {...register('maintainer_email')}
            aria-invalid={!!errors.maintainer_email}
          />
          {errors.maintainer_email && (
            <p className="text-sm text-destructive">{errors.maintainer_email.message}</p>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="url">URL</Label>
          <Input
            id="url"
            type="url"
            placeholder="https://example.com"
            {...register('url')}
            aria-invalid={!!errors.url}
          />
          {errors.url && <p className="text-sm text-destructive">{errors.url.message}</p>}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="version">バージョン</Label>
          <Input id="version" placeholder="1.0" {...register('version')} />
        </div>
      </div>

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting
          ? mode === 'create'
            ? '作成中...'
            : '更新中...'
          : mode === 'create'
            ? '作成'
            : '更新'}
      </Button>
    </form>
  )
}
