'use client'

import { useEffect, useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Card, CardContent, CardHeader, CardTitle, Checkbox, Label } from '@kukan/ui'
import { PACK_IDS } from '@kukan/vocabulary/pack-ids'
import { clientFetch } from '@/lib/client-api'

const SETTING_KEY = 'vocabulary-packs'

const same = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id))

/**
 * Which packs the site reads table columns against (ADR-073 §決定 8). None by
 * default: which country's codes a site reads is the site's to say.
 */
export function VocabularyCard() {
  const t = useTranslations('dashboard.adminSite')
  const tc = useTranslations('common')
  const idPrefix = useId()

  const [loaded, setLoaded] = useState(false)
  const [stored, setStored] = useState<string[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    ;(async () => {
      try {
        const res = await clientFetch('/api/v1/admin/settings')
        if (res.ok) {
          const data: Record<string, unknown> = await res.json()
          const value = Array.isArray(data[SETTING_KEY]) ? (data[SETTING_KEY] as string[]) : []
          setStored(value)
          setSelected(value)
          setLoaded(true)
        }
      } catch {
        // ignore — card stays hidden
      }
    })()
  }, [])

  if (!loaded) return null

  async function save() {
    setSaving(true)
    setSaved(false)
    try {
      const res = await clientFetch(`/api/v1/admin/settings/${SETTING_KEY}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // A pack a newer release wrote stays in: unchecking is for the ones listed
        body: JSON.stringify({ value: selected }),
      })
      if (res.ok) {
        const data: { value: string[] } = await res.json()
        setStored(data.value)
        setSelected(data.value)
        setSaved(true)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('vocabularyTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{t('vocabularyDescription')}</p>
        <div className="flex flex-col gap-2">
          {PACK_IDS.map((id) => (
            <div key={id} className="flex items-center gap-2">
              <Checkbox
                id={`${idPrefix}-${id}`}
                checked={selected.includes(id)}
                disabled={saving}
                onCheckedChange={(checked) => {
                  setSelected((current) =>
                    checked ? [...current, id] : current.filter((p) => p !== id)
                  )
                  setSaved(false)
                }}
              />
              <Label htmlFor={`${idPrefix}-${id}`}>{t(`vocabularyPacks.${id}`)}</Label>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-4">
          <Button onClick={save} disabled={saving || same(selected, stored)}>
            {tc('save')}
          </Button>
          {saved && (
            <span role="status" className="text-sm text-muted-foreground">
              {t('saved')}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
