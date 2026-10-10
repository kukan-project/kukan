'use client'

import { useCallback, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Field, Input } from '@kukan/ui'

/** One key-value row as typed — keys are trimmed and empties dropped only on save. */
export interface ExtrasRow {
  id: number
  key: string
  value: string
  /** What a loaded row held, and the text it was shown as */
  loaded?: { text: string; value: unknown }
}

/**
 * The rows an `extras` object is edited as, for a dataset or a resource.
 *
 * A value that is not a string is shown as its JSON. It is saved back as it
 * was unless its text is changed — an edit to another field must not turn a
 * number set through the API into a string.
 */
export function useExtrasRows(initial?: Record<string, unknown> | null) {
  const t = useTranslations('extras')
  const nextId = useRef(0)
  const toRows = useCallback(
    (extras?: Record<string, unknown> | null): ExtrasRow[] =>
      Object.entries(extras ?? {}).map(([key, value]) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value)
        return { id: nextId.current++, key, value: text, loaded: { text, value } }
      }),
    []
  )
  const [rows, setRows] = useState<ExtrasRow[]>(() => toRows(initial))
  const [error, setError] = useState<string | null>(null)

  const add = useCallback(() => {
    setRows((list) => [...list, { id: nextId.current++, key: '', value: '' }])
  }, [])
  const remove = useCallback((id: number) => {
    setRows((list) => list.filter((r) => r.id !== id))
    setError(null)
  }, [])
  const update = useCallback((id: number, field: 'key' | 'value', value: string) => {
    setRows((list) => list.map((r) => (r.id === id ? { ...r, [field]: value } : r)))
  }, [])
  const reset = useCallback(
    (extras?: Record<string, unknown> | null) => {
      setRows(toRows(extras))
      setError(null)
    },
    [toRows]
  )
  /** The object to save, or null after showing which keys were typed twice */
  const build = useCallback((): Record<string, unknown> | null => {
    const built = buildExtras(rows)
    if ('duplicateKeys' in built) {
      setError(t('duplicateKey', { keys: built.duplicateKeys.join(', ') }))
      return null
    }
    setError(null)
    return built.extras
  }, [rows, t])

  return { rows, error, add, remove, update, reset, build }
}

export type ExtrasEditor = ReturnType<typeof useExtrasRows>

/** What a row saves: the loaded value while its text is untouched, else the text */
function savedValue(row: ExtrasRow): unknown {
  return row.loaded && row.value === row.loaded.text ? row.loaded.value : row.value
}

/** The rows as a submit builds them, types included, for comparing against a saved baseline. */
export function snapshotExtras(rows: readonly ExtrasRow[]): string {
  return JSON.stringify(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), savedValue(r)]))
}

/** The object the rows save as, or the keys typed more than once — which would otherwise keep only the last. */
function buildExtras(
  rows: readonly ExtrasRow[]
): { extras: Record<string, unknown> } | { duplicateKeys: string[] } {
  const filled = rows.filter((r) => r.key.trim())
  const count = new Map<string, number>()
  for (const r of filled) count.set(r.key.trim(), (count.get(r.key.trim()) ?? 0) + 1)
  const duplicateKeys = [...count].filter(([, n]) => n > 1).map(([key]) => key)
  if (duplicateKeys.length > 0) return { duplicateKeys }
  return {
    extras: Object.fromEntries(filled.map((r) => [r.key.trim(), savedValue(r)])),
  }
}

export function ExtrasFields({ editor }: { editor: ExtrasEditor }) {
  const { rows, error, add: onAdd, remove: onRemove, update: onUpdate } = editor
  const t = useTranslations('extras')

  return (
    <Field title={t('label')} description={t('help')} error={error}>
      {rows.map((row) => (
        <div key={row.id} className="flex gap-2">
          <Input
            placeholder={t('keyPlaceholder')}
            aria-label={t('keyPlaceholder')}
            value={row.key}
            onChange={(e) => onUpdate(row.id, 'key', e.target.value)}
            className="flex-1"
          />
          <Input
            placeholder={t('valuePlaceholder')}
            aria-label={t('valuePlaceholder')}
            value={row.value}
            onChange={(e) => onUpdate(row.id, 'value', e.target.value)}
            className="flex-1"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('remove')}
            onClick={() => onRemove(row.id)}
          >
            ×
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" className="w-fit" onClick={onAdd}>
        {t('add')}
      </Button>
    </Field>
  )
}
