'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { createOrganizationSchema, type CreateOrganizationInput } from '@kukan/shared'
import { Alert, AlertDescription, Button, Input, Label, Textarea } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'

type OrganizationFormProps =
  | { mode?: 'create'; defaultValues?: Partial<CreateOrganizationInput>; nameOrId?: undefined }
  | { mode: 'edit'; defaultValues?: Partial<CreateOrganizationInput>; nameOrId: string }

export function OrganizationForm({
  mode = 'create',
  defaultValues,
  nameOrId,
}: OrganizationFormProps) {
  const router = useRouter()
  const t = useTranslations('organization')
  const tc = useTranslations('common')
  const [error, setError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CreateOrganizationInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(createOrganizationSchema) as any,
    defaultValues,
  })

  const onSubmit = async (values: CreateOrganizationInput) => {
    setError(null)

    const url = mode === 'create' ? '/api/v1/organizations' : `/api/v1/organizations/${nameOrId}`
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
    router.push('/dashboard/organizations')
  }

  const submitLabels =
    mode === 'edit'
      ? { idle: tc('update'), loading: tc('updating') }
      : { idle: tc('create'), loading: tc('creating') }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor="name">{tc('nameRequired')}</Label>
        <Input
          id="name"
          placeholder="my-organization"
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
