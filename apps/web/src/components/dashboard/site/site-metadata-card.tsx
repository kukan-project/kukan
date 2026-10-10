'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kukan/ui'
import {
  SITE_METADATA_KEY_PATTERN,
  SITE_METADATA_MAX_ENTRIES,
  type SiteMetadataEntry,
} from '@kukan/shared'
import { clientFetch } from '@/lib/client-api'
import { arrayMove } from '@dnd-kit/sortable'
import { RowActions } from './row-actions'

const SETTING_KEY = 'site-metadata'
/**
 * Shared by the column headings and the rows so they line up. Columns by the
 * card's width, not the viewport's: beside the dashboard sidebar a tablet-wide
 * screen leaves the value column nothing after the fixed ones.
 */
const ROW_GRID =
  'grid gap-2 @3xl/metadata:grid-cols-[12rem_10rem_minmax(0,1fr)_auto] @3xl/metadata:items-start'

/** What the admin picks; a per-locale text is stored as a `text` entry with a map */
const ROW_KINDS = ['number', 'text', 'localized', 'date'] as const
type RowKind = (typeof ROW_KINDS)[number]

interface Row {
  id: number
  key: string
  kind: RowKind
  /** The value as typed, per kind, so switching the kind back keeps it */
  number: string
  text: string
  /** undefined = the language is not given, which differs from an empty string */
  ja: string | undefined
  en: string | undefined
  date: string
}

const blank = { number: '', text: '', ja: undefined, en: undefined, date: '' }

function toRow(entry: SiteMetadataEntry, id: number): Row {
  const row: Row = { id, key: entry.key, kind: entry.type, ...blank }
  switch (entry.type) {
    case 'number':
      return { ...row, number: String(entry.value) }
    case 'date':
      return { ...row, date: entry.value }
    case 'text':
      return typeof entry.value === 'string'
        ? { ...row, text: entry.value }
        : { ...row, kind: 'localized', ja: entry.value.ja, en: entry.value.en }
  }
}

/** The entry a row saves as, or null when it cannot be saved yet */
function toEntry(row: Row): SiteMetadataEntry | null {
  const key = row.key.trim()
  if (!SITE_METADATA_KEY_PATTERN.test(key)) return null
  switch (row.kind) {
    case 'number': {
      const value = Number(row.number.trim())
      return row.number.trim() !== '' && Number.isFinite(value)
        ? { key, type: 'number', value }
        : null
    }
    case 'date':
      return row.date ? { key, type: 'date', value: row.date } : null
    case 'text':
      return { key, type: 'text', value: row.text }
    case 'localized': {
      // Kept as stored: saving another row must not rewrite this one
      const value = {
        ...(row.ja !== undefined && { ja: row.ja }),
        ...(row.en !== undefined && { en: row.en }),
      }
      return Object.keys(value).length > 0 ? { key, type: 'text', value } : null
    }
  }
}

/**
 * Site-wide values brands and pages read by key (ADR-064). The core gives the
 * keys no meaning, so the card checks only what the server checks: the key's
 * form, its uniqueness, and that each value fits its type.
 */
export function SiteMetadataCard() {
  const t = useTranslations('dashboard.adminSite')
  const tc = useTranslations('common')

  const nextId = useRef(0)
  const [loaded, setLoaded] = useState(false)
  const [rows, setRows] = useState<Row[]>([])
  const [original, setOriginal] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function load(entries: SiteMetadataEntry[]) {
    setRows(entries.map((entry) => toRow(entry, nextId.current++)))
    // Through the rows and back, so a stored map's key order reads as unchanged
    setOriginal(JSON.stringify(entries.map((entry, i) => toEntry(toRow(entry, i)))))
  }

  useEffect(() => {
    ;(async () => {
      try {
        const res = await clientFetch('/api/v1/admin/settings')
        if (res.ok) {
          const data: Record<string, unknown> = await res.json()
          load((data[SETTING_KEY] as SiteMetadataEntry[]) ?? [])
          setLoaded(true)
        }
      } catch {
        // ignore — card stays hidden
      }
    })()
  }, [])

  if (!loaded) return null

  const entries = rows.map(toEntry)
  const keyCounts = new Map<string, number>()
  for (const row of rows) {
    const key = row.key.trim()
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1)
  }
  const invalid = rows.map(
    (row, i) => entries[i] === null || (keyCounts.get(row.key.trim()) ?? 0) > 1
  )
  const hasInvalid = invalid.some(Boolean)
  const dirty = JSON.stringify(entries) !== original

  /** Every edit goes through here, so each one clears the last save's outcome */
  function edit(change: (current: Row[]) => Row[]) {
    setRows(change)
    setSaved(false)
    setError(null)
  }

  function update(id: number, patch: Partial<Row>) {
    edit((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }

  async function save() {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const res = await clientFetch(`/api/v1/admin/settings/${SETTING_KEY}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: entries }),
      })
      if (res.ok) {
        const data: { value: SiteMetadataEntry[] } = await res.json()
        load(data.value)
        setSaved(true)
      } else {
        const problem = await res.json().catch(() => null)
        setError(t('metadataSaveFailed', { detail: problem?.detail ?? res.status }))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('metadataTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="@container/metadata flex flex-col gap-4">
        <div className="flex flex-col gap-1 text-sm text-muted-foreground">
          <p>{t('metadataDescription', { max: SITE_METADATA_MAX_ENTRIES })}</p>
          <p>{t('metadataKeyHelp')}</p>
          <p>{t('metadataPublic')}</p>
          <p>{t('metadataDelay')}</p>
        </div>

        {/* Frozen while saving: the response replaces every row, so an edit
            made in between would be dropped and then reported as saved */}
        <fieldset disabled={saving} className="contents">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('metadataEmpty')}</p>
          ) : (
            <>
              {/* Headings, so a filled field never has to tell its column by a
                placeholder. A narrow card stacks the fields under their own labels */}
              <div
                aria-hidden
                className={`${ROW_GRID} hidden border border-transparent px-2 text-sm font-medium @3xl/metadata:grid`}
              >
                <span>{t('metadataKey')}</span>
                <span>{t('metadataType')}</span>
                <span>{t('metadataValue')}</span>
              </div>
              <ul className="flex flex-col gap-3">
                {rows.map((row, i) => (
                  <li
                    key={row.id}
                    className={`${ROW_GRID} rounded-md border p-2`}
                    aria-invalid={invalid[i] || undefined}
                  >
                    <div className="flex flex-col gap-1">
                      <StackedLabel>{t('metadataKey')}</StackedLabel>
                      <Input
                        value={row.key}
                        onChange={(e) => update(row.id, { key: e.target.value })}
                        aria-label={t('metadataKey')}
                        aria-invalid={invalid[i] || undefined}
                        className="font-mono"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <StackedLabel>{t('metadataType')}</StackedLabel>
                      <Select
                        value={row.kind}
                        onValueChange={(value) => update(row.id, { kind: value as RowKind })}
                      >
                        <SelectTrigger className="w-full" aria-label={t('metadataType')}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ROW_KINDS.map((kind) => (
                            <SelectItem key={kind} value={kind}>
                              {t(`metadataKind.${kind}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-col gap-2">
                      <StackedLabel>{t('metadataValue')}</StackedLabel>
                      <ValueInput row={row} onChange={(patch) => update(row.id, patch)} />
                    </div>
                    <RowActions
                      index={i}
                      count={rows.length}
                      onMove={(by) => edit((current) => arrayMove(current, i, i + by))}
                      onRemove={() => edit((current) => current.filter((r) => r.id !== row.id))}
                    />
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="flex flex-wrap items-center gap-4">
            <Button
              variant="outline"
              onClick={() =>
                edit((current) => [
                  ...current,
                  { id: nextId.current++, key: '', kind: 'number', ...blank },
                ])
              }
              disabled={rows.length >= SITE_METADATA_MAX_ENTRIES}
            >
              <Plus />
              {t('rowAdd')}
            </Button>
            <Button onClick={save} disabled={!dirty || hasInvalid}>
              {tc('save')}
            </Button>
            {hasInvalid && <span className="text-sm text-destructive">{t('metadataInvalid')}</span>}
            {error && (
              <span role="alert" className="text-sm text-destructive">
                {error}
              </span>
            )}
            {saved && (
              <span role="status" className="text-sm text-muted-foreground">
                {t('saved')}
              </span>
            )}
          </div>
        </fieldset>
      </CardContent>
    </Card>
  )
}

function ValueInput({ row, onChange }: { row: Row; onChange: (patch: Partial<Row>) => void }) {
  const t = useTranslations('dashboard.adminSite')
  const label = t('metadataValue')
  switch (row.kind) {
    case 'number':
      return (
        <Input
          value={row.number}
          onChange={(e) => onChange({ number: e.target.value })}
          inputMode="decimal"
          aria-label={label}
        />
      )
    case 'date':
      return (
        <Input
          type="date"
          value={row.date}
          onChange={(e) => onChange({ date: e.target.value })}
          aria-label={label}
          className="w-48"
        />
      )
    case 'text':
      return (
        <Input
          value={row.text}
          onChange={(e) => onChange({ text: e.target.value })}
          aria-label={label}
        />
      )
    case 'localized':
      return (
        <>
          {(['ja', 'en'] as const).map((locale) => (
            // The language stays in view once the field is filled, unlike a placeholder
            <InputGroup key={locale}>
              <InputGroupAddon>
                <InputGroupText className="w-16">{t(`metadataLocale.${locale}`)}</InputGroupText>
              </InputGroupAddon>
              <InputGroupInput
                value={row[locale] ?? ''}
                // Clearing a field drops the language rather than storing ''
                onChange={(e) => onChange({ [locale]: e.target.value || undefined })}
                aria-label={`${label} (${t(`metadataLocale.${locale}`)})`}
              />
            </InputGroup>
          ))}
        </>
      )
  }
}

/** A field's name above it while the card is too narrow for the column headings */
function StackedLabel({ children }: { children: React.ReactNode }) {
  // Hidden from assistive tech: each field carries the same name as its aria-label
  return (
    <span aria-hidden className="text-xs font-medium text-muted-foreground @3xl/metadata:hidden">
      {children}
    </span>
  )
}
