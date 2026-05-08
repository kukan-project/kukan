'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { createGroupSchema, type CreateGroupInput } from '@kukan/shared'
import { Button, Input, Label, Textarea } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'

type GroupFormProps =
  | { mode?: 'create'; defaultValues?: Partial<CreateGroupInput>; nameOrId?: undefined }
  | { mode: 'edit'; defaultValues?: Partial<CreateGroupInput>; nameOrId: string }

export function GroupForm({ mode = 'create', defaultValues, nameOrId }: GroupFormProps) {
  const router = useRouter()
  const t = useTranslations('category')
  const tc = useTranslations('common')
  const [error, setError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CreateGroupInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(createGroupSchema) as any,
    defaultValues,
  })

  const onSubmit = async (values: CreateGroupInput) => {
    setError(null)

    const url = mode === 'create' ? '/api/v1/groups' : `/api/v1/groups/${nameOrId}`
    const method = mode === 'create' ? 'POST' : 'PUT'
    const res = await clientFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.detail || tc('failedToCreate'))
      return
    }
    router.push('/dashboard/groups')
  }

  const submitLabels =
    mode === 'edit'
      ? { idle: tc('update'), loading: tc('updating') }
      : { idle: tc('create'), loading: tc('creating') }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor="name">{tc('nameRequired')}</Label>
        <Input
          id="name"
          placeholder="my-group"
          {...register('name')}
          aria-invalid={!!errors.name}
          disabled={mode === 'edit'}
        />
        <p className="text-xs text-muted-foreground">{tc('nameHelp')}</p>
        {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="title">{tc('title')}</Label>
        <Input id="title" placeholder={t('titlePlaceholder')} {...register('title')} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="description">{tc('description')}</Label>
        <Textarea
          id="description"
          placeholder={t('descriptionPlaceholder')}
          rows={4}
          {...register('description')}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="imageUrl">{tc('imageUrl')}</Label>
        <Input
          id="imageUrl"
          type="url"
          placeholder="https://example.com/logo.png"
          {...register('imageUrl')}
          aria-invalid={!!errors.imageUrl}
        />
        {errors.imageUrl && <p className="text-sm text-destructive">{errors.imageUrl.message}</p>}
      </div>
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? submitLabels.loading : submitLabels.idle}
      </Button>
    </form>
  )
}
