'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { createOrganizationSchema, type CreateOrganizationInput } from '@kukan/shared'
import {
  Alert,
  AlertDescription,
  Button,
  Field,
  FieldControl,
  FieldLabel,
  Input,
  Textarea,
} from '@kukan/ui'
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
      <Field id="name" description={tc('nameHelp')} error={errors.name?.message}>
        <FieldLabel>{tc('nameRequired')}</FieldLabel>
        <FieldControl>
          <Input placeholder="my-organization" {...register('name')} disabled={mode === 'edit'} />
        </FieldControl>
      </Field>
      <Field id="title">
        <FieldLabel>{tc('title')}</FieldLabel>
        <FieldControl>
          <Input placeholder={t('titlePlaceholder')} {...register('title')} />
        </FieldControl>
      </Field>
      <Field id="description">
        <FieldLabel>{tc('description')}</FieldLabel>
        <FieldControl>
          <Textarea
            placeholder={t('descriptionPlaceholder')}
            rows={4}
            {...register('description')}
          />
        </FieldControl>
      </Field>
      <Field id="imageUrl" error={errors.imageUrl?.message}>
        <FieldLabel>{tc('imageUrl')}</FieldLabel>
        <FieldControl>
          <Input type="url" placeholder="https://example.com/logo.png" {...register('imageUrl')} />
        </FieldControl>
      </Field>
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? submitLabels.loading : submitLabels.idle}
      </Button>
    </form>
  )
}
