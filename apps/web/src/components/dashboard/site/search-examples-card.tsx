'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from '@kukan/ui'
import { arrayMove } from '@dnd-kit/sortable'
import { SEARCH_EXAMPLE_QUERIES_MAX_ENTRIES, SEARCH_EXAMPLE_QUERY_MAX_LENGTH } from '@kukan/shared'
import { clientFetch } from '@/lib/client-api'
import { RowActions } from './row-actions'

const SETTING_KEY = 'search-example-queries'

interface Row {
  id: number
  query: string
}

/** Example-query chips shown under the search box, one row each (ADR-036) */
export function SearchExamplesCard() {
  const t = useTranslations('dashboard.adminSite')
  const tc = useTranslations('common')

  const nextId = useRef(0)
  const [loaded, setLoaded] = useState(false)
  const [rows, setRows] = useState<Row[]>([])
  const [original, setOriginal] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  function load(queries: string[]) {
    setRows(queries.map((query) => ({ id: nextId.current++, query })))
    setOriginal(JSON.stringify(queries))
  }

  useEffect(() => {
    ;(async () => {
      try {
        const res = await clientFetch('/api/v1/admin/settings')
        if (res.ok) {
          const data: Record<string, unknown> = await res.json()
          load((data[SETTING_KEY] as string[]) ?? [])
          setLoaded(true)
        }
      } catch {
        // ignore — card stays hidden
      }
    })()
  }, [])

  if (!loaded) return null

  // Trimmed and without the rows left blank (the server trims too)
  const queries = rows.map((row) => row.query.trim()).filter(Boolean)
  const dirty = JSON.stringify(queries) !== original

  function edit(update: (current: Row[]) => Row[]) {
    setRows(update)
    setSaved(false)
  }

  async function save() {
    setSaving(true)
    setSaved(false)
    try {
      const res = await clientFetch(`/api/v1/admin/settings/${SETTING_KEY}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: queries }),
      })
      if (res.ok) {
        const data: { value: string[] } = await res.json()
        load(data.value)
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
          {t('exampleQueriesDescription', {
            max: SEARCH_EXAMPLE_QUERIES_MAX_ENTRIES,
            length: SEARCH_EXAMPLE_QUERY_MAX_LENGTH,
          })}
        </p>

        {/* Frozen while saving: the response replaces every row */}
        <fieldset disabled={saving} className="contents">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('exampleQueriesEmpty')}</p>
          ) : (
            <ol className="flex max-w-2xl flex-col gap-2">
              {rows.map((row, i) => (
                <li key={row.id} className="flex items-center gap-2">
                  <Input
                    value={row.query}
                    onChange={(e) => {
                      const query = e.target.value
                      edit((current) => current.map((r) => (r.id === row.id ? { ...r, query } : r)))
                    }}
                    maxLength={SEARCH_EXAMPLE_QUERY_MAX_LENGTH}
                    aria-label={t('exampleQueriesLabel', { n: i + 1 })}
                  />
                  <RowActions
                    index={i}
                    count={rows.length}
                    onMove={(by) => edit((current) => arrayMove(current, i, i + by))}
                    onRemove={() => edit((current) => current.filter((r) => r.id !== row.id))}
                  />
                </li>
              ))}
            </ol>
          )}

          <div className="flex flex-wrap items-center gap-4">
            <Button
              variant="outline"
              onClick={() => edit((current) => [...current, { id: nextId.current++, query: '' }])}
              disabled={rows.length >= SEARCH_EXAMPLE_QUERIES_MAX_ENTRIES}
            >
              <Plus />
              {t('rowAdd')}
            </Button>
            <Button onClick={save} disabled={!dirty}>
              {tc('save')}
            </Button>
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
