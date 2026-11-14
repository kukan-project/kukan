'use client'

import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@kukan/ui'
import { useTranslations } from 'next-intl'
import type {
  ColumnRoleBasis,
  ColumnRolesView,
  ColumnSettingsView,
  KeyCheck,
  ResourceColumn,
} from '@kukan/shared'
import { canIdentifyRows, sameKeyColumns } from '@kukan/shared'
import { clientFetch, readProblem } from '@/lib/client-api'
import { useProblemMessage } from '@/hooks/use-problem-message'
import { useFetch } from '@/hooks/use-fetch'
import { columnTypeKey, formatCell } from '@/lib/format-utils'
import { KEY_CELL_CLASS, KEY_HEADER_CLASS } from '@/lib/table-cells'
import { useParquetPreview } from '@/hooks/use-parquet-preview'
import { ColumnVocabularyDetails } from '@/components/resource/column-vocabulary'

/** Rows to read. Enough to see how a column's values run; few enough that the
 *  read is one row group. About five show at once, the rest scroll. */
const SAMPLE_ROWS = 20

/** How long a selection has to hold still before it is checked. Each check can
 *  scan the content, and a key is built one column at a time. */
const CHECK_DEBOUNCE_MS = 400

/**
 * The Table settings tab (ADR-072 decision 5): every column in one table, with
 * what a person decides about it — the primary key today, the settled type in
 * ii-c — held as a draft and applied once. The role beside each column is read
 * only, until roles can be overridden (ADR-063, ADR-072 Step 4).
 */
export function TableSettings({
  resourceId,
  reloadKey,
  onRunQueued,
  onDraftChange,
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
  /** Whether a key is picked that is not yet applied — the page's guard on leaving */
  onDraftChange?: (draft: boolean) => void
}) {
  const t = useTranslations('resource.columnSettings')
  const tc = useTranslations('common')
  /** The type names the public resource page uses, so a column is not called
   *  two things on two screens. */
  const tr = useTranslations('resource')
  const describeProblem = useProblemMessage()
  const [view, setView] = useState<ColumnSettingsView | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [check, setCheck] = useState<KeyCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [queued, setQueued] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // Read beside the settings, not merged with them: the roles come from the
  // profile of the live interpretation, the settings from the version, and a
  // role that cannot be read must not keep the key from being chosen
  const { data: roles, error: rolesFailed } = useFetch<ColumnRolesView>(
    `/api/v1/resources/${resourceId}/column-roles`,
    reloadKey
  )
  /** The selection as the settings spell it: no columns is no key */
  const selectedKey = selected.length > 0 ? selected : null
  const draft = !!view && !sameKeyColumns(view.primaryKey, selectedKey)
  useEffect(() => {
    onDraftChange?.(draft)
  }, [draft, onDraftChange])
  // Gone with the tab — a format that is no longer a table takes it away — the
  // draft goes too: nothing is left on the screen to apply or undo it with
  useEffect(() => () => onDraftChange?.(false), [onDraftChange])

  /** The key the selection was last reset to, which a draft is built on */
  const loadedKey = useRef<string[] | null | undefined>(undefined)
  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await clientFetch(`/api/v1/resources/${resourceId}/column-settings`, { signal })
        if (!res.ok) throw new Error(String(res.status))
        const data: ColumnSettingsView = await res.json()
        if (signal?.aborted) return
        setView(data)
        // A run landing reads the settings again. A draft built on the key the
        // server still holds is kept; one whose key moved under it is not.
        const base = loadedKey.current
        loadedKey.current = data.primaryKey
        setSelected((current) =>
          base !== undefined &&
          !sameKeyColumns(base, current.length > 0 ? current : null) &&
          sameKeyColumns(base, data.primaryKey)
            ? current
            : (data.primaryKey ?? [])
        )
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

  /**
   * The columns no key may rest on, because their type cannot identify a row
   * (`canIdentifyRows`, spec §6.4).
   *
   * Answered here rather than waited for, though the check answers it too: the
   * type is on the schema this screen already holds, and a verdict that cannot
   * change with the content should not cost a round trip — nor read as
   * something the next publication might fix.
   */
  const columns = view?.schema?.columns
  const unkeyable = useMemo(
    () => new Set((columns ?? []).filter((c) => !canIdentifyRows(c.type)).map((c) => c.name)),
    [columns]
  )
  /**
   * A selection the server will not take (400), rather than one it takes and
   * layer 2 later refuses.
   *
   * Only while the selection is pending, which is also the only shape the apply
   * refuses: a resource already keyed by such a column keeps its key, and the
   * resend that repairs a failed enqueue has to go on working.
   */
  const refused = pending && selected.some((name) => unkeyable.has(name))

  // The endpoint is built to be re-fired as the selection changes — it takes the request's
  // own signal — so the selection is checked as it is built rather than behind
  // a button. Debounced because a composite key is read out of the content, and
  // aborted because the answer to a selection that has moved on is worth
  // nothing and holds the one DuckDB slot while it lands.
  //
  // **Only a pending selection.** Checking the stored key on every open would
  // scan the content to re-derive something already recorded: what each version
  // was actually read under is on the version, and the Version history tab says so.
  useEffect(() => {
    // Nothing to ask about a key that cannot be applied: the answer is known
    // from the schema, and the scan would hold the one DuckDB slot to reach it.
    if (!pending || refused) {
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
    // `reloadKey` too: a draft kept across a run landing was checked against
    // the content before it, and the new content may break it
  }, [resourceId, pending, refused, selected, reloadKey])

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
  const answered = check && sameKeyColumns(check.primaryKey ?? null, selectedKey) ? check : null
  const fault = answered?.checked ? answered.fault : null

  async function apply() {
    setConfirming(false)
    setSaving(true)
    setError(null)
    try {
      const res = await clientFetch(`/api/v1/resources/${resourceId}/column-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ primaryKey: selectedKey }),
      })
      if (!res.ok) {
        setError(describeProblem(await readProblem(res)) ?? t('applyFailed'))
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

  const settled = !draft
  /** What the resource is set to, for the key cells to exempt. Read once rather
   *  than per column: it is the same list for all of them. */
  const storedKey = view.primaryKey ?? []
  /** The version predates the per-column counts, so nothing can be marked. */
  const noCounts = view.schema.columns.every((column) => column.distinctCount === undefined)
  /** Rows the draft moves: into or out of the key, or to another place in it */
  const schemaNames = new Set(view.schema.columns.map((column) => column.name))
  /** Key columns this version does not have (the content dropped or renamed
   *  them): drawn as rows too, or such a key could never be taken apart here */
  const absent = [...new Set([...storedKey, ...selected])].filter((name) => !schemaNames.has(name))
  const changed = [...schemaNames, ...absent].filter(
    (name) => storedKey.indexOf(name) !== selected.indexOf(name)
  ).length

  return (
    // `w-0 min-w-full`, on the whole section rather than the tables alone: a
    // box is sized from its content, so a table sixty columns wide would widen
    // the tab and the page would take the scrollbar. A declared width of zero
    // keeps the section out of that measurement, and the minimum puts it back
    // to the width it is given.
    <div className="flex w-0 min-w-full flex-col gap-4">
      {/* The advice to set a key where a column can carry one — the guide's
          caution about unstable columns is the other half — and what applying
          does (ADR-072 decision 4). The same on every resource. */}
      <p className="text-sm">{t('recommendKey')}</p>

      {/* The explanations, folded and in short lists: they are read once, and
          the table is what the tab is for. The conditional warnings stay
          outside, below it. */}
      <TableSettingsGuide />

      {/* The key as a unit. The table numbers the columns in it; with sixty of
          them, the order is not something to reconstruct by hunting for
          numbers. Always rendered, including with no key: a line that comes
          and goes moves everything under it. */}
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

      {/* What the columns actually hold, before the choice: a name does not
          say whether a column identifies a row, and the counts do not say what
          a value looks like. */}
      {view.preview === 'ready' ? (
        <ColumnSample
          // Read again when a run lands: the hook reads once per resource
          key={reloadKey}
          resourceId={resourceId}
          columns={view.schema.columns}
          selected={selected}
        />
      ) : (
        <p className="text-muted-foreground text-xs">{t(`noSample.${view.preview}`)}</p>
      )}

      <ColumnTable
        columns={view.schema.columns}
        absent={absent}
        roles={roles?.columns ?? null}
        selected={selected}
        storedKey={storedKey}
        unkeyable={unkeyable}
        onToggle={toggle}
      />
      {rolesFailed && (
        <p className="text-muted-foreground text-xs">{tr('columnRoles.loadError')}</p>
      )}

      {/* Nothing to offer candidates from. A version interpreted before the
          per-column counts existed carries none, and then every column looks
          non-unique — the absence of the mark says "this repeats" when it means
          "nobody counted". */}
      {noCounts && <p className="text-warning-tint-foreground text-xs">{t('noCounts')}</p>}
      {/* Why some columns cannot be picked, only where the table has one */}
      {unkeyable.size > 0 && (
        <p className="text-muted-foreground text-xs">{t('floatNotKeyable')}</p>
      )}

      {/* Both notes above are "the derivatives are behind", and one run repairs
          both — so one button. Not offered for `no-preview`: a resource with no
          interpretation at all may simply have not run yet. It reloads nothing
          of its own: the owner hears the run settle and moves `reloadKey`. */}
      {(noCounts || view.preview === 'preview-stale') && (
        <RebuildButton resourceId={resourceId} onRebuilt={() => onRunQueued?.()} />
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Kept in reach below a long table: the draft's count, what applying
          does, and the two ways out of it */}
      <div className="bg-background sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t py-3">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
          {changed > 0 && (
            <span className="text-warning-tint-foreground text-sm font-medium">
              {t('changes', { count: changed })}
            </span>
          )}
          <KeyStatus
            selected={selected}
            refused={refused}
            settled={settled}
            carried={view.carried}
            check={answered}
            checking={checking}
            queued={queued}
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setSelected(storedKey)
            setError(null)
          }}
          disabled={saving || settled}
        >
          {t('discard')}
        </Button>
        <Button
          size="sm"
          // A change of key is always confirmed with what it changes: it makes
          // a version (ADR-072 decision 5). The repair resend changes nothing.
          onClick={() => (settled ? apply() : setConfirming(true))}
          // While a check is out, this key has no verdict — and applying
          // without one skips a confirmation that cannot be shown afterwards:
          // the version is made, layer 2 refuses it, and nothing puts it back
          // (spec §6.6).
          //
          // Settled is not on its own a reason to stop. A setting the newest
          // version does not carry is owed a run, and the server is built to
          // let a resend queue it: the write and the enqueue are decided
          // separately there precisely so a queue that was down is repairable.
          disabled={saving || checking || refused || (settled && view.carried)}
        >
          {saving
            ? t('applying')
            : settled && !view.carried
              ? t('requeue')
              : view.primaryKey && selected.length === 0
                ? t('clear')
                : t('apply')}
        </Button>
      </div>

      {/* Before every change of key, with the change itself. A fault adds what
          it will cost: the apply is legal and the server takes it, but the
          version it makes is refused by layer 2, the reason is written once and
          never cleared (spec §6.6), and correcting the key afterwards does not
          put it in. */}
      {/* Closed once there is nothing to apply: a run landing can settle it */}
      <Dialog open={confirming && !settled} onOpenChange={(open) => !open && setConfirming(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{fault ? t('confirmTitle') : t('confirmChangeTitle')}</DialogTitle>
            <DialogDescription>
              {fault
                ? t(`fault.${fault}`)
                : selected.length === 0
                  ? t('willClear')
                  : t('willApply')}
            </DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t('before')}</dt>
            <dd className="break-all">
              {storedKey.length ? storedKey.join(' → ') : t('kindNone')}
            </dd>
            <dt className="text-muted-foreground">{t('after')}</dt>
            <dd className="break-all">{selected.length ? selected.join(' → ') : t('kindNone')}</dd>
          </dl>
          {fault && <p className="text-muted-foreground text-sm">{t('confirmCost')}</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={saving}>
              {tc('cancel')}
            </Button>
            {/* Not while the key is checked again: a run landing with the
                dialog open re-checks it against new content, and the verdict
                may turn this into a key that faults */}
            <Button onClick={apply} disabled={saving || checking}>
              {saving
                ? t('applying')
                : fault
                  ? t('confirmApply')
                  : selected.length === 0
                    ? t('clear')
                    : t('apply')}
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
  const { rows, metadata, loading, error } = useParquetPreview({
    resourceId,
    pageSize: SAMPLE_ROWS,
  })

  if (loading) return <p className="text-muted-foreground text-xs">{t('sampleLoading')}</p>
  if (error) return <p className="text-muted-foreground text-xs">{t('sampleUnavailable')}</p>
  // Its own sentence: a header with no data rows reads fine and is a key the
  // check deliberately accepts — nothing repeats in an empty table — so calling
  // it a failed read has the two halves of this screen disagreeing.
  if (rows.length === 0) {
    return <p className="text-muted-foreground text-xs">{t('sampleEmpty')}</p>
  }

  // The version's columns, not the file's: the table offers these, and a
  // preview that has drifted must not quietly add one that cannot be chosen.
  const names = columns.map((column) => column.name)

  return (
    // The scrollbars belong to the sample: one box scrolls both ways (a raw
    // <table>, as the explorer's, since the ui Table scrolls sideways in its
    // own box), and stops at the header, five rows and the sideways bar.
    <div className="flex flex-col gap-1">
      <p className="text-muted-foreground text-xs">
        {/* Counted from the file the rows came from, so the two cannot disagree */}
        {metadata && rows.length >= metadata.numRows
          ? t('sampleCaptionAll', { count: rows.length })
          : t('sampleCaption', { count: rows.length })}
      </p>
      <div className="max-h-56 overflow-auto rounded border">
        <table className="w-full text-sm">
          <TableHeader className="bg-background sticky top-0 z-10 shadow-[inset_0_-1px_0_var(--color-border)]">
            <TableRow>
              {names.map((name) => {
                const chosen = selected.includes(name)
                return (
                  <TableHead
                    key={name}
                    // `whitespace-nowrap`: a Japanese column name has no spaces,
                    // so a narrow cell wraps it one character per line and the
                    // header becomes taller than the sample it labels.
                    className={`whitespace-nowrap${chosen ? ` ${KEY_HEADER_CLASS}` : ''}`}
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
                {/* Over the columns rather than their names: the type is what
                  decides whether a value shows its time of day, and a
                  timestamp at midnight reads as a bare date without it. */}
                {columns.map((column) => (
                  <TableCell
                    key={column.name}
                    className={`whitespace-nowrap text-xs${
                      selected.includes(column.name) ? ` ${KEY_CELL_CLASS}` : ''
                    }`}
                  >
                    {formatCell(row[column.name], column.type)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </table>
      </div>
    </div>
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
  refused,
  settled,
  carried,
  check,
  checking,
  queued,
}: {
  selected: string[]
  /** The selection rests on a column whose type cannot identify a row, so the
   *  apply is blocked rather than confirmed (spec §6.4). */
  refused: boolean
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
  // reads "(none)", and the guide has already explained what a diff does without
  // a key. Only the *pending* removal needs a sentence, because that one is
  // about what the button will do.
  if (selected.length === 0) return settled ? null : line(t('willClear'))
  // Ahead of "checking", because nothing is being checked: this one is settled
  // from the type on the schema, and no answer is on its way to replace it.
  if (refused) return line(t('fault.key-float'), 'warn')
  if (checking) return line(t('checking'))
  // A fault first: it is the only thing here that says the key will not do what
  // the reader wants, and it stays true whether or not they apply it.
  if (check?.checked && check.fault) return line(t(`fault.${check.fault}`), 'warn')
  if (check && !check.checked) return line(t(`unchecked.${check.reason}`))
  if (!settled) return line(t('willApply'))
  return line(carried ? t('carried') : t('pending'))
}

/**
 * One row per column: its name, inferred type, place in the key and role.
 *
 * **Nothing here changes size when a column is picked.** The place in the key
 * sits in a slot of fixed width beside the box, so the table does not move under
 * the pointer as a key is built.
 */
function ColumnTable({
  columns,
  absent,
  roles,
  selected,
  storedKey,
  unkeyable,
  onToggle,
}: {
  columns: ResourceColumn[]
  /** Key columns this version does not have */
  absent: string[]
  roles: ColumnRolesView['columns']
  selected: string[]
  storedKey: string[]
  /** No key may rest on these columns' type. Left on the screen rather than
   *  dropped: a column that is not offered reads as one the resource does not
   *  have, and the reason is what the publisher needs to pick another. */
  unkeyable: Set<string>
  onToggle: (name: string) => void
}) {
  const t = useTranslations('resource.columnSettings')
  const tr = useTranslations('resource')
  /** The profile's entry for a column — by place, as headings can repeat, and
   *  only where the name agrees: a profile of other content says nothing here */
  const roleOf = (name: string, i: number) => (roles?.[i]?.name === name ? roles[i] : null)
  // Left out where no column has one: a site with no pack enabled reads none
  const hasVocabulary = roles?.some((r) => r.vocabulary) ?? false
  const idPrefix = useId()

  return (
    <div className="overflow-x-auto rounded border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className="bg-background sticky left-0">
              {tr('columnRoles.column')}
            </TableHead>
            <TableHead scope="col">{tr('columnRoles.type')}</TableHead>
            <TableHead scope="col">{t('title')}</TableHead>
            <TableHead scope="col">{tr('columnRoles.role')}</TableHead>
            {hasVocabulary && <TableHead scope="col">{tr('columnRoles.vocabulary')}</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {[
            ...columns.map((column, i) => ({
              name: column.name,
              column,
              role: roleOf(column.name, i),
            })),
            ...absent.map((name) => ({ name, column: null, role: null })),
          ].map(({ name, column, role }, i) => {
            const place = selected.indexOf(name)
            const placeId = `${idPrefix}-place-${i}`
            const draft = storedKey.indexOf(name) !== place
            // Not for a column the stored key already rests on: that key stands
            // (spec §6.4), so the box has to press both ways, or taking the
            // column out is a one-way door
            const blocked = unkeyable.has(name) && !storedKey.includes(name)
            return (
              <TableRow
                // By place: headings can repeat, and a repeated one is a
                // different column with its own type and role
                key={i}
                data-draft={draft || undefined}
                className="hover:bg-transparent data-[draft]:bg-warning/10 data-[draft]:hover:bg-warning/10"
              >
                <TableCell
                  className="bg-background sticky left-0 max-w-48 truncate align-top font-medium in-data-[draft]:bg-warning-surface in-data-[draft]:shadow-[inset_3px_0_0_var(--color-warning)]"
                  title={name}
                >
                  {name}
                </TableCell>
                <TableCell className="align-top">
                  {column ? (
                    <Badge variant="secondary" className="font-normal">
                      {tr(columnTypeKey(column.type))}
                    </Badge>
                  ) : (
                    <span className="text-warning-tint-foreground text-xs">
                      {t('notInVersion')}
                    </span>
                  )}
                </TableCell>
                <TableCell className="align-top">
                  {blocked ? (
                    <span className="text-muted-foreground text-xs" title={t('floatNotKeyable')}>
                      {t('notKeyable')}
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Checkbox
                        checked={place >= 0}
                        onCheckedChange={() => onToggle(name)}
                        aria-label={t('keyFor', { name })}
                        aria-describedby={place >= 0 ? placeId : undefined}
                      />
                      <span
                        id={placeId}
                        className="text-primary w-4 text-center text-xs font-bold tabular-nums"
                      >
                        {place >= 0 && (
                          <>
                            <span aria-hidden>{place + 1}</span>
                            <span className="sr-only">{t('keyPlace', { place: place + 1 })}</span>
                          </>
                        )}
                      </span>
                      {/* Identifies a row on its own, so choosing it needs no
                          check (ADR-046). Says nothing about a combination. */}
                      {column?.unique && (
                        <Badge variant="secondary" className="font-normal">
                          {t('unique')}
                        </Badge>
                      )}
                    </span>
                  )}
                </TableCell>
                <TableCell className="align-top whitespace-normal">
                  {role ? (
                    <span className="flex flex-col gap-0.5">
                      <span>
                        <Badge variant="outline">{tr(`fieldRoles.${role.role}`)}</Badge>
                      </span>
                      <RoleBasis basis={role.roleBasis} />
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                {hasVocabulary && (
                  <TableCell className="align-top whitespace-normal">
                    {role?.vocabulary ? (
                      <ColumnVocabularyDetails vocabulary={role.vocabulary} />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                )}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

/**
 * Why the rules decided a role (ADR-063 §決定 5). A `numeric-text` column also
 * shows the values that keep it from being a number — the thing to fix for
 * whoever publishes it.
 */
function RoleBasis({ basis }: { basis: ColumnRoleBasis }) {
  const t = useTranslations('resource')
  const percent = basis.share !== undefined ? Math.round(basis.share * 100) : 0
  return (
    <span className="text-muted-foreground text-xs">
      {t(`fieldRoleBasis.${basis.rule}`, { percent, hint: basis.hint ?? '' })}
      {basis.examples && basis.examples.length > 0 && (
        <> {t('fieldRoleNotNumbers', { values: basis.examples.join(t('fieldRoleSeparator')) })}</>
      )}
    </span>
  )
}

/**
 * What the primary key and the roles are, and what to keep in mind choosing a
 * key — as short lists under four headings rather than paragraphs.
 *
 * The rules are the three the ingest checks (spec §6.6), plus the one nothing
 * can check: the same row keeps its value and the value keeps its row. Breaking
 * that gives a diff that is wrong rather than absent, and nothing records a
 * reason, so it is said before the choice.
 */
function TableSettingsGuide() {
  const t = useTranslations('resource.columnSettings.guide')
  const tr = useTranslations('resource')
  const roles = (keys: string[]) =>
    keys.map((key) => tr(`fieldRoles.${key}`)).join(tr('fieldRoleSeparator'))
  const section = (title: string, items: string[], lead?: string) => (
    <section className="flex flex-col gap-1">
      <h3 className="text-xs font-semibold">{title}</h3>
      {lead && <p className="text-muted-foreground text-xs">{lead}</p>}
      <ul className="text-muted-foreground list-disc space-y-0.5 pl-5 text-xs">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  )
  return (
    <details className="rounded-md border px-3 py-2">
      <summary className="text-muted-foreground cursor-pointer text-sm">{t('summary')}</summary>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        {section(t('keyTitle'), [t('keyWhat'), t('keyDiff'), t('keyNone')])}
        {section(
          t('rulesTitle'),
          [
            t('rulePresent'),
            t('ruleNoEmpty'),
            t('ruleUnique'),
            t('ruleUniqueMark'),
            t('ruleFloat'),
          ],
          t('rulesLead')
        )}
        {section(
          t('stableTitle'),
          [t('stableRenumber'), t('stableReuse'), t('stableNone')],
          t('stableLead')
        )}
        {section(
          t('rolesTitle'),
          [
            t('rolesListed', { roles: roles(['name', 'category']) }),
            t('rolesFree', { roles: roles(['free-text']) }),
            t('rolesUnsearched', { roles: roles(['measure', 'numeric-text', 'identifier']) }),
            t('rolesOverride'),
          ],
          t('rolesLead')
        )}
      </div>
    </details>
  )
}
