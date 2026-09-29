'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Sparkles } from 'lucide-react'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { SwitchField } from '@/components/switch-field'
import { clientFetch } from '@/lib/client-api'
import { useVectorSearchSettings } from '@/hooks/use-vector-search-settings'

/**
 * Semantic search in one place: how search uses the vectors (on/off and the
 * similarity floor in notches, ADR-036), and regenerating the vectors
 * themselves (ADR-054). The regeneration marks every resource and leaves the
 * rest to the embed job, which skips a resource whose text and model have not
 * changed.
 */
export function SemanticSearchCard() {
  const t = useTranslations('dashboard.adminAi')
  const tc = useTranslations('common')

  // Bumped after a save: the effective value is computed on the server
  const [version, setVersion] = useState(0)
  const vector = useVectorSearchSettings(version)
  const settings = vector.data

  const [selected, setSelected] = useState(0)
  const [selectedEnabled, setSelectedEnabled] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [regenerated, setRegenerated] = useState<boolean | null>(null)

  useEffect(() => {
    if (!settings) return
    setSelected(settings.notches)
    setSelectedEnabled(settings.semanticEnabled)
  }, [settings])

  const available = settings?.enabled === true

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
      setSaved(true)
      setVersion((v) => v + 1)
    } finally {
      setSaving(false)
    }
  }

  async function regenerate() {
    setRegenerating(true)
    setRegenerated(null)
    try {
      const res = await clientFetch('/api/v1/admin/reindex-embeddings', { method: 'POST' })
      setRegenerated(res.ok)
    } catch {
      setRegenerated(false)
    } finally {
      setRegenerating(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('semanticTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{t('semanticDescription')}</p>

        {settings?.model && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t('model')}:</span>
            <span className="font-mono text-xs">{settings.model}</span>
          </div>
        )}
        {vector.error && (
          <p role="alert" className="text-sm text-destructive">
            {t('settingsUnavailable')}
          </p>
        )}
        {!vector.loading && !vector.error && !available && (
          <p className="text-sm text-muted-foreground">{t('unavailable')}</p>
        )}

        {settings && available && (
          <SemanticUsage
            settings={settings}
            selected={selected}
            selectedEnabled={selectedEnabled}
            saving={saving}
            saved={saved}
            onSelect={(n) => {
              setSelected(n)
              setSaved(false)
            }}
            onToggle={(checked) => {
              setSelectedEnabled(checked)
              setSaved(false)
            }}
            onSave={handleSave}
          />
        )}

        <section className="flex flex-col gap-3 rounded-md border p-4">
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium">{t('regenerateTitle')}</h3>
            <p className="text-sm text-muted-foreground">{t('regenerateDescription')}</p>
          </div>
          <div className="flex items-center gap-4">
            <Button variant="outline" onClick={regenerate} disabled={!available || regenerating}>
              <Sparkles className={`mr-2 h-4 w-4 ${regenerating ? 'animate-spin' : ''}`} />
              {regenerating ? tc('queueing') : t('regenerateButton')}
            </Button>
            {regenerated === true && (
              <p role="status" className="text-sm text-muted-foreground">
                {t('regenerateQueued')}
              </p>
            )}
            {regenerated === false && (
              <p role="alert" className="text-sm text-destructive">
                {tc('queueFailed')}
              </p>
            )}
          </div>
        </section>
      </CardContent>
    </Card>
  )
}

interface SemanticUsageProps {
  settings: NonNullable<ReturnType<typeof useVectorSearchSettings>['data']>
  selected: number
  selectedEnabled: boolean
  saving: boolean
  saved: boolean
  onSelect: (notches: number) => void
  onToggle: (checked: boolean) => void
  onSave: () => void
}

/** On/off and the similarity floor, saved together */
function SemanticUsage({
  settings,
  selected,
  selectedEnabled,
  saving,
  saved,
  onSelect,
  onToggle,
  onSave,
}: SemanticUsageProps) {
  const t = useTranslations('dashboard.adminAi')
  const tc = useTranslations('common')

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

  return (
    <section className="flex flex-col gap-4 rounded-md border p-4">
      <h3 className="text-sm font-medium">{t('semanticUsageTitle')}</h3>

      <SwitchField
        label={t('vectorSemanticEnabled')}
        checked={selectedEnabled}
        onCheckedChange={onToggle}
      />

      <div className={`flex flex-col gap-2 ${selectedEnabled ? '' : 'opacity-50'}`}>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{t('vectorThresholdLabel')}</span>
          <Badge variant="outline" className="text-xs">
            {t('vectorBase')} {settings.baseMinSimilarity} — {sourceLabel}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">{t('vectorThresholdHint')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-12 text-right text-xs text-muted-foreground">{t('vectorLooser')}</span>
          {notchRange.map((n) => (
            <button
              key={n}
              type="button"
              disabled={!selectedEnabled}
              onClick={() => onSelect(n)}
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
      </div>

      <div className="flex items-center gap-4">
        <Button onClick={onSave} disabled={saving || !dirty}>
          {tc('save')}
        </Button>
        <span className="text-sm text-muted-foreground">
          {t('vectorEffective', { value: valueAt(settings.notches) })}
        </span>
        {saved && <span className="text-sm text-muted-foreground">{t('saved')}</span>}
      </div>
    </section>
  )
}
