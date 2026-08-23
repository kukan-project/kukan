'use client'

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@kukan/ui'
import { useTranslations } from 'next-intl'
import type { ColumnSettingsView, KeyCheck, ResourceColumn } from '@kukan/shared'
import { sameKeyColumns } from '@kukan/shared'
import { clientFetch, problemDetail } from '@/lib/client-api'
import { columnTypeKey, formatCell } from '@/lib/format-utils'
import { useParquetPreview } from '@/hooks/use-parquet-preview'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@kukan/ui'

/** Rows to show. Enough to see whether a column repeats; few enough that the
 *  read is one row group and the table does not become the screen. */
const SAMPLE_ROWS = 5

/** How long a selection has to hold still before it is checked. Each check can
 *  scan the content, and a key is built one column at a time. */
const CHECK_DEBOUNCE_MS = 400

export function PrimaryKeyPicker({
  resourceId,
  reloadKey,
  onRunQueued,
}: {
  resourceId: string
  /** Any change re-reads the settings. The owner passes whatever tells it a run
   *  landed: a version stored is when `carried` stops being false, and a
   *  rebuild that stored none is when the counts and the preview this offers
   *  were rewritten under the standing one. */
  reloadKey?: number | string
  /**
   * Called when settling a key — or the repair button — put a run on the queue.
   *
   * Not "a key was applied": what the owner does with it is watch the run, and
   * an apply that queued nothing has nothing to watch. The version this screen
   * is waiting for is minutes away and arrives by way of the owner's own
   * refresh, so this is the only thing that starts it.
   */
  onRunQueued?: () => void
}) {
  const t = useTranslations('resource.columnSettings')
  const tc = useTranslations('common')
  /** The type names the public resource page uses, so a column is not called
   *  two things on two screens. */
  const tr = useTranslations('resource')
  const [view, setView] = useState<ColumnSettingsView | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [check, setCheck] = useState<KeyCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [queued, setQueued] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await clientFetch(`/api/v1/resources/${resourceId}/column-settings`, { signal })
        if (!res.ok) throw new Error(String(res.status))
        const data: ColumnSettingsView = await res.json()
        if (signal?.aborted) return
        setView(data)
        setSelected(data.primaryKey ?? [])
      } catch {
        if (!signal?.aborted) setLoadError(true)
      }
    },
    [resourceId]
  )

  // Re-read on `reloadKey` as well as on mount: a run landing is what settles
  // `carried`, and the announcement of the run that has now landed is spent —
  // left up, "a rebuild is queued" would outlive the rebuild.
  const loaded = useRef(false)
  useEffect(() => {
    const controller = new AbortController()
    if (loaded.current) setQueued(null)
    loaded.current = true
    void load(controller.signal)
    return () => controller.abort()
  }, [load, reloadKey])

  /** A selection that is not yet what the resource is set to. */
  const pending = selected.length > 0 && !sameKeyColumns(view?.primaryKey ?? null, selected)

  // The endpoint is built to be re-fired by a picker — it takes the request's
  // own signal — so the selection is checked as it is built rather than behind
  // a button. Debounced because a composite key is read out of the content, and
  // aborted because the answer to a selection that has moved on is worth
  // nothing and holds the one DuckDB slot while it lands.
  //
  // **Only a pending selection.** Checking the stored key on every open would
  // scan the content to re-derive something already recorded: what each version
  // was actually read under is on the version, and the history below says so.
  useEffect(() => {
    if (!pending) {
      setCheck(null)
      setChecking(false)
      return
    }
    const controller = new AbortController()
    setChecking(true)
    const timer = setTimeout(async () => {
      try {
        const res = await clientFetch(`/api/v1/resources/${resourceId}/column-settings/check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ primaryKey: selected }),
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(String(res.status))
        const data: KeyCheck = await res.json()
        if (!controller.signal.aborted) setCheck(data)
      } catch {
        // Leaves the last answer rather than claiming one: the apply does not
        // depend on this, and a failed check must not read as a verdict.
        if (!controller.signal.aborted) setCheck(null)
      } finally {
        if (!controller.signal.aborted) setChecking(false)
      }
    }, CHECK_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [resourceId, pending, selected])

  /** Append or remove, keeping the order columns were picked in: a composite
   *  key is its columns *in that order* (spec §6.2). */
  function toggle(name: string) {
    setQueued(null)
    setError(null)
    setSelected((current) =>
      current.includes(name) ? current.filter((c) => c !== name) : [...current, name]
    )
  }

  /**
   * The check, but only where it is about what is selected *now*.
   *
   * The effect leaves the last answer up while the next one is in flight, which
   * `KeyStatus` handles by saying "checking" — but a verdict is not a caption.
   * Read without this, the confirmation warns about the key before last, and in
   * the window before the first answer lands there is no verdict at all and the
   * apply goes straight through the gate that exists to stop it.
   */
  const answered =
    check && sameKeyColumns(check.primaryKey ?? null, selected.length > 0 ? selected : null)
      ? check
      : null
  const fault = answered?.checked ? answered.fault : null

  async function apply() {
    setConfirming(false)
    setSaving(true)
    setError(null)
    try {
      const res = await clientFetch(`/api/v1/resources/${resourceId}/column-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ primaryKey: selected.length > 0 ? selected : null }),
      })
      if (!res.ok) {
        setError((await problemDetail(res)) ?? t('applyFailed'))
        return
      }
      const data: { queued: boolean | null } = await res.json()
      setQueued(data.queued)
      await load()
      // Only where a run was actually queued: `null` is "nothing to rebuild, or
      // a run is already on its way", and the second of those was announced by
      // whatever started it.
      if (data.queued) onRunQueued?.()
    } catch {
      setError(t('applyFailed'))
    } finally {
      setSaving(false)
    }
  }

  if (loadError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{t('loadError')}</AlertDescription>
      </Alert>
    )
  }
  if (!view) return <p className="text-muted-foreground text-sm">{t('loading')}</p>
  // Length checked too: `[].every(…)` is true, so a version that interpreted to
  // no columns at all — an empty CSV, or one wider than the cap — would fall
  // through to the note about counts and be offered a rebuild that reaches the
  // same answer every time (`interpret/version.ts`).
  if (!view.schema || view.schema.columns.length === 0) {
    return <p className="text-muted-foreground text-sm">{t('noColumns')}</p>
  }

  const settled = sameKeyColumns(view.primaryKey, selected.length > 0 ? selected : null)
  /** The version predates the per-column counts, so nothing can be marked. */
  const noCounts = view.schema.columns.every((column) => column.distinctCount === undefined)

  return (
    // `w-0 min-w-full`, on the whole section rather than the sample alone: this
    // renders inside a `<td>`, and a table cell is sized from its content, so
    // anything in here that cannot shrink sets the width of the resource list
    // and the page takes the scrollbar. A declared width of zero keeps the
    // section out of that measurement, and the minimum puts it back to the
    // cell's width — which is what finally gives `max-w-full` below something
    // definite to resolve against.
    <div className="flex w-0 min-w-full flex-col gap-3">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{t('title')}</p>
        <p className="text-muted-foreground text-xs">{t('help')}</p>
        {/* The three the ingest actually checks (spec §6.6), said before the
            choice rather than after it: they are the whole of what makes a
            column pickable, and the `unique` mark answers all three at once for
            the single-column case. */}
        <p className="text-muted-foreground text-xs">{t('requirements')}</p>
        {/* The condition nothing enforces, and it has two halves: the same row
            keeps its value, and the value keeps its row. The three above are
            about one version, and the ingest refuses when they are broken; this
            one is about the sequence of versions, and breaking it produces a
            diff that is wrong rather than absent. Reassignment shows unchanged
            rows as removed and re-added; reuse is worse, because two unrelated
            things are then reported as one row that changed. Neither records a
            reason — the ingest succeeded (spec §6.6).
            Hence the advice at the end: with no key an edit reads as a removal
            and an addition, which is the same answer reassignment degrades to
            anyway, and it never asserts that two things are one row. Absent
            beats wrong. */}
        <p className="text-muted-foreground text-xs">{t('stability')}</p>
      </div>

      {/* The key as a unit. The chips say which columns are in it; with sixty of
          them, the order is not something to reconstruct by hunting for
          numbers. It is also the only reason the order is worth showing at all
          — reordering compares the same but costs a version.
          Always rendered, including with no key: a line that comes and goes
          moves everything under it each time a key is emptied or begun. */}
      <div className="flex flex-wrap items-center gap-1 text-sm">
        <span className="text-muted-foreground">{t('current')}</span>
        {selected.map((name, i) => (
          <Fragment key={name}>
            {i > 0 && <span className="text-muted-foreground">→</span>}
            <Badge variant="secondary" className="max-w-full min-w-0 font-normal" title={name}>
              <span className="truncate">{name}</span>
            </Badge>
          </Fragment>
        ))}
        {/* Which of the three states this is, named rather than counted: a
            composite key is the one whose uniqueness the frozen counts cannot
            answer, so it is worth being able to see at a glance which one is
            being built. */}
        <span className="text-muted-foreground">
          {t(
            selected.length === 0
              ? 'kindNone'
              : selected.length === 1
                ? 'kindSingle'
                : 'kindComposite'
          )}
        </span>
      </div>

      <div className="flex min-w-0 flex-wrap gap-1">
        {view.schema.columns.map((column) => (
          <ColumnToggle
            key={column.name}
            column={column}
            chosen={selected.includes(column.name)}
            uniqueLabel={t('unique')}
            typeLabel={(type) => tr(columnTypeKey(type))}
            onToggle={() => toggle(column.name)}
          />
        ))}
      </div>

      {/* Nothing to offer candidates from. A version interpreted before the
          per-column counts existed carries none, and then every column looks
          non-unique — the absence of the mark says "this repeats" when it means
          "nobody counted". Said once here rather than per column. */}
      {noCounts && <p className="text-warning-tint-foreground text-xs">{t('noCounts')}</p>}

      {/* What the columns actually hold. A name does not say whether a column
          identifies a row, and the counts beside it do not say what a value
          looks like — which is what tells someone that two columns together are
          the key and one of them alone is not. */}
      {view.preview === 'ready' ? (
        <ColumnSample resourceId={resourceId} columns={view.schema.columns} selected={selected} />
      ) : (
        <p className="text-muted-foreground text-xs">{t(`noSample.${view.preview}`)}</p>
      )}

      {/* Both notes above are "the derivatives are behind", and one run repairs
          both — so one button, however many of them are showing. A control per
          condition puts two identical buttons on the screen. Not offered for
          `no-preview`: a resource with no interpretation at all may simply have
          not run yet, and a remedy there names a fault that is not one.
          It reloads nothing of its own: the run has only been queued, and what
          it repairs is written minutes later — usually over the standing
          version, with no new one to notice. The owner hears that it settled
          and moves `reloadKey`. */}
      {(noCounts || view.preview === 'preview-stale') && (
        <RebuildButton resourceId={resourceId} onRebuilt={() => onRunQueued?.()} />
      )}

      <KeyStatus
        selected={selected}
        settled={settled}
        carried={view.carried}
        check={answered}
        checking={checking}
        queued={queued}
      />

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div>
        <Button
          size="sm"
          // Through the confirmation when the key is known not to work: the
          // apply is legal and the server takes it, but what it costs is not
          // visible from a button (see the dialog).
          onClick={() => (fault ? setConfirming(true) : apply())}
          // While a check is out, this key has no verdict — and applying
          // without one skips a confirmation that cannot be shown afterwards:
          // the version is made, layer 2 refuses it, and nothing puts it back
          // (spec §6.6).
          //
          // Settled is not on its own a reason to stop. A setting the newest
          // version does not carry is owed a run, and the server is built to
          // let a resend queue it: the write and the enqueue are decided
          // separately there precisely so a queue that was down is repairable.
          // Disabled on `settled` alone, a failed enqueue left the resource
          // with a key nothing would ever read it under, and no way back from
          // this screen.
          disabled={saving || checking || (settled && view.carried)}
        >
          {saving
            ? t('applying')
            : // The repair reads as what it does. Ordinarily this is also the
              // few minutes between an apply and its run landing, where it says
              // the same true thing and the server no-ops a resend.
              settled && !view.carried
              ? t('requeue')
              : // "Remove" only where there is one to remove: with no key set and
                // nothing picked, applying would do nothing, and offering to clear
                // names something that is not there.
                view.primaryKey && selected.length === 0
                ? t('clear')
                : t('apply')}
        </Button>
      </div>

      {/* Not a block. The check is about the content that is live now, and the
          version this setting reaches carries whatever arrives next — a
          publisher fixing their data, or an external URL that changes. What it
          is not allowed to be is silent: the version this creates is refused by
          layer 2, the reason is written once and never cleared (spec §6.6), and
          correcting the key afterwards does not put it in. There is no entry
          point for re-ingesting a refused version today. */}
      <Dialog open={confirming} onOpenChange={(open) => !open && setConfirming(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('confirmTitle')}</DialogTitle>
            <DialogDescription>{fault ? t(`fault.${fault}`) : ''}</DialogDescription>
          </DialogHeader>
          <p className="text-muted-foreground text-sm">{t('confirmCost')}</p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={saving}>
              {tc('cancel')}
            </Button>
            <Button onClick={apply} disabled={saving}>
              {saving ? t('applying') : t('confirmApply')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * Queue the rebuild that re-reads the object the resource already holds.
 *
 * Two things on this screen are repaired by the same run — a preview describing
 * the previous content, and a version whose interpretation predates the
 * per-column counts — so it is one control rather than two that drift.
 */
function RebuildButton({ resourceId, onRebuilt }: { resourceId: string; onRebuilt: () => void }) {
  const t = useTranslations('resource.columnSettings')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [sent, setSent] = useState(false)

  async function rebuild() {
    setBusy(true)
    setFailed(false)
    setSent(false)
    try {
      const res = await clientFetch(`/api/v1/resources/${resourceId}/run-pipeline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The repair, not a run: the content is already published and only its
        // interpretation is behind, so nothing is re-fetched (ADR-044 §4).
        body: JSON.stringify({ rebuildOnly: true }),
      })
      // `fetch` resolves on a 500, so a non-OK response has to be read or a
      // rebuild that never ran reads as one that did. The body has to be read
      // too: the enqueue reports rather than throws, so `queued: false` is a
      // 200 that queued nothing.
      if (!res.ok) throw new Error(String(res.status))
      const { queued }: { queued: boolean | null } = await res.json()
      if (queued === false) throw new Error('not queued')
      // Queued, not done. Said out loud because the note below it does not
      // move: the run is minutes away, and a button that changes nothing reads
      // as one that did nothing.
      setSent(true)
      onRebuilt()
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={rebuild} disabled={busy}>
        {busy ? t('rebuilding') : t('rebuild')}
      </Button>
      {sent && <p className="text-muted-foreground text-xs">{t('rebuildQueued')}</p>}
      {failed && <p className="text-destructive text-xs">{t('rebuildFailed')}</p>}
    </>
  )
}

/**
 * A few rows of what the resource is serving, with the chosen columns marked in
 * the order they were picked.
 *
 * Read straight off the interpretation's Parquet over Range requests — the
 * footer and one row group — rather than through a query: this is a peek beside
 * a form, and the one server-side DuckDB slot is already being spent on the key
 * check that runs as the selection changes.
 *
 * **A sample proves nothing about uniqueness**, and is not offered as evidence:
 * five distinct values say nothing about the sixth. The check answers that, over
 * every row. This answers what the values *are*.
 */
function ColumnSample({
  resourceId,
  columns,
  selected,
}: {
  resourceId: string
  columns: ResourceColumn[]
  selected: string[]
}) {
  const t = useTranslations('resource.columnSettings')
  const { rows, loading, error } = useParquetPreview({ resourceId, pageSize: SAMPLE_ROWS })

  if (loading) return <p className="text-muted-foreground text-xs">{t('sampleLoading')}</p>
  if (error) return <p className="text-muted-foreground text-xs">{t('sampleUnavailable')}</p>
  // Its own sentence: a header with no data rows reads fine and is a key the
  // check deliberately accepts — nothing repeats in an empty table — so calling
  // it a failed read has the two halves of this screen disagreeing.
  if (rows.length === 0) {
    return <p className="text-muted-foreground text-xs">{t('sampleEmpty')}</p>
  }

  // The version's columns, not the file's: the picker offers these, and a
  // preview that has drifted must not quietly add one that cannot be chosen.
  const names = columns.map((column) => column.name)

  return (
    // `w-0 min-w-full`: the editor is rendered inside a `<td>`, and a table cell
    // is sized from its content — so an `overflow-x-auto` that is as wide as
    // sixty columns widens the cell, then the resource list, then the page. A
    // declared width of zero contributes nothing to that measurement, and the
    // minimum puts the box back to the cell's width once the cell has one. The
    // scrollbar then belongs to the sample rather than to the screen.
    <div className="overflow-x-auto rounded border">
      <Table>
        <TableHeader>
          <TableRow>
            {names.map((name) => {
              const chosen = selected.includes(name)
              return (
                <TableHead
                  key={name}
                  // `whitespace-nowrap`: a Japanese column name has no spaces,
                  // so a narrow cell wraps it one character per line and the
                  // header becomes taller than the sample it labels.
                  // A tint of the brand colour, not of `muted`: the row's own
                  // hover is `bg-muted/50`, so a muted mark on a muted wash is
                  // the same shade twice and the key stops being visible
                  // exactly while someone is reading a row.
                  className={`whitespace-nowrap${chosen ? ' bg-primary/15 text-foreground' : ''}`}
                  scope="col"
                >
                  {name}
                </TableHead>
              )
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            // No hover: these rows are a sample, not a list of things to pick,
            // and the only reason to tell them apart is the key marking.
            <TableRow key={i} className="hover:bg-transparent">
              {names.map((name) => (
                <TableCell
                  key={name}
                  className={`whitespace-nowrap text-xs${
                    selected.includes(name) ? ' bg-primary/10' : ''
                  }`}
                >
                  {formatCell(row[name])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/**
 * One column, in or out of the key.
 *
 * **Nothing here changes size when it is picked.** A chip that grows by a
 * number reflows every chip after it, so the list moves under the pointer as it
 * is built. Which columns are in the key is carried by the fill; what order
 * they are in is carried by the line above, where it can be read at a glance.
 */
function ColumnToggle({
  column,
  chosen,
  uniqueLabel,
  typeLabel,
  onToggle,
}: {
  column: ResourceColumn
  chosen: boolean
  uniqueLabel: string
  typeLabel: (type: ResourceColumn['type']) => string
  onToggle: () => void
}) {
  return (
    <Button
      type="button"
      variant={chosen ? 'default' : 'outline'}
      size="sm"
      aria-pressed={chosen}
      // A column name is arbitrary text out of a CSV header, and where the
      // delimiter was not found there is one column named after the whole line.
      // All three are needed: the button base sets `shrink-0`, a flex item's
      // `min-width: auto` holds it at its content width even then, and the
      // maximum is what the truncation acts on.
      className="max-w-full min-w-0 shrink justify-start font-normal"
      title={column.name}
      onClick={onToggle}
    >
      <span className="truncate">{column.name}</span>
      {/* The type, in the `name (type)` form the diff panel uses two components
          over. Inferred (ADR-029), which is every type this codebase has today
          — ii-c gives a person somewhere to settle one, and this reads that
          instead where it is set. Shown because a name and a few sample values
          do not always separate a date from the string of one, or a code that
          has leading zeros from a number that lost them. */}
      <span className="text-muted-foreground ml-1 text-xs font-normal">
        ({typeLabel(column.type)})
      </span>
      {/* Identifies a row on its own, so choosing it needs no check (ADR-046).
          Says nothing about a combination, so it is not shown as a verdict. */}
      {column.unique && (
        <Badge variant="secondary" className="ml-1 font-normal">
          {uniqueLabel}
        </Badge>
      )}
    </Button>
  )
}

/**
 * What the current selection means, in one line.
 *
 * Four things can be true at once — the selection differs from what is stored,
 * the stored key has not reached a version, the check has an opinion, an apply
 * just queued a rebuild — and only one of them is worth a sentence. They are
 * ordered by what the reader would do next.
 */
function KeyStatus({
  selected,
  settled,
  carried,
  check,
  checking,
  queued,
}: {
  selected: string[]
  settled: boolean
  carried: boolean
  check: KeyCheck | null
  checking: boolean
  queued: boolean | null
}) {
  const t = useTranslations('resource.columnSettings')
  const line = (text: string, tone?: 'warn') => (
    <p className={tone === 'warn' ? 'text-warning-tint-foreground text-sm' : 'text-sm'}>{text}</p>
  )

  // What the last apply did comes first, and it is the one thing here that is
  // about an action rather than a state: it is cleared the moment the selection
  // moves. Below the empty-selection branch it would be unreachable for a
  // *removal* — that leaves nothing selected and nothing stored, so the branch
  // returns before it and clearing a key would report nothing at all.
  //
  // `false` is the enqueue having failed, not "nothing needed queueing" —
  // `null` is that, and it falls through to the state that is now true. The
  // setting is saved and no run will carry it, so this is the one outcome of an
  // apply that leaves something to do, and the button below says what.
  if (queued !== null) return queued ? line(t('queued')) : line(t('queueFailed'), 'warn')
  // Nothing selected and nothing stored says itself, twice over: the line above
  // reads "(none)", and the help has already explained what a diff does without
  // a key. Only the *pending* removal needs a sentence, because that one is
  // about what the button will do.
  if (selected.length === 0) return settled ? null : line(t('willClear'))
  if (checking) return line(t('checking'))
  // A fault first: it is the only thing here that says the key will not do what
  // the reader wants, and it stays true whether or not they apply it.
  if (check?.checked && check.fault) return line(t(`fault.${check.fault}`), 'warn')
  if (check && !check.checked) return line(t(`unchecked.${check.reason}`))
  if (!settled) return line(t('willApply'))
  return line(carried ? t('carried') : t('pending'))
}
