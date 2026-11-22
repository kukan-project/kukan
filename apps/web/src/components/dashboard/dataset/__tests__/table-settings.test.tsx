import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import {
  useSettledEstimate,
  useSettledEstimateState,
  type SettledEstimate,
} from '@/hooks/use-settled-estimate'
import { TableSettings } from '../table-settings'

vi.mock('@/lib/client-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/client-api')>()),
  clientFetch: vi.fn(),
}))

const mockClientFetch = vi.mocked(clientFetch)

// DuckDB-WASM does not run here; the estimate's rules are tested in @kukan/lake
vi.mock('@/hooks/use-settled-estimate', () => ({
  useSettledEstimate: vi.fn(() => null),
  useSettledEstimateState: vi.fn(),
}))
const mockEstimate = vi.mocked(useSettledEstimate)
const mockEstimateState = vi.mocked(useSettledEstimateState)
/** What reading numbers written as text found, where it could not read them */
const NO_FRACTIONS_READ = { estimate: null, failed: true }
/** An estimate once a type is changed, as the hook gives none before */
const estimateOnceTyped = (estimate: Omit<SettledEstimate, 'judge'>) =>
  mockEstimate.mockImplementation(({ types }) =>
    Object.keys(types).length > 0 ? { ...estimate, judge: async () => new Set<string>() } : null
  )

/** The box that puts a column in the key, or takes it out */
const keyBox = (name: string) =>
  screen.getByRole('checkbox', { name: `Use ${name} in the primary key` })

/** The row of a column, found by its name cell */
const rowOf = (name: string) =>
  screen
    .getAllByTitle(name)
    .find((el) => el.tagName === 'TD')!
    .closest('tr')!

/** Apply from the bar, and confirm the change of key the dialog names */
function applyKey(confirm = 'Apply') {
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: confirm }))
}

const json = (data: unknown) => ({ ok: true, json: async () => data }) as Response

function settings(overrides: Partial<Record<string, unknown>> = {}) {
  return json({
    id: 'r1',
    primaryKey: null,
    carried: true,
    rolesCarried: true,
    preview: 'ready',
    schema: {
      rowCount: 2,
      columns: [
        {
          name: 'order',
          type: 'string',
          nullable: false,
          nullCount: 0,
          distinctCount: 2,
          unique: true,
        },
        {
          name: 'line',
          type: 'string',
          nullable: false,
          nullCount: 0,
          distinctCount: 1,
          unique: false,
        },
      ],
    },
    ...overrides,
  })
}

/**
 * Routes each call by URL and method, so the order they fire in does not
 * matter — and lets an apply change what the next read returns, which is what
 * makes the post-apply state testable at all.
 */
function route(handlers: {
  get?: Record<string, unknown>
  check?: Response | (() => Response)
  put?: Response
  roles?: Response
}) {
  let stored = handlers.get ?? {}
  mockClientFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/column-roles')) return handlers.roles ?? json({ columns: null })
    if (path.endsWith('/column-settings/check')) {
      const c = handlers.check
      // The default echoes the key it was asked about, as the route does: the
      // screen only trusts an answer that names the current selection.
      const asked = JSON.parse(init!.body as string) as { primaryKey: string[] | null }
      return (
        (typeof c === 'function' ? c() : c) ??
        json({ checked: true, primaryKey: asked.primaryKey, fault: null })
      )
    }
    if (path.endsWith('/run-pipeline')) return json({ queued: true })
    if (init?.method === 'PUT') {
      const body = JSON.parse(init.body as string) as {
        primaryKey: string[] | null
        roles?: Record<string, string> | null
        types?: Record<string, string> | null
      }
      stored = {
        ...stored,
        primaryKey: body.primaryKey,
        roles: body.roles ?? null,
        types: body.types ?? null,
        carried: false,
      }
      return handlers.put ?? json({ primaryKey: body.primaryKey, queued: true })
    }
    return settings(stored)
  })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  mockClientFetch.mockReset()
  mockEstimate.mockReset()
  mockEstimate.mockReturnValue(null)
  mockEstimateState.mockReset()
  mockEstimateState.mockReturnValue(NO_FRACTIONS_READ)
})

afterEach(() => {
  vi.useRealTimers()
})

/** Lets the debounce elapse and the check settle. */
async function afterCheck() {
  await vi.advanceTimersByTimeAsync(500)
}

describe('TableSettings', () => {
  it('numbers the key in the order columns were picked, and reads it as one line', async () => {
    // The place sits in a slot of its own, so a row does not move under the
    // pointer as the key is built; with sixty columns the line says the order
    route({})
    render(<TableSettings resourceId="r1" />)

    await waitFor(() => expect(keyBox('line')).toBeInTheDocument())
    fireEvent.click(keyBox('line'))
    fireEvent.click(keyBox('order'))

    expect(keyBox('line')).toBeChecked()
    expect(within(rowOf('line')).getByText('1')).toBeInTheDocument()
    expect(within(rowOf('order')).getByText('2')).toBeInTheDocument()
    const summary = screen.getByText('Key:').parentElement!
    expect(summary.textContent).toBe('Key:line→order(composite)')
  })

  it('says a key is picked and not applied, and that it is not once the tab is gone', async () => {
    // The page asks before leaving an unapplied key; a format that stops being
    // a table takes the tab away, and the question with it
    route({})
    const onDraftChange = vi.fn()
    const { unmount } = render(<TableSettings resourceId="r1" onDraftChange={onDraftChange} />)
    await waitFor(() => expect(keyBox('line')).toBeInTheDocument())
    fireEvent.click(keyBox('line'))
    expect(onDraftChange).toHaveBeenLastCalledWith(true)

    unmount()
    expect(onDraftChange).toHaveBeenLastCalledWith(false)
  })

  it('keeps the key line in place when there is no key, and says which kind it is', async () => {
    // A line that comes and goes moves everything under it each time a key is
    // emptied or begun — including the boxes being clicked.
    route({})
    render(<TableSettings resourceId="r1" />)

    await waitFor(() => expect(screen.getByText('Key:').parentElement).toHaveTextContent('(none)'))
    fireEvent.click(keyBox('order'))
    expect(screen.getByText('Key:').parentElement).toHaveTextContent('(single)')
    fireEvent.click(keyBox('line'))
    expect(screen.getByText('Key:').parentElement).toHaveTextContent('(composite)')
  })

  it(`shows each column's inferred type, which a name and a value do not always give`, async () => {
    // A date and the string of one look alike in a sample, and so does a code
    // with leading zeros next to a number that lost them.
    route({})
    render(<TableSettings resourceId="r1" />)

    await waitFor(() => expect(rowOf('order')).toHaveTextContent('String'))
  })

  it('does not let a column name set the width of the page', async () => {
    // A name is arbitrary text out of a CSV header, and where the delimiter was
    // not found there is one column named after the whole line.
    const wide = 'x'.repeat(4000)
    route({
      get: {
        schema: {
          rowCount: 1,
          columns: [
            { name: wide, type: 'string', nullable: false, nullCount: 0, distinctCount: 1 },
          ],
        },
      },
    })
    render(<TableSettings resourceId="r1" />)

    await waitFor(() => expect(keyBox(wide)).toBeInTheDocument())
    const cell = screen.getAllByTitle(wide).find((el) => el.tagName === 'TD')!
    expect(cell).toHaveClass('max-w-48')
    // Broken anywhere, and cut at two lines
    expect(cell.firstElementChild).toHaveClass('line-clamp-2', '[overflow-wrap:anywhere]')
    // And the section declares a width the page can resolve, so nothing inside
    // it contributes to how wide the tab becomes
    expect(cell.closest('div.flex.w-0')).not.toBeNull()
  })

  it('offers every column, not only the ones that stand alone', async () => {
    // A composite key is built out of columns that individually repeat; `unique`
    // marks the ones that need no checking, it does not gate the choice.
    route({})
    render(<TableSettings resourceId="r1" />)

    await waitFor(() => expect(keyBox('line')).toBeEnabled())
    expect(within(rowOf('order')).getByText('unique')).toBeInTheDocument()
    expect(within(rowOf('line')).queryByText('unique')).not.toBeInTheDocument()
  })

  it('leaves a floating-point column on screen, unpressable, with the reason beside it', async () => {
    // Dropped from the list it would read as a column the resource does not
    // have, and the publisher would go looking for it. The reason is about the
    // type — an approximate value — which is exactly what they
    // need to pick a different column (spec §6.4).
    route({
      get: {
        schema: {
          rowCount: 2,
          columns: [
            { name: 'id', type: 'string', nullable: false, nullCount: 0, distinctCount: 2 },
            { name: 'ratio', type: 'float', nullable: false, nullCount: 0, distinctCount: 2 },
          ],
        },
      },
    })
    render(<TableSettings resourceId="r1" />)

    await waitFor(() => expect(within(rowOf('ratio')).getByText('Not allowed')).toBeInTheDocument())
    expect(
      screen.queryByRole('checkbox', { name: 'Use ratio in the primary key' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(/A column of type Number cannot be used in a primary key/)
    ).toBeInTheDocument()
    expect(keyBox('id')).toBeEnabled()
  })

  it('says nothing about a type the table does not hold', async () => {
    route({})
    render(<TableSettings resourceId="r1" />)

    await waitFor(() => expect(keyBox('order')).toBeEnabled())
    expect(screen.queryByText(/cannot be used in a primary key/)).not.toBeInTheDocument()
  })

  it('keeps a key already resting on one removable, and blocks the apply that changes it', async () => {
    // The stored key stands (the server refuses only a change), so the box
    // that would take the column back out has to stay pressable — and the
    // selection that adds to it has to be stopped here rather than at a 400.
    route({
      get: {
        primaryKey: ['ratio'],
        carried: true,
        schema: {
          rowCount: 2,
          columns: [
            { name: 'id', type: 'string', nullable: false, nullCount: 0, distinctCount: 2 },
            { name: 'ratio', type: 'float', nullable: false, nullCount: 0, distinctCount: 2 },
          ],
        },
      },
    })
    render(<TableSettings resourceId="r1" />)

    expect(
      await screen.findByRole('checkbox', { name: 'Use ratio in the primary key' })
    ).toBeEnabled()

    fireEvent.click(keyBox('id'))
    await afterCheck()
    expect(screen.getByText(/cannot identify a row/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    // And nothing was asked of the content to reach that: the answer is on the
    // schema, and the scan would hold the one DuckDB slot to repeat it.
    expect(mockClientFetch.mock.calls.some(([path]) => path.endsWith('/check'))).toBe(false)

    // Taking the column out leaves a key the apply will take.
    fireEvent.click(keyBox('ratio'))
    await afterCheck()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled())

    // And putting it back is still possible: the stored key is one the server
    // takes unchanged, so taking the column out must not be a one-way door.
    expect(keyBox('ratio')).toBeEnabled()
    fireEvent.click(keyBox('ratio'))
    await afterCheck()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled())
  })

  it('says the version recorded no counts, rather than showing every column as not unique', async () => {
    // A version interpreted before the per-column counts existed carries none,
    // and an absent mark then reads as "this column repeats" when it means
    // "nobody counted" — with every column looking that way at once.
    route({
      get: {
        schema: {
          rowCount: 2,
          columns: [
            { name: 'order', type: 'string', nullable: false, nullCount: 0 },
            { name: 'line', type: 'string', nullable: false, nullCount: 0 },
          ],
        },
      },
    })
    render(<TableSettings resourceId="r1" />)

    await waitFor(() => expect(screen.getByText(/does not record per-column/)).toBeInTheDocument())
    // Repaired by the same run that repairs a stale preview, so it is offered
    // here too.
    expect(screen.getByRole('button', { name: 'Rebuild the interpretation' })).toBeInTheDocument()
  })

  it('offers one rebuild however many things it would put right', async () => {
    // The stale preview and the missing counts are both "the derivatives are
    // behind", and one run repairs both. Two conditions each rendering their
    // own control put two identical buttons on the screen.
    route({
      get: {
        preview: 'preview-stale',
        schema: {
          rowCount: 2,
          columns: [{ name: 'order', type: 'string', nullable: false, nullCount: 0 }],
        },
      },
    })
    render(<TableSettings resourceId="r1" />)

    await waitFor(() => expect(screen.getByText(/does not record per-column/)).toBeInTheDocument())
    expect(screen.getByText(/would be of the previous content/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Rebuild the interpretation' })).toHaveLength(1)
  })

  it('says nothing about counts once the version has them', async () => {
    route({})
    render(<TableSettings resourceId="r1" />)

    await waitFor(() => expect(keyBox('order')).toBeEnabled())
    expect(screen.queryByText(/does not record per-column/)).not.toBeInTheDocument()
  })

  it('will not apply on a verdict about a different key, nor on none at all', async () => {
    // The last answer stays up while the next is in flight, and a verdict is
    // not a caption: read without checking who it is about, the confirmation
    // warns about the key before last — and before the first answer lands there
    // is no verdict at all, so the apply goes through the gate that exists to
    // stop it. Either way the version is made and layer 2 refuses it (§6.6).
    route({ check: json({ checked: true, primaryKey: ['line'], fault: 'key-not-unique' }) })
    render(<TableSettings resourceId="r1" />)

    await waitFor(() => expect(keyBox('line')).toBeInTheDocument())
    fireEvent.click(keyBox('line'))

    // Before the answer: nothing to apply on.
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    await afterCheck()
    await screen.findByText(/does not narrow a row down to one/)

    // The answer is about ['line']; the selection has moved on.
    fireEvent.click(keyBox('order'))
    expect(screen.queryByText(/does not narrow a row down to one/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
  })

  it('says nothing where the key line and the guide have already said it', async () => {
    // No key and nothing picked: the line above reads "(none)" and the guide
    // explains what a diff does without one. A third telling is not a state.
    route({})
    const { unmount } = render(<TableSettings resourceId="r1" />)

    await waitFor(() => expect(screen.getByText('Key:').parentElement).toHaveTextContent('(none)'))
    expect(screen.queryByText(/Applying removes the primary key/)).not.toBeInTheDocument()
    unmount()

    // The pending removal still gets one, because that is about the button.
    route({ get: { primaryKey: ['order'] } })
    render(<TableSettings resourceId="r2" />)
    await waitFor(() => expect(keyBox('order')).toBeChecked())
    fireEvent.click(keyBox('order'))
    expect(screen.getByText(/Applying removes the primary key/)).toBeInTheDocument()
  })

  it('says what a key would fail on before it is applied', async () => {
    route({ check: json({ checked: true, primaryKey: ['line'], fault: 'key-not-unique' }) })
    render(<TableSettings resourceId="r1" />)

    await waitFor(() => expect(keyBox('line')).toBeEnabled())
    fireEvent.click(keyBox('line'))
    await afterCheck()

    await waitFor(() =>
      expect(
        screen.getByText(
          'This key does not narrow a row down to one. As it stands, a version ingested under this key would be left out of diff ingestion.'
        )
      ).toBeInTheDocument()
    )
    // Offered, not enforced: the apply asks nothing of the content, and the
    // content the next version carries may not be this content (spec §6.4).
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled()
  })

  it('does not settle a key it just said would be refused without saying what that costs', async () => {
    // The version this creates is refused by layer 2, the reason is written
    // once and never cleared, and correcting the key afterwards does not put it
    // in — there is no entry point for re-ingesting a refused version (spec
    // §6.6). Irreversible from this screen, so it is confirmed rather than
    // blocked.
    route({ check: json({ checked: true, primaryKey: ['line'], fault: 'key-not-unique' }) })
    render(<TableSettings resourceId="r1" />)

    await waitFor(() => expect(keyBox('line')).toBeEnabled())
    fireEvent.click(keyBox('line'))
    await afterCheck()
    // The rendered answer, not just the elapsed timer: the click has to carry
    // the check the screen is showing.
    await screen.findByText(
      'This key does not narrow a row down to one. As it stands, a version ingested under this key would be left out of diff ingestion.'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await screen.findByText(/no diff involving it can be shown/)
    expect(mockClientFetch.mock.calls.some(([, i]) => i?.method === 'PUT')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Apply anyway' }))
    await waitFor(() =>
      expect(mockClientFetch.mock.calls.some(([, i]) => i?.method === 'PUT')).toBe(true)
    )
  })

  it('confirms a change of key with what it changes, though nothing is known to fail', async () => {
    // Every change of key makes a version (ADR-072 decision 5); "could not
    // check" adds no warning of its own to that confirmation.
    route({ check: json({ checked: false, primaryKey: ['order'], reason: 'no-preview' }) })
    render(<TableSettings resourceId="r1" />)

    await waitFor(() => expect(keyBox('order')).toBeEnabled())
    fireEvent.click(keyBox('order'))
    await afterCheck()
    // The answer has to be on screen before Apply is offered — an apply with no
    // verdict is one the confirmation could not have stopped.
    await screen.findByText(/could not be checked/)
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('(none)')
    expect(dialog).toHaveTextContent('order')
    expect(mockClientFetch.mock.calls.some(([, i]) => i?.method === 'PUT')).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }))

    await waitFor(() =>
      expect(mockClientFetch.mock.calls.some(([, i]) => i?.method === 'PUT')).toBe(true)
    )
  })

  it('does not turn "could not check" into a refusal', async () => {
    route({ check: json({ checked: false, primaryKey: ['order'], reason: 'no-preview' }) })
    render(<TableSettings resourceId="r1" />)

    await waitFor(() => expect(keyBox('order')).toBeEnabled())
    fireEvent.click(keyBox('order'))
    await afterCheck()

    await waitFor(() => expect(screen.getByText(/could not be checked/)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled()
  })

  it('checks the whole selection once rather than once per column', async () => {
    // Every check can scan the content, and a composite key is built one column
    // at a time. Without the debounce, picking three columns scans three times
    // and the first two answers are about keys nobody asked for.
    const check = vi.fn(() => json({ checked: true, fault: null }))
    route({ check })
    render(<TableSettings resourceId="r1" />)

    await waitFor(() => expect(keyBox('order')).toBeEnabled())
    fireEvent.click(keyBox('order'))
    fireEvent.click(keyBox('line'))
    await afterCheck()

    expect(check).toHaveBeenCalledTimes(1)
    const body = JSON.parse(
      (mockClientFetch.mock.calls.find(([p]) => p.endsWith('/check'))![1]!.body as string) ?? '{}'
    )
    expect(body).toEqual({ primaryKey: ['order', 'line'], types: {} })
  })

  it('says a rebuild is on its way once a key is applied', async () => {
    // Settling a key creates a version — the bytes do not move, so the version
    // owns a copy of them (ADR-046 §3). The screen has to say that happened.
    route({ put: json({ primaryKey: ['order'], queued: true }) })
    const onRunQueued = vi.fn()
    render(<TableSettings resourceId="r1" onRunQueued={onRunQueued} />)

    await waitFor(() => expect(keyBox('order')).toBeEnabled())
    fireEvent.click(keyBox('order'))
    await afterCheck()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled())
    applyKey()

    await waitFor(() => expect(screen.getByText(/A rebuild is queued/)).toBeInTheDocument())
    expect(onRunQueued).toHaveBeenCalled()
  })

  it('tells the owner a run is on the queue only where one was queued', async () => {
    // The owner refetches on this, and what it is watching for is a run. An
    // apply whose enqueue failed — it reports rather than throws — has nothing
    // to watch, and a refetch would put the badge back as it was.
    route({ get: { primaryKey: ['order'], carried: false }, put: json({ queued: false }) })
    const onRunQueued = vi.fn()
    render(<TableSettings resourceId="r1" onRunQueued={onRunQueued} />)

    await waitFor(() => expect(keyBox('line')).toBeEnabled())
    fireEvent.click(keyBox('line'))
    await afterCheck()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled())
    applyKey()

    await waitFor(() => expect(screen.getByText(/rebuild could not be queued/)).toBeInTheDocument())
    expect(onRunQueued).not.toHaveBeenCalled()
  })

  it('leaves a way to queue the rebuild when the enqueue failed', async () => {
    // The setting is saved and nothing will carry it. The server decides the
    // write and the enqueue separately so that a resend is the repair, and a
    // button disabled on `settled` alone closes the only door to it: no sweep
    // looks for a resource whose setting and newest version disagree.
    let put = json({ primaryKey: ['line'], queued: false })
    route({ get: { primaryKey: ['order'], carried: false }, put })
    render(<TableSettings resourceId="r1" />)

    await waitFor(() => expect(keyBox('line')).toBeEnabled())
    fireEvent.click(keyBox('line'))
    await afterCheck()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled())
    applyKey()

    // Settled now, and the standing version still does not read this way.
    const retry = await screen.findByRole('button', { name: 'Queue the rebuild' })
    expect(retry).toBeEnabled()

    put = json({ primaryKey: ['line'], queued: true })
    route({ get: { primaryKey: ['line'], carried: false }, put })
    fireEvent.click(retry)

    await waitFor(() => expect(screen.getByText(/A rebuild is queued/)).toBeInTheDocument())
  })

  it('says what removing the key did, which is the one apply that settles to nothing', async () => {
    // Clearing leaves nothing selected and nothing stored, so the branch that
    // says "no key needs no sentence" is reached — with the outcome of the
    // apply that has just run underneath it, and unsaid.
    route({ get: { primaryKey: ['order'], carried: true }, put: json({ queued: true }) })
    render(<TableSettings resourceId="r1" />)

    await waitFor(() => expect(keyBox('order')).toBeChecked())
    fireEvent.click(keyBox('order'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove the key' }))
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove the key' })
    )

    await waitFor(() => expect(screen.getByText(/A rebuild is queued/)).toBeInTheDocument())
  })

  it('drops the queued line once the run it announced has landed', async () => {
    // The owner moves `reloadKey` when the resource gains a version. Left up,
    // "a rebuild is queued" outlives the rebuild it was about.
    route({ put: json({ primaryKey: ['order'], queued: true }) })
    const { rerender } = render(<TableSettings resourceId="r1" reloadKey={3} />)

    await waitFor(() => expect(keyBox('order')).toBeEnabled())
    fireEvent.click(keyBox('order'))
    await afterCheck()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled())
    applyKey()
    await waitFor(() => expect(screen.getByText(/A rebuild is queued/)).toBeInTheDocument())

    rerender(<TableSettings resourceId="r1" reloadKey={4} />)

    await waitFor(() => expect(screen.queryByText(/A rebuild is queued/)).not.toBeInTheDocument())
  })

  it('separates a settled key from one a version has been read under', async () => {
    // The two disagree for as long as a queued run has not landed, which is
    // ordinary rather than a fault (spec §6.4) — so it gets its own sentence.
    route({ get: { primaryKey: ['order'], carried: false } })
    render(<TableSettings resourceId="r1" />)

    await afterCheck()
    await waitFor(() =>
      expect(
        screen.getByText('Set, but no version has been ingested under it yet.')
      ).toBeInTheDocument()
    )
    // The setting is stored, so there is nothing to write — but the run that
    // would carry it may never have been queued, and a resend is what repairs
    // that. The button says which of the two it is doing.
    expect(screen.getByRole('button', { name: 'Queue the rebuild' })).toBeEnabled()
  })

  it('previews the content with the key being picked marked', async () => {
    // The preview readers see, in place of a separate tab: seeing the values
    // is what tells someone that two columns together are the key
    route({})
    const preview = vi.fn((key: string[] | null) => <p>preview of {key?.join('+') ?? 'no key'}</p>)
    render(<TableSettings resourceId="r1" preview={preview} />)

    expect(await screen.findByText('preview of no key')).toBeInTheDocument()
    fireEvent.click(keyBox('line'))
    expect(screen.getByText('preview of line')).toBeInTheDocument()
  })
  it('keeps a repeated heading as two rows, each with its own role', async () => {
    route({
      get: {
        schema: {
          rowCount: 2,
          columns: [
            { name: 'x', type: 'string', nullable: false, nullCount: 0, distinctCount: 2 },
            { name: 'x', type: 'integer', nullable: false, nullCount: 0, distinctCount: 2 },
          ],
        },
      },
      roles: json({
        columns: [
          { name: 'x', type: 'string', role: 'category', roleBasis: { rule: 'other' } },
          { name: 'x', type: 'integer', role: 'measure', roleBasis: { rule: 'typed' } },
        ],
      }),
    })
    render(<TableSettings resourceId="r1" />)
    await waitFor(() => expect(screen.getByText('Number / date')).toBeInTheDocument())
    const rows = screen
      .getAllByTitle('x')
      .filter((el) => el.tagName === 'TD')
      .map((td) => td.closest('tr')!)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Category')
    expect(rows[1]).toHaveTextContent('Number / date')
  })

  it('will not apply from an open confirmation while the key is checked again', async () => {
    route({})
    const { rerender } = render(<TableSettings resourceId="r1" reloadKey={1} />)
    await waitFor(() => expect(keyBox('line')).toBeInTheDocument())
    fireEvent.click(keyBox('line'))
    await afterCheck()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    const dialog = screen.getByRole('dialog')

    // A run lands while the dialog is open: the key is checked again
    rerender(<TableSettings resourceId="r1" reloadKey={2} />)
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Apply' })).toBeDisabled()
    )
    await afterCheck()
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Apply' })).toBeEnabled())
  })

  it('checks a kept draft again once a run has landed on new content', async () => {
    // The verdict was about the content before; the new one may break the key
    route({})
    const { rerender } = render(<TableSettings resourceId="r1" reloadKey={1} />)
    await waitFor(() => expect(keyBox('line')).toBeInTheDocument())
    fireEvent.click(keyBox('line'))
    await afterCheck()
    const checks = () =>
      mockClientFetch.mock.calls.filter(([path]) => path.endsWith('/column-settings/check')).length
    const before = checks()

    rerender(<TableSettings resourceId="r1" reloadKey={2} />)
    await afterCheck()
    await waitFor(() => expect(checks()).toBe(before + 1))
    expect(keyBox('line')).toBeChecked()
  })

  it('offers the rebuild the note names, which lives nowhere else in this screen', async () => {
    // The remedy for a stale interpretation is a rebuild from the object the
    // resource already holds. Its control is on the public resource page, so
    // without this the note points at a button that is not here.
    route({ get: { preview: 'preview-stale' } })
    render(<TableSettings resourceId="r1" />)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Rebuild the interpretation' })).toBeInTheDocument()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild the interpretation' }))

    await waitFor(() => {
      const call = mockClientFetch.mock.calls.find(([p]) => p.endsWith('/run-pipeline'))
      expect(call).toBeDefined()
      expect(JSON.parse(call![1]!.body as string)).toEqual({ rebuildOnly: true })
    })
  })

  it('does not offer a rebuild where there is nothing to rebuild from', async () => {
    // A resource with no interpretation at all may simply not be tabular, and
    // naming a remedy there names one for something that is not a fault.
    // The preview says what state the resource is in: running, or read as text
    route({ get: { preview: 'no-preview' } })
    render(<TableSettings resourceId="r1" preview={() => <p>the preview</p>} />)

    expect(await screen.findByText('the preview')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Rebuild the interpretation' })
    ).not.toBeInTheDocument()
  })

  it('says why there is no preview rather than showing one of other bytes', async () => {
    // A run whose Interpret failed leaves the previous content's preview in
    // place. Showing it would be choosing a key over content the resource does
    // not serve — the same reason the check reports `preview-stale`.
    route({ get: { preview: 'preview-stale' } })
    render(<TableSettings resourceId="r1" preview={() => <p>the preview</p>} />)

    await waitFor(() =>
      expect(screen.getByText(/would be of the previous content/)).toBeInTheDocument()
    )
    expect(screen.queryByText('the preview')).not.toBeInTheDocument()
  })

  it('has nothing to offer before anything has been interpreted', async () => {
    route({ get: { schema: null } })
    render(<TableSettings resourceId="r1" />)

    await waitFor(() =>
      expect(screen.getByText(/No columns have been interpreted/)).toBeInTheDocument()
    )
  })

  describe('one table with the roles (ADR-072 Step 1c)', () => {
    const roles = (columns: unknown[]) => json({ columns })

    it(`shows each column's role and why, beside its place in the key`, async () => {
      route({
        roles: roles([
          {
            name: 'order',
            type: 'string',
            role: 'identifier',
            roleBasis: { rule: 'fixed-width-code' },
          },
          {
            name: 'line',
            type: 'string',
            role: 'category',
            roleBasis: { rule: 'distinct-values', share: 0.5 },
          },
        ]),
      })
      render(<TableSettings resourceId="r1" />)

      // A text column's role is a choice, set to follow the rules
      await waitFor(() => expect(rowOf('order')).toHaveTextContent('Auto (Identifier)'))
      expect(rowOf('line')).toHaveTextContent('50%')
      // No pack read either column: no column for a vocabulary
      expect(screen.queryByRole('columnheader', { name: 'Vocabulary' })).not.toBeInTheDocument()
    })

    it(`applies a text column's role straight away, as it makes no version`, async () => {
      route({
        // Settled types this screen does not edit yet go back as they stand
        get: { carried: true, types: { order: 'string' } },
        roles: roles([
          {
            name: 'order',
            type: 'string',
            role: 'identifier',
            roleBasis: { rule: 'fixed-width-code' },
          },
          { name: 'line', type: 'string', role: 'category', roleBasis: { rule: 'other' } },
        ]),
      })
      render(<TableSettings resourceId="r1" />)
      const trigger = await waitFor(() =>
        within(rowOf('line')).getByRole('combobox', { name: /^Role of/ })
      )
      fireEvent.click(trigger)
      // Each role says what it does in search, in the list and not in the trigger
      expect(await screen.findByText(/Searchable by value \(facility/)).toBeInTheDocument()
      expect(trigger).not.toHaveTextContent(/Searchable/)
      fireEvent.click(await screen.findByRole('option', { name: 'Name' }))

      expect(rowOf('line')).toHaveAttribute('data-draft')
      expect(screen.getByText(/Changing a role makes no version/)).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

      await waitFor(() =>
        expect(screen.getByText(/A reprocess to take in the roles is queued/)).toBeInTheDocument()
      )
      // No confirmation: nothing about the key changed
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      const put = mockClientFetch.mock.calls.find(([, init]) => init?.method === 'PUT')!
      expect(JSON.parse(put[1]!.body as string)).toEqual({
        primaryKey: null,
        roles: { line: 'name' },
        types: { order: 'string' },
      })
    })

    it(`offers to queue again roles the profile has not read`, async () => {
      // A role makes no version: an enqueue that failed leaves nothing to
      // apply, and only the profile says the roles are not in yet
      route({ get: { roles: { line: 'name' }, rolesCarried: false } })
      render(<TableSettings resourceId="r1" />)
      expect(await screen.findByText(/role changes are not in the profile/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Queue the rebuild' })).toBeEnabled()
    })

    it(`keeps a stored override changeable where there is no profile`, async () => {
      // A profile that failed must not leave the override stuck
      route({ get: { roles: { line: 'name' }, rolesCarried: false } })
      render(<TableSettings resourceId="r1" />)
      const trigger = await waitFor(() =>
        within(rowOf('line')).getByRole('combobox', { name: /^Role of/ })
      )
      expect(trigger).toHaveTextContent('Name')
      fireEvent.click(trigger)
      expect(await screen.findByRole('option', { name: 'Auto' })).toBeInTheDocument()
    })

    it(`shows what an overridden column would go back to`, async () => {
      route({
        get: { roles: { line: 'name' } },
        roles: roles([
          {
            name: 'order',
            type: 'string',
            role: 'identifier',
            roleBasis: { rule: 'fixed-width-code' },
          },
          {
            name: 'line',
            type: 'string',
            role: 'name',
            roleBasis: { rule: 'override' },
            inferred: { role: 'category', roleBasis: { rule: 'distinct-values', share: 0.5 } },
          },
        ]),
      })
      render(<TableSettings resourceId="r1" />)
      await waitFor(() =>
        expect(within(rowOf('line')).getByRole('combobox', { name: /^Role of/ })).toHaveTextContent(
          'Name'
        )
      )
      // The rules' reason for what they decided, not the override's
      expect(rowOf('line')).toHaveTextContent('50%')
      expect(rowOf('line')).not.toHaveAttribute('data-draft')
    })

    it(`shows a column's vocabulary with what it rests on, and the candidates of an undecided one`, async () => {
      const vocabulary = {
        concept: 'admin-area',
        pack: 'JP',
        scheme: 'jp-area-code',
        representation: 'code6',
        share: 0.95,
        ambiguous: 0,
        levels: [{ level: 'ADM2', matched: 3, total: 1741 }],
        periods: [{ validFrom: '2014-04-01' }],
        narrowedBy: ['011002'],
      }
      route({
        roles: roles([
          {
            name: 'order',
            type: 'string',
            role: 'identifier',
            roleBasis: { rule: 'vocabulary' },
            vocabulary,
          },
          {
            name: 'line',
            type: 'string',
            role: 'category',
            roleBasis: { rule: 'other' },
            vocabulary: {
              ...vocabulary,
              representation: 'name',
              // A code given out twice: both of its uses, with the gap between
              periods: [
                { validTo: '2010-01-01' },
                { validFrom: '2020-01-01', validTo: '2024-04-01' },
              ],
              alternatives: [{ concept: 'xa-area', pack: 'XA', scheme: 'xa', representation: 'c' }],
            },
          },
        ]),
      })
      render(<TableSettings resourceId="r1" />)

      await waitFor(() =>
        expect(rowOf('order')).toHaveTextContent(
          'Administrative area: Standard area code for statistics (Japan) (6 digits)'
        )
      )
      expect(screen.getByRole('columnheader', { name: 'Vocabulary' })).toBeInTheDocument()
      expect(rowOf('order')).toHaveTextContent('95% of values match')
      expect(rowOf('order')).toHaveTextContent('ADM2 3/1741 areas')
      expect(rowOf('order')).toHaveTextContent('the scheme from 2014-04-01')
      // A badge for each candidate, and what they are said beneath
      expect(
        within(rowOf('line')).getByText(
          'Administrative area: Standard area code for statistics (Japan) (names)'
        )
      ).toBeInTheDocument()
      expect(within(rowOf('line')).getByText('xa-area: xa (c)')).toBeInTheDocument()
      expect(rowOf('line')).toHaveTextContent('several candidates')
      expect(rowOf('line')).toHaveTextContent(
        'the scheme before 2010-01-01; the scheme from 2020-01-01 to 2024-04-01'
      )
    })

    it('leaves a role out that the profile has under another name, and keeps the key pickable', async () => {
      // A profile of other content says nothing about these columns
      route({
        roles: roles([
          { name: 'renamed', type: 'string', role: 'identifier', roleBasis: { rule: 'typed' } },
        ]),
      })
      render(<TableSettings resourceId="r1" />)

      await waitFor(() => expect(keyBox('order')).toBeEnabled())
      // Still a text column to give a role to, with no rules' decision to name
      expect(within(rowOf('order')).getByRole('combobox', { name: /^Role of/ })).toHaveTextContent(
        /^Auto$/
      )
      expect(rowOf('order')).not.toHaveTextContent('Identifier')
    })

    it('keeps the key choosable when the roles cannot be read', async () => {
      route({ roles: { ok: false, json: async () => ({}) } as Response })
      render(<TableSettings resourceId="r1" />)

      expect(await screen.findByText('Could not load the column roles')).toBeInTheDocument()
      fireEvent.click(keyBox('order'))
      expect(keyBox('order')).toBeChecked()
    })

    it('marks and counts the rows a draft moves, and discards them back to the stored key', async () => {
      route({ get: { primaryKey: ['order'] } })
      const onDraftChange = vi.fn()
      render(<TableSettings resourceId="r1" onDraftChange={onDraftChange} />)
      await waitFor(() => expect(keyBox('order')).toBeChecked())
      expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled()

      fireEvent.click(keyBox('line'))
      expect(rowOf('line')).toHaveAttribute('data-draft')
      expect(rowOf('order')).not.toHaveAttribute('data-draft')
      expect(screen.getByText('Changes not applied: 1')).toBeInTheDocument()
      expect(onDraftChange).toHaveBeenLastCalledWith(true)

      fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
      expect(keyBox('line')).not.toBeChecked()
      expect(rowOf('line')).not.toHaveAttribute('data-draft')
      expect(onDraftChange).toHaveBeenLastCalledWith(false)
    })

    it('says the same before the table on every resource, keyed or not', async () => {
      // A note that came and went with the key read as two different screens
      route({ get: { primaryKey: ['order'] } })
      render(<TableSettings resourceId="r1" />)
      const note = await screen.findByText(
        /setting it as the primary key is recommended.*Applying a change of primary key creates one version/
      )
      const table = screen.getAllByRole('table').at(-1)!
      expect(note.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('draws a key column this version does not have, so the key can still be taken apart', async () => {
      // The content dropped a column the stored key rests on
      route({ get: { primaryKey: ['gone', 'order'] } })
      render(<TableSettings resourceId="r1" />)
      await waitFor(() => expect(keyBox('gone')).toBeChecked())
      expect(rowOf('gone')).toHaveTextContent('Not in this version')

      fireEvent.click(keyBox('gone'))
      fireEvent.click(keyBox('order'))
      expect(screen.getByText('Changes not applied: 2')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Remove the key' })).toBeInTheDocument()
    })

    it('keeps a draft when a run lands on the same key, and drops it when the key moved', async () => {
      route({})
      const { rerender } = render(<TableSettings resourceId="r1" reloadKey={1} />)
      await waitFor(() => expect(keyBox('line')).toBeInTheDocument())
      fireEvent.click(keyBox('line'))

      rerender(<TableSettings resourceId="r1" reloadKey={2} />)
      await waitFor(() =>
        expect(
          mockClientFetch.mock.calls.filter(
            ([p, i]) => p.endsWith('/column-settings') && !i?.method
          )
        ).toHaveLength(2)
      )
      expect(keyBox('line')).toBeChecked()

      // Someone else set a key meanwhile: the draft was built on a key that is gone
      route({ get: { primaryKey: ['order'] } })
      rerender(<TableSettings resourceId="r1" reloadKey={3} />)
      await waitFor(() => expect(keyBox('order')).toBeChecked())
      expect(keyBox('line')).not.toBeChecked()
    })

    it('says which place a column holds in the key, for a screen reader too', async () => {
      route({})
      render(<TableSettings resourceId="r1" />)
      await waitFor(() => expect(keyBox('line')).toBeInTheDocument())
      fireEvent.click(keyBox('line'))
      expect(keyBox('line')).toHaveAccessibleDescription('position 1 in the primary key')
    })

    it('names the values that keep a column from being a number', async () => {
      route({
        roles: json({
          columns: [
            {
              name: 'order',
              type: 'string',
              role: 'numeric-text',
              roleBasis: { rule: 'number-shape', share: 0.9, examples: ['-', '(8)'] },
            },
          ],
        }),
      })
      render(<TableSettings resourceId="r1" />)
      await waitFor(() => expect(rowOf('order')).toHaveTextContent('90%'))
      expect(rowOf('order')).toHaveTextContent(/do not read as numbers: -.*\(8\)/)
    })

    it('counts the rows of a number written as text where the rules counted them', async () => {
      route({
        roles: json({
          columns: [
            {
              name: 'order',
              type: 'string',
              role: 'numeric-text',
              roleBasis: {
                rule: 'number-shape',
                share: 1,
                counts: { numbers: 171, marks: 119, blank: 0, others: 0 },
              },
            },
          ],
        }),
      })
      render(<TableSettings resourceId="r1" />)
      await waitFor(() =>
        expect(rowOf('order')).toHaveTextContent(
          'Of 290 rows: 171 numbers, 119 marks alone (no value) (every number reads as written)'
        )
      )
      expect(rowOf('order')).not.toHaveTextContent('100%')
    })
  })

  describe('recommendations by rules (Versioning ii-c §8.6)', () => {
    const roles = () =>
      json({
        columns: [
          {
            name: 'order',
            type: 'string',
            role: 'identifier',
            roleBasis: { rule: 'leading-zero' },
          },
          {
            name: 'line',
            type: 'string',
            role: 'numeric-text',
            roleBasis: { rule: 'number-shape' },
          },
        ],
      })

    it('offers the recommended key one press from the draft', async () => {
      route({ roles: roles() })
      render(<TableSettings resourceId="r1" />)
      await waitFor(() => expect(keyBox('order')).toBeInTheDocument())

      const offer = await within(rowOf('order')).findByRole('button', { name: 'Recommended: key' })
      expect(offer).toHaveAttribute(
        'title',
        'Every value differs and none is empty, so it can be the key'
      )
      fireEvent.click(offer)
      expect(keyBox('order')).toBeChecked()
      // Picked, the recommendation has said what it had to
      expect(
        within(rowOf('order')).queryByRole('button', { name: 'Recommended: key' })
      ).not.toBeInTheDocument()
    })

    /** What reading `line`, written as numbers, as a decimal found */
    const lineRead = (
      read: { decimalScale: number; castFailures?: number; values?: number },
      rows = 2
    ) =>
      mockEstimateState.mockReturnValue({
        estimate: {
          rows,
          whole: true,
          columns: { line: { decimalPrecision: 18, values: rows, ...read } },
          judge: async () => new Set<string>(),
        },
        failed: false,
      })

    it('offers the recommended type one press from the draft, and nothing is written', async () => {
      lineRead({ decimalScale: 2 })
      route({ roles: roles() })
      render(<TableSettings resourceId="r1" />)
      await waitFor(() => expect(keyBox('line')).toBeInTheDocument())

      fireEvent.click(
        await within(rowOf('line')).findByRole('button', { name: 'Recommended: Decimal' })
      )
      expect(within(rowOf('line')).getByRole('combobox', { name: /^Type of/ })).toHaveTextContent(
        'Decimal'
      )
      expect(
        within(rowOf('line')).queryByRole('button', { name: /^Recommended:/ })
      ).not.toBeInTheDocument()
      expect(mockClientFetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
      expect(mockEstimateState).toHaveBeenCalledWith(
        expect.objectContaining({ types: { line: 'decimal' } })
      )
    })

    it('recommends an integer where no value of numbers written as text has a fraction', async () => {
      lineRead({ decimalScale: 0 })
      route({ roles: roles() })
      render(<TableSettings resourceId="r1" />)
      await waitFor(() => expect(keyBox('line')).toBeInTheDocument())

      const offer = await within(rowOf('line')).findByRole('button', {
        name: 'Recommended: Integer',
      })
      expect(offer).toHaveAttribute('title', expect.stringMatching(/^Whole numbers/))
    })

    it('recommends no type for numbers written as text where more than a tenth would not read', async () => {
      lineRead({ decimalScale: 0, castFailures: 1 })
      route({ roles: roles() })
      render(<TableSettings resourceId="r1" />)
      await waitFor(() => expect(keyBox('line')).toBeInTheDocument())
      // The code's offer stands
      expect(
        await within(rowOf('order')).findByRole('button', { name: 'Recommended: String' })
      ).toBeInTheDocument()
      expect(
        within(rowOf('line')).queryByRole('button', { name: /^Recommended: (?!key)/ })
      ).not.toBeInTheDocument()
    })

    it('recommends a decimal for a float, never an integer, whatever its fractions', async () => {
      // The preview spells a float's `100.0` as `100`: an integer would not read the file's
      mockEstimateState.mockReturnValue({
        estimate: {
          rows: 2,
          whole: true,
          columns: { lat: { decimalPrecision: 3, decimalScale: 0, values: 2 } },
          judge: async () => new Set<string>(),
        },
        failed: false,
      })
      route({
        get: {
          schema: {
            rowCount: 2,
            columns: [
              { name: 'lat', type: 'float', nullable: false, nullCount: 0, distinctCount: 2 },
            ],
          },
        },
      })
      render(<TableSettings resourceId="r1" />)
      await waitFor(() => expect(rowOf('lat')).toBeInTheDocument())
      const offer = await within(rowOf('lat')).findByRole('button', {
        name: 'Recommended: Decimal',
      })
      expect(offer).toHaveAttribute('title', expect.stringMatching(/^Decimal digits as written/))
    })

    it('recommends no decimal for a float the preview writes in exponent notation', async () => {
      // Too small or large to write out: a range a float suits
      mockEstimateState.mockReturnValue({
        estimate: {
          rows: 2,
          whole: true,
          columns: { lat: { decimalPrecision: 8, decimalScale: 7, values: 2, exponents: 1 } },
          judge: async () => new Set<string>(),
        },
        failed: false,
      })
      route({
        get: {
          schema: {
            rowCount: 2,
            columns: [
              { name: 'lat', type: 'float', nullable: false, nullCount: 0, distinctCount: 2 },
            ],
          },
        },
      })
      render(<TableSettings resourceId="r1" />)
      await waitFor(() => expect(rowOf('lat')).toBeInTheDocument())
      expect(
        within(rowOf('lat')).queryByRole('button', { name: /^Recommended:/ })
      ).not.toBeInTheDocument()
    })

    it('recommends a type where nine in ten of the values read, to the line', async () => {
      // Of the values the rows read hold, not of the rows: half of them blank
      lineRead({ decimalScale: 0, castFailures: 1, values: 10 }, 20)
      route({ roles: roles() })
      render(<TableSettings resourceId="r1" />)
      await waitFor(() => expect(keyBox('line')).toBeInTheDocument())
      expect(
        await within(rowOf('line')).findByRole('button', { name: 'Recommended: Integer' })
      ).toBeInTheDocument()
    })

    it('recommends no type for numbers written as text until their values are read', async () => {
      mockEstimateState.mockReturnValue({ estimate: null, failed: false })
      route({ roles: roles() })
      render(<TableSettings resourceId="r1" />)
      await waitFor(() => expect(keyBox('line')).toBeInTheDocument())
      expect(
        await within(rowOf('order')).findByRole('button', { name: 'Recommended: String' })
      ).toBeInTheDocument()
      expect(
        within(rowOf('line')).queryByRole('button', { name: /^Recommended: (?!key)/ })
      ).not.toBeInTheDocument()
    })

    it('recommends no key where one is set', async () => {
      route({ get: { primaryKey: ['order'] }, roles: roles() })
      render(<TableSettings resourceId="r1" />)
      await waitFor(() => expect(keyBox('order')).toBeChecked())
      expect(
        within(rowOf('order')).queryByRole('button', { name: 'Recommended: key' })
      ).not.toBeInTheDocument()
    })
  })

  describe('settled types (Versioning ii-c)', () => {
    const typeOf = (name: string) => within(rowOf(name)).getByRole('combobox', { name: /^Type of/ })
    const choose = async (trigger: HTMLElement, option: string) => {
      fireEvent.click(trigger)
      fireEvent.click(await screen.findByRole('option', { name: option }))
    }

    it('applies a type through a confirmation, as it makes a version', async () => {
      route({})
      render(<TableSettings resourceId="r1" />)
      await waitFor(() => expect(typeOf('line')).toHaveTextContent('Auto (String)'))

      await choose(typeOf('line'), 'Integer')
      expect(rowOf('line')).toHaveAttribute('data-draft')
      // A number has no role to choose: the type is its role
      expect(within(rowOf('line')).queryByRole('combobox', { name: /^Role of/ })).toBeNull()
      expect(within(rowOf('line')).getByText('Number / date')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

      const dialog = await screen.findByRole('dialog')
      expect(within(dialog).getByText('Apply with the column types changed?')).toBeInTheDocument()
      expect(dialog).toHaveTextContent('line: Auto (String) → Integer')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }))

      await waitFor(() => {
        const put = mockClientFetch.mock.calls.find(([, init]) => init?.method === 'PUT')!
        expect(JSON.parse(put[1]!.body as string)).toEqual({
          primaryKey: null,
          roles: {},
          types: { line: 'integer' },
        })
      })
    })

    it('offers a format, shown by example, for a date', async () => {
      route({})
      render(<TableSettings resourceId="r1" />)
      await waitFor(() => expect(typeOf('line')).toBeInTheDocument())

      await choose(typeOf('line'), 'Date')
      const format = within(rowOf('line')).getByRole('combobox', { name: /^Format of/ })
      expect(format).toHaveTextContent('Format: auto')
      await choose(format, '31/12/1999')
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
      const dialog = await screen.findByRole('dialog')
      expect(dialog).toHaveTextContent('line: Auto (String) → Date (31/12/1999)')
    })

    it('checks the key again when one of its columns is to be read as another type', async () => {
      // The values the key was checked on are not the ones it will read
      const check = vi.fn(() => json({ checked: false, primaryKey: ['order'], reason: 'retyped' }))
      route({ get: { primaryKey: ['order'] }, check })
      render(<TableSettings resourceId="r1" />)
      await waitFor(() => expect(typeOf('order')).toBeInTheDocument())

      await choose(typeOf('order'), 'Integer')
      await afterCheck()

      expect(check).toHaveBeenCalledTimes(1)
      const body = JSON.parse(
        mockClientFetch.mock.calls.find(([p]) => p.endsWith('/check'))![1]!.body as string
      )
      expect(body).toEqual({ primaryKey: ['order'], types: { order: 'integer' } })
      expect(await screen.findByText(/will be read as another type/)).toBeInTheDocument()
    })

    it('takes a column out of the key when it is typed as a float', async () => {
      route({ get: { primaryKey: ['order'] } })
      render(<TableSettings resourceId="r1" />)
      await waitFor(() => expect(keyBox('order')).toBeChecked())

      await choose(typeOf('order'), 'Number')

      // Out of the key, and not offered back while the draft types it so
      expect(within(rowOf('order')).queryByRole('checkbox')).toBeNull()
      expect(within(rowOf('order')).getByText('Not allowed')).toBeInTheDocument()

      // On a type a key may rest on again, the key comes back — by way of
      // another type too, which the check then asks about
      await choose(typeOf('order'), 'Date')
      expect(keyBox('order')).toBeChecked()
      await choose(typeOf('order'), 'Number')
      await choose(typeOf('order'), 'Auto (String)')
      expect(keyBox('order')).toBeChecked()
    })

    it('gives no key back once the type change that took it out is applied', async () => {
      route({ get: { primaryKey: ['order'] } })
      render(<TableSettings resourceId="r1" />)
      await waitFor(() => expect(keyBox('order')).toBeChecked())

      await choose(typeOf('order'), 'Number')
      fireEvent.click(screen.getByRole('button', { name: 'Remove the key' }))
      const dialog = await screen.findByRole('dialog')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove the key' }))
      await waitFor(() => expect(typeOf('order')).toHaveTextContent('Number'))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

      await choose(typeOf('order'), 'Date')
      expect(keyBox('order')).not.toBeChecked()
    })

    it('estimates, as a type is chosen, how many of the rows read would not convert', async () => {
      estimateOnceTyped({
        rows: 10_000,
        whole: false,
        columns: { line: { castFailures: 12, castFailureSamples: [{ row: 3, value: 'a' }] } },
      })
      route({})
      render(<TableSettings resourceId="r1" />)
      await waitFor(() => expect(typeOf('line')).toBeInTheDocument())

      await choose(typeOf('line'), 'Integer')

      const note = await screen.findByText(
        'Of the first 10,000 rows, 12 (0.12%) are expected not to convert (they would read as no value). The preview outlines them in red'
      )
      expect(note).toHaveAttribute('title', 'Row 3: a')
      // Only the change is estimated
      expect(mockEstimate).toHaveBeenLastCalledWith(
        expect.objectContaining({ types: { line: 'integer' } })
      )
    })

    it('names the format the values would decide, and that every row read reads', async () => {
      estimateOnceTyped({ rows: 2, whole: true, columns: { line: { dateFormat: '%Y/%m/%d' } } })
      route({})
      render(<TableSettings resourceId="r1" />)
      await waitFor(() => expect(typeOf('line')).toBeInTheDocument())

      await choose(typeOf('line'), 'Date')

      expect(
        await screen.findByText('Left to the values, the format is expected to be 1999/12/31')
      ).toBeInTheDocument()
      expect(screen.getByText('Every value is expected to read')).toBeInTheDocument()
    })

    it('says how many values are marks read as no value, apart from those that read', async () => {
      estimateOnceTyped({
        rows: 290,
        whole: true,
        columns: { line: { noValueMarks: { count: 119, examples: ['-', '…'] } } },
      })
      route({})
      render(<TableSettings resourceId="r1" />)
      await waitFor(() => expect(typeOf('line')).toBeInTheDocument())

      await choose(typeOf('line'), 'Integer')

      expect(await screen.findByText('No value is expected not to convert')).toBeInTheDocument()
      expect(
        screen.getByText('119 rows (41.03%) hold marks alone, such as -, …, and read as no value')
      ).toBeInTheDocument()
      expect(screen.queryByText('Every value is expected to read')).not.toBeInTheDocument()
    })

    it('says what the live version made of a settled column', async () => {
      route({
        get: {
          types: { line: 'integer' },
          schema: {
            rowCount: 2,
            columns: [
              { name: 'order', type: 'string', nullable: false, nullCount: 0, unique: true },
              {
                name: 'line',
                type: 'integer',
                inferredType: 'string',
                settled: true,
                nullable: true,
                nullCount: 1,
                castFailures: 1,
                castFailureSamples: [{ row: 2, value: 'N/A' }],
                noValueMarks: { count: 3, examples: ['-', '…'] },
              },
            ],
          },
        },
      })
      render(<TableSettings resourceId="r1" />)

      const note = await screen.findByText(
        'Values that could not be converted: 1 (read as no value)'
      )
      expect(note).toHaveAttribute('title', 'Row 2: N/A')
      // Marks, read as no value too, said apart from the values that failed
      expect(
        screen.getByText('3 values of marks alone, such as -, … (read as no value)')
      ).toBeInTheDocument()
      expect(typeOf('line')).toHaveTextContent('Integer')
      // Lifted in the draft, the note describes a reading that will not stand
      await choose(typeOf('line'), 'Auto (String)')
      expect(screen.queryByText(/could not be converted/)).toBeNull()
    })
  })
})
