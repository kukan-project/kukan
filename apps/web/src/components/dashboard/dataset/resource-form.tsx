'use client'

import { useState } from 'react'
import { Button, Input, Label, Textarea } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'

interface ResourceFormProps {
  packageId: string
  onCreated: () => void
}

export function ResourceForm({ packageId, onCreated }: ResourceFormProps) {
  const t = useTranslations('resource')
  const tc = useTranslations('common')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [format, setFormat] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const body: Record<string, string> = {}
      if (name) body.name = name
      if (url) body.url = url
      if (format) body.format = format
      if (description) body.description = description

      const res = await clientFetch(`/api/v1/packages/${packageId}/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.detail || t('failedToAdd'))
        return
      }
      setName('')
      setUrl('')
      setFormat('')
      setDescription('')
      onCreated()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="res-name">{tc('name')}</Label>
          <Input
            id="res-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="data.csv"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="res-format">{tc('format')}</Label>
          <Input
            id="res-format"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            placeholder="CSV"
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="res-url">URL</Label>
        <Input
          id="res-url"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/data.csv"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="res-description">{tc('description')}</Label>
        <Textarea
          id="res-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder={t('descriptionPlaceholder')}
        />
      </div>
      <Button type="submit" disabled={submitting} variant="outline">
        {submitting ? t('addingResource') : t('addResource')}
      </Button>
    </form>
  )
}
