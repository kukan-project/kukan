'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { createPackageSchema, LICENSES, resolveLicenseLabel } from '@kukan/shared'
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
import { z } from 'zod'
import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'

/** Form-level schema: license_id is required in the UI */
const datasetFormSchema = createPackageSchema.extend({
  license_id: z.string().min(1),
})
type DatasetFormInput = z.infer<typeof datasetFormSchema>

interface Organization {
  id: string
  name: string
  title?: string
}

interface DatasetFormProps {
  mode: 'create' | 'edit'
  defaultValues?: Partial<DatasetFormInput>
  nameOrId?: string
  organizations: Organization[]
}

export function DatasetForm({ mode, defaultValues, nameOrId, organizations }: DatasetFormProps) {
  const router = useRouter()
  const t = useTranslations('dataset')
  const tl = useTranslations('license')
  const tc = useTranslations('common')
  const [error, setError] = useState<string | null>(null)
  const [tagsInput, setTagsInput] = useState(
    defaultValues?.tags?.map((t) => t.name).join(', ') ?? ''
  )

  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
  } = useForm<DatasetFormInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(datasetFormSchema) as any,
    defaultValues: {
      private: false,
      type: 'dataset',
      extras: {},
      tags: [],
      resources: [],
      ...defaultValues,
    },
  })

  const onSubmit = async (values: DatasetFormInput) => {
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
      setError(data.detail || tc('failedToCreate'))
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
        <Label htmlFor="name">{tc('nameRequired')}</Label>
        <Input
          id="name"
          placeholder="my-dataset"
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
        <Label htmlFor="notes">{tc('description')}</Label>
        <Textarea
          id="notes"
          placeholder={t('descriptionPlaceholder')}
          rows={4}
          {...register('notes')}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="owner_org">{t('orgRequired')}</Label>
        <Controller
          name="owner_org"
          control={control}
          render={({ field }) => (
            <Select value={field.value ?? ''} onValueChange={field.onChange}>
              <SelectTrigger aria-invalid={!!errors.owner_org}>
                <SelectValue placeholder={t('orgSelect')} />
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
        {errors.owner_org && <p className="text-sm text-destructive">{tc('required')}</p>}
      </div>

      <div className="flex items-center gap-3">
        <Controller
          name="private"
          control={control}
          render={({ field }) => (
            <Switch id="private" checked={field.value} onCheckedChange={field.onChange} />
          )}
        />
        <Label htmlFor="private">{tc('private')}</Label>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="tags">{t('tags')}</Label>
        <Input
          id="tags"
          placeholder={t('tagsPlaceholder')}
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">{t('tagsHelp')}</p>
      </div>

      <div className="flex flex-col gap-2">
        <Label>{t('licenseRequired')}</Label>
        <Controller
          name="license_id"
          control={control}
          render={({ field }) => (
            <Select value={field.value ?? ''} onValueChange={field.onChange}>
              <SelectTrigger aria-invalid={!!errors.license_id}>
                <SelectValue placeholder={t('licenseSelect')} />
              </SelectTrigger>
              <SelectContent>
                {LICENSES.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {resolveLicenseLabel(l.id, tl)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        {errors.license_id && <p className="text-sm text-destructive">{tc('required')}</p>}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="author">{t('author')}</Label>
          <Input id="author" {...register('author')} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="author_email">{t('authorEmail')}</Label>
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
          <Label htmlFor="maintainer">{t('maintainerLabel')}</Label>
          <Input id="maintainer" {...register('maintainer')} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="maintainer_email">{t('maintainerEmail')}</Label>
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
          <Label htmlFor="version">{t('version')}</Label>
          <Input id="version" placeholder="1.0" {...register('version')} />
        </div>
      </div>

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting
          ? mode === 'create'
            ? tc('creating')
            : tc('updating')
          : mode === 'create'
            ? tc('create')
            : tc('update')}
      </Button>
    </form>
  )
}
