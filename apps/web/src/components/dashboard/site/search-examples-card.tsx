'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Card, CardContent, CardHeader, CardTitle, Textarea } from '@kukan/ui'
import { clientFetch } from '@/lib/client-api'

const SETTING_KEY = 'search-example-queries'
const MAX_QUERIES = 10

/** Example-query chips shown under the search box, one per line (ADR-036) */
export function SearchExamplesCard() {
  const t = useTranslations('dashboard.adminSite')
  const tc = useTranslations('common')

  const [loaded, setLoaded] = useState(false)
  const [text, setText] = useState('')
  const [original, setOriginal] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    ;(async () => {
      try {
        const res = await clientFetch('/api/v1/admin/settings')
        if (res.ok) {
          const data: Record<string, unknown> = await res.json()
          const value = ((data[SETTING_KEY] as string[]) ?? []).join('\n')
          setText(value)
          setOriginal(value)
          setLoaded(true)
        }
      } catch {
        // ignore — card stays hidden
      }
    })()
  }, [])

  if (!loaded) return null

  const parsed = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const dirty = parsed.join('\n') !== original

  async function save() {
    setSaving(true)
    setSaved(false)
    try {
      const res = await clientFetch(`/api/v1/admin/settings/${SETTING_KEY}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: parsed }),
      })
      if (res.ok) {
        const data: { value: string[] } = await res.json()
        const value = data.value.join('\n')
        setText(value)
        setOriginal(value)
        setSaved(true)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('exampleQueriesTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          {t('exampleQueriesDescription', { max: MAX_QUERIES })}
        </p>
        <Textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setSaved(false)
          }}
          rows={5}
          placeholder={t('exampleQueriesPlaceholder')}
          className="max-w-lg font-normal"
        />
        <div className="flex flex-wrap items-center gap-4">
          <Button onClick={save} disabled={saving || !dirty || parsed.length > MAX_QUERIES}>
            {tc('save')}
          </Button>
          {parsed.length > MAX_QUERIES && (
            <span className="text-sm text-destructive">
              {t('exampleQueriesTooMany', { max: MAX_QUERIES })}
            </span>
          )}
          {saved && <span className="text-sm text-muted-foreground">{t('saved')}</span>}
        </div>
      </CardContent>
    </Card>
  )
}
