'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { SwitchField } from '@/components/switch-field'
import { clientFetch } from '@/lib/client-api'

interface VectorSearchSettings {
  enabled: boolean
  model: string | null
  semanticEnabled: boolean
  baseMinSimilarity: number
  baseSource: 'env' | 'model' | 'default'
  notches: number
  step: number
  maxNotches: number
  effectiveMinSimilarity: number
}

/** Vector-search runtime settings: semantic on/off + similarity-floor notches
 *  (ADR-036). Renders nothing when semantic search is unavailable. */
export function VectorSimilarityCard() {
  const t = useTranslations('dashboard.adminSite')
  const tc = useTranslations('common')

  const [settings, setSettings] = useState<VectorSearchSettings | null>(null)
  const [selected, setSelected] = useState(0)
  const [selectedEnabled, setSelectedEnabled] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    ;(async () => {
      try {
        const res = await clientFetch('/api/v1/admin/settings/vector-search')
        if (res.ok) {
          const data: VectorSearchSettings = await res.json()
          setSettings(data)
          setSelected(data.notches)
          setSelectedEnabled(data.semanticEnabled)
        }
      } catch {
        // ignore — card stays hidden
      }
    })()
  }, [])

  if (!settings?.enabled) return null

  // 0.025 steps produce 3-decimal values; String() drops trailing zeros
  const valueAt = (notches: number) => {
    const value = Math.min(1, Math.max(0, settings.baseMinSimilarity + notches * settings.step))
    return String(Math.round(value * 1000) / 1000)
  }
  const notchRange = Array.from(
    { length: settings.maxNotches * 2 + 1 },
    (_, i) => i - settings.maxNotches
  )
  const sourceLabel = {
    env: t('vectorBaseSourceEnv'),
    model: t('vectorBaseSourceModel'),
    default: t('vectorBaseSourceDefault'),
  }[settings.baseSource]

  const dirty = selected !== settings.notches || selectedEnabled !== settings.semanticEnabled

  async function handleSave() {
    if (!settings) return
    setSaving(true)
    setSaved(false)
    try {
      const changes: Array<{ key: string; value: unknown }> = []
      if (selected !== settings.notches) {
        changes.push({ key: 'vector-similarity-notches', value: selected })
      }
      if (selectedEnabled !== settings.semanticEnabled) {
        changes.push({ key: 'semantic-search-enabled', value: selectedEnabled })
      }
      for (const { key, value } of changes) {
        const res = await clientFetch(`/api/v1/admin/settings/${key}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        })
        if (!res.ok) return
      }

      // Re-fetch the computed context (effective value etc.) after the writes
      const res = await clientFetch('/api/v1/admin/settings/vector-search')
      if (res.ok) {
        const data: VectorSearchSettings = await res.json()
        setSettings(data)
        setSelected(data.notches)
        setSelectedEnabled(data.semanticEnabled)
        setSaved(true)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('vectorTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{t('vectorDescription')}</p>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('vectorModel')}</span>
          <span className="font-mono text-xs">{settings.model}</span>
          <Badge variant="outline" className="text-xs">
            {t('vectorBase')} {settings.baseMinSimilarity} — {sourceLabel}
          </Badge>
        </div>

        <SwitchField
          label={t('vectorSemanticEnabled')}
          checked={selectedEnabled}
          onCheckedChange={(checked) => {
            setSelectedEnabled(checked)
            setSaved(false)
          }}
        />

        <div className={`flex flex-wrap items-center gap-2 ${selectedEnabled ? '' : 'opacity-50'}`}>
          <span className="w-12 text-right text-xs text-muted-foreground">{t('vectorLooser')}</span>
          {notchRange.map((n) => (
            <button
              key={n}
              type="button"
              disabled={!selectedEnabled}
              onClick={() => {
                setSelected(n)
                setSaved(false)
              }}
              className={`min-w-14 rounded-md border px-2 py-1.5 text-sm transition-colors ${
                selected === n
                  ? 'border-primary bg-primary/10 font-medium'
                  : 'border-input hover:bg-accent'
              }`}
            >
              {valueAt(n)}
              <span className="block text-[10px] leading-tight text-muted-foreground">
                {n === 0 ? t('vectorBaseMark') : n > 0 ? `+${n}` : `${n}`}
              </span>
            </button>
          ))}
          <span className="w-12 text-xs text-muted-foreground">{t('vectorStricter')}</span>
        </div>

        <div className="flex items-center gap-4">
          <Button onClick={handleSave} disabled={saving || !dirty}>
            {tc('save')}
          </Button>
          <span className="text-sm text-muted-foreground">
            {t('vectorEffective', { value: valueAt(settings.notches) })}
          </span>
          {saved && <span className="text-sm text-muted-foreground">{t('saved')}</span>}
        </div>
      </CardContent>
    </Card>
  )
}
