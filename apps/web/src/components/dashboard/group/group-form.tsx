'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { createGroupSchema, type CreateGroupInput } from '@kukan/shared'
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
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Field id="name" description={tc('nameHelp')} error={errors.name?.message}>
        <FieldLabel>{tc('nameRequired')}</FieldLabel>
        <FieldControl>
          <Input placeholder="my-group" {...register('name')} disabled={mode === 'edit'} />
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
