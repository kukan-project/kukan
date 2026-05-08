'use client'

import { useState, useCallback, useRef } from 'react'
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

/** Form-level schema: licenseId is required in the UI */
const datasetFormSchema = createPackageSchema.extend({
  licenseId: z.string().min(1),
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
  const [extrasError, setExtrasError] = useState<string | null>(null)
  const [tagsInput, setTagsInput] = useState(
    defaultValues?.tags?.map((t) => t.name).join(', ') ?? ''
  )
  const nextExtrasId = useRef(0)
  const [extrasRows, setExtrasRows] = useState<{ id: number; key: string; value: string }[]>(() => {
    const extras = (defaultValues?.extras ?? {}) as Record<string, unknown>
    return Object.entries(extras).map(([key, value]) => {
      const strValue = typeof value === 'string' ? value : JSON.stringify(value ?? '')
      return { id: nextExtrasId.current++, key, value: strValue }
    })
  })

  const addExtrasRow = useCallback(() => {
    setExtrasRows((rows) => [...rows, { id: nextExtrasId.current++, key: '', value: '' }])
  }, [])

  const removeExtrasRow = useCallback((id: number) => {
    setExtrasRows((rows) => rows.filter((r) => r.id !== id))
    setExtrasError(null)
  }, [])

  const updateExtrasRow = useCallback((id: number, field: 'key' | 'value', val: string) => {
    setExtrasRows((rows) => rows.map((r) => (r.id === id ? { ...r, [field]: val } : r)))
  }, [])

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

    // Build extras from key-value rows (skip empty keys)
    const filledRows = extrasRows.filter((r) => r.key.trim())
    const keyCount = new Map<string, number>()
    for (const r of filledRows) {
      const k = r.key.trim()
      keyCount.set(k, (keyCount.get(k) ?? 0) + 1)
    }
    const duplicateKeys = [...keyCount.entries()].filter(([, c]) => c > 1).map(([k]) => k)
    if (duplicateKeys.length > 0) {
      setExtrasError(t('extrasDuplicateKey', { keys: duplicateKeys.join(', ') }))
      return
    }
    setExtrasError(null)
    const extras = Object.fromEntries(filledRows.map((r) => [r.key.trim(), r.value]))

    const body = { ...values, tags, extras }

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
        <Label htmlFor="ownerOrg">{t('orgRequired')}</Label>
        <Controller
          name="ownerOrg"
          control={control}
          render={({ field }) => (
            <Select value={field.value ?? ''} onValueChange={field.onChange}>
              <SelectTrigger aria-invalid={!!errors.ownerOrg}>
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
        {errors.ownerOrg && <p className="text-sm text-destructive">{tc('required')}</p>}
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
          name="licenseId"
          control={control}
          render={({ field }) => (
            <Select value={field.value ?? ''} onValueChange={field.onChange}>
              <SelectTrigger aria-invalid={!!errors.licenseId}>
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
        {errors.licenseId && <p className="text-sm text-destructive">{tc('required')}</p>}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="author">{t('author')}</Label>
          <Input id="author" {...register('author')} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="authorEmail">{t('authorEmail')}</Label>
          <Input
            id="authorEmail"
            type="email"
            {...register('authorEmail')}
            aria-invalid={!!errors.authorEmail}
          />
          {errors.authorEmail && (
            <p className="text-sm text-destructive">{errors.authorEmail.message}</p>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="maintainer">{t('maintainerLabel')}</Label>
          <Input id="maintainer" {...register('maintainer')} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="maintainerEmail">{t('maintainerEmail')}</Label>
          <Input
            id="maintainerEmail"
            type="email"
            {...register('maintainerEmail')}
            aria-invalid={!!errors.maintainerEmail}
          />
          {errors.maintainerEmail && (
            <p className="text-sm text-destructive">{errors.maintainerEmail.message}</p>
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

      <div className="flex flex-col gap-2">
        <Label>{t('extras')}</Label>
        <p className="text-xs text-muted-foreground">{t('extrasHelp')}</p>
        {extrasRows.map((row) => (
          <div key={row.id} className="flex gap-2">
            <Input
              placeholder={t('extrasKeyPlaceholder')}
              value={row.key}
              onChange={(e) => updateExtrasRow(row.id, 'key', e.target.value)}
              className="flex-1"
            />
            <Input
              placeholder={t('extrasValuePlaceholder')}
              value={row.value}
              onChange={(e) => updateExtrasRow(row.id, 'value', e.target.value)}
              className="flex-1"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => removeExtrasRow(row.id)}
            >
              ×
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" className="w-fit" onClick={addExtrasRow}>
          {t('extrasAdd')}
        </Button>
        {extrasError && <p className="text-sm text-destructive">{extrasError}</p>}
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
