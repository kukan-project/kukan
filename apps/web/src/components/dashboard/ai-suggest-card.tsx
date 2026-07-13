'use client'

import { useEffect, useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader2, PlugZap } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@kukan/ui'
import { clientFetch } from '@/lib/client-api'

interface AiSuggestSettings {
  enabled: boolean
  provider: string | null
  defaultModel: string | null
  model: string
  effectiveModel: string | null
  suggestEnabled: boolean
  /** Candidate models for the picker; empty → free-text entry */
  availableModels: string[]
}

/** Radix Select forbids an empty-string item value, so the "provider default"
 *  (stored as "") option uses this sentinel. */
const DEFAULT_MODEL_VALUE = '__default__'

type TestResult =
  | { ok: true; model: string; latencyMs: number }
  | { ok: false; error?: string; code?: string }

/** Maps a server diagnose code (see services/suggest/diagnose.ts) to the i18n
 *  key of an actionable setup instruction. Unmapped codes show the raw error. */
const HINT_KEYS: Record<string, string> = {
  'bedrock-iam': 'aiSuggestHintBedrockIam',
  'bedrock-use-case': 'aiSuggestHintBedrockUseCase',
  'bedrock-marketplace': 'aiSuggestHintBedrockMarketplace',
  'ollama-unreachable': 'aiSuggestHintOllamaUnreachable',
  'ollama-model-missing': 'aiSuggestHintOllamaModelMissing',
  'openai-auth': 'aiSuggestHintOpenaiAuth',
  'openai-model-missing': 'aiSuggestHintOpenaiModelMissing',
}

/** Generative-AI model settings. The card is the umbrella for every AI use of a
 *  completion model; today it holds one section — metadata suggestions (ADR-040,
 *  on/off + model ID + connection test). Renders nothing when the AI adapter
 *  cannot generate (AI_TYPE=none). */
export function AiSuggestCard() {
  const t = useTranslations('dashboard.adminSite')
  const tc = useTranslations('common')
  const toggleId = useId()
  const modelId = useId()

  const [settings, setSettings] = useState<AiSuggestSettings | null>(null)
  const [selectedModel, setSelectedModel] = useState('')
  const [selectedEnabled, setSelectedEnabled] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)

  useEffect(() => {
    ;(async () => {
      try {
        const res = await clientFetch('/api/v1/admin/settings/ai-suggest')
        if (res.ok) {
          const data: AiSuggestSettings = await res.json()
          setSettings(data)
          setSelectedModel(data.model)
          setSelectedEnabled(data.suggestEnabled)
        }
      } catch {
        // ignore — card stays hidden
      }
    })()
  }, [])

  if (!settings?.enabled) return null

  const dirty =
    selectedModel.trim() !== settings.model || selectedEnabled !== settings.suggestEnabled

  // Keep an already-set model selectable even if the provider didn't list it
  const modelOptions =
    selectedModel && !settings.availableModels.includes(selectedModel)
      ? [selectedModel, ...settings.availableModels]
      : settings.availableModels

  async function handleSave() {
    if (!settings) return
    setSaving(true)
    setSaved(false)
    try {
      const changes: Array<{ key: string; value: unknown }> = []
      if (selectedModel.trim() !== settings.model) {
        changes.push({ key: 'ai-suggest-model', value: selectedModel.trim() })
      }
      if (selectedEnabled !== settings.suggestEnabled) {
        changes.push({ key: 'ai-suggest-enabled', value: selectedEnabled })
      }
      for (const { key, value } of changes) {
        const res = await clientFetch(`/api/v1/admin/settings/${key}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        })
        if (!res.ok) return
      }

      // Re-fetch the computed context (effective model) after the writes
      const res = await clientFetch('/api/v1/admin/settings/ai-suggest')
      if (res.ok) {
        const data: AiSuggestSettings = await res.json()
        setSettings(data)
        setSelectedModel(data.model)
        setSelectedEnabled(data.suggestEnabled)
        setSaved(true)
        setTestResult(null)
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await clientFetch('/api/v1/admin/settings/ai-suggest/test', { method: 'POST' })
      if (res.ok) {
        setTestResult(await res.json())
      } else {
        const body = await res.text()
        setTestResult({ ok: false, error: `${res.status}: ${body}` })
      }
    } catch (err) {
      setTestResult({ ok: false, error: String(err) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('aiModelsTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{t('aiModelsDescription')}</p>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('aiSuggestProvider')}</span>
          <Badge variant="outline" className="text-xs">
            {settings.provider}
          </Badge>
        </div>

        {/* Metadata suggestions — one AI use of the completion model. Future uses
            are sibling sections under the same card. */}
        <section className="flex flex-col gap-4 rounded-md border p-4">
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium">{t('aiSuggestSectionTitle')}</h3>
            <p className="text-sm text-muted-foreground">{t('aiSuggestDescription')}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t('aiSuggestEffectiveModel')}</span>
            <span className="font-mono text-xs">{settings.effectiveModel}</span>
          </div>

          <div className="flex items-center gap-2">
            <Switch
              id={toggleId}
              checked={selectedEnabled}
              onCheckedChange={(checked) => {
                setSelectedEnabled(checked)
                setSaved(false)
              }}
            />
            <Label htmlFor={toggleId} className="text-sm font-normal">
              {t('aiSuggestEnabled')}
            </Label>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={modelId}>{t('aiSuggestModelLabel')}</Label>
            {settings.availableModels.length > 0 ? (
              <Select
                value={selectedModel || DEFAULT_MODEL_VALUE}
                onValueChange={(value) => {
                  setSelectedModel(value === DEFAULT_MODEL_VALUE ? '' : value)
                  setSaved(false)
                }}
              >
                <SelectTrigger id={modelId} className="max-w-2xl font-mono text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_MODEL_VALUE}>
                    {t('aiSuggestModelDefaultOption', { model: settings.defaultModel ?? '' })}
                  </SelectItem>
                  {modelOptions.map((model) => (
                    <SelectItem key={model} value={model} className="font-mono">
                      {model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <>
                <Input
                  id={modelId}
                  value={selectedModel}
                  onChange={(e) => {
                    setSelectedModel(e.target.value)
                    setSaved(false)
                  }}
                  placeholder={settings.defaultModel ?? ''}
                  className="max-w-2xl font-mono text-sm"
                />
                {/* Only the free-text input has an empty state; the picker offers
                    an explicit "provider default" option instead. */}
                <p className="text-xs text-muted-foreground">{t('aiSuggestModelHint')}</p>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <Button onClick={handleSave} disabled={saving || !dirty}>
              {tc('save')}
            </Button>
            <Button variant="outline" onClick={handleTest} disabled={testing || dirty}>
              {testing ? (
                <>
                  <Loader2 className="mr-1 size-4 animate-spin" />
                  {t('aiSuggestTesting')}
                </>
              ) : (
                <>
                  <PlugZap className="mr-1 size-4" />
                  {t('aiSuggestTest')}
                </>
              )}
            </Button>
            {saved && <span className="text-sm text-muted-foreground">{t('saved')}</span>}
          </div>

          {testResult &&
            (testResult.ok ? (
              <div className="rounded-md border p-3 text-sm text-muted-foreground">
                {t('aiSuggestTestOk', { model: testResult.model, latency: testResult.latencyMs })}
              </div>
            ) : (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {t('aiSuggestTestFailed')}
                {testResult.code && HINT_KEYS[testResult.code] && (
                  <span className="mt-1 block font-normal">{t(HINT_KEYS[testResult.code])}</span>
                )}
                {testResult.error && (
                  <span className="mt-1 block font-mono text-xs">{testResult.error}</span>
                )}
              </div>
            ))}
        </section>
      </CardContent>
    </Card>
  )
}
