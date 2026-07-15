'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  createAnnouncementSchema,
  announcementCategories,
  type CreateAnnouncementInput,
} from '@kukan/shared'
import {
  Alert,
  AlertDescription,
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'

type AnnouncementFormProps =
  | { mode?: 'create'; defaultValues?: Partial<CreateAnnouncementInput>; id?: undefined }
  | { mode: 'edit'; defaultValues?: Partial<CreateAnnouncementInput>; id: string }

function toDatetimeLocal(date: Date | undefined | null): string {
  if (!date) return ''
  const d = new Date(date)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function localToISO(datetimeLocalStr: string): string {
  return new Date(datetimeLocalStr).toISOString()
}

export function AnnouncementForm({ mode = 'create', defaultValues, id }: AnnouncementFormProps) {
  const router = useRouter()
  const t = useTranslations('announcement')
  const tc = useTranslations('common')
  const [error, setError] = useState<string | null>(null)
  const [timezone, setTimezone] = useState('')

  useEffect(() => {
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone)
  }, [])

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<CreateAnnouncementInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(createAnnouncementSchema) as any,
    defaultValues: {
      ...defaultValues,
      category: defaultValues?.category ?? 'info',
      publishedAt: undefined,
    },
  })

  const category = watch('category')

  // Keep the raw string for the datetime-local input
  const [publishedAtStr, setPublishedAtStr] = useState(toDatetimeLocal(defaultValues?.publishedAt))

  const onSubmit = async (values: CreateAnnouncementInput) => {
    setError(null)

    const payload = {
      ...values,
      publishedAt: publishedAtStr ? localToISO(publishedAtStr) : null,
    }

    const url = mode === 'create' ? '/api/v1/announcements' : `/api/v1/announcements/${id}`
    const method = mode === 'create' ? 'POST' : 'PUT'
    const res = await clientFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.detail || tc('failedToCreate'))
      return
    }
    router.push('/dashboard/admin/announcements')
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
        <Label htmlFor="title">{t('title')}</Label>
        <Input
          id="title"
          placeholder={t('titlePlaceholder')}
          {...register('title')}
          aria-invalid={!!errors.title}
          aria-describedby={errors.title ? 'title-error' : undefined}
        />
        {errors.title && (
          <p id="title-error" className="text-sm text-destructive">
            {errors.title.message}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="category">{t('category')}</Label>
        <Select value={category} onValueChange={(v) => setValue('category', v as typeof category)}>
          <SelectTrigger id="category">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {announcementCategories.map((cat) => (
              <SelectItem key={cat} value={cat}>
                {t(`category_${cat}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="link">{t('link')}</Label>
        <Input
          id="link"
          type="url"
          placeholder={t('linkPlaceholder')}
          {...register('link')}
          aria-invalid={!!errors.link}
          aria-describedby={errors.link ? 'link-error' : undefined}
        />
        {errors.link && (
          <p id="link-error" className="text-sm text-destructive">
            {errors.link.message}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="publishedAt">
          {t('publishedAt')}
          {timezone && ` (${timezone})`}
        </Label>
        <Input
          id="publishedAt"
          type="datetime-local"
          value={publishedAtStr}
          onChange={(e) => setPublishedAtStr(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">{t('publishedAtHelp')}</p>
      </div>
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? submitLabels.loading : submitLabels.idle}
      </Button>
    </form>
  )
}
