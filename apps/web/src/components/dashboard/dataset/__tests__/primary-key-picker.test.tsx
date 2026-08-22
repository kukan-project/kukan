import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { useParquetPreview } from '@/hooks/use-parquet-preview'
import { PrimaryKeyPicker } from '../primary-key-picker'

vi.mock('@/lib/client-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/client-api')>()),
  clientFetch: vi.fn(),
}))

vi.mock('@/hooks/use-parquet-preview', () => ({ useParquetPreview: vi.fn() }))

const mockClientFetch = vi.mocked(clientFetch)

/** The sample is read straight off the Parquet, so it is stubbed at the hook. */
function sampleRows(rows: Record<string, unknown>[] = []) {
  vi.mocked(useParquetPreview).mockReturnValue({
    rows,
    loading: false,
    error: null,
  } as unknown as ReturnType<typeof useParquetPreview>)
}

const json = (data: unknown) => ({ ok: true, json: async () => data }) as Response

function settings(overrides: Partial<Record<string, unknown>> = {}) {
  return json({
    id: 'r1',
    primaryKey: null,
    carried: true,
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
}) {
  let stored = handlers.get ?? {}
  mockClientFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/column-settings/check')) {
      const c = handlers.check
      // The default echoes the key it was asked about, as the route does: the
      // picker only trusts an answer that names the current selection.
      const asked = JSON.parse(init!.body as string) as { primaryKey: string[] | null }
      return (
        (typeof c === 'function' ? c() : c) ??
        json({ checked: true, primaryKey: asked.primaryKey, fault: null })
      )
    }
    if (path.endsWith('/run-pipeline')) return json({ queued: true })
    if (init?.method === 'PUT') {
      const body = JSON.parse(init.body as string) as { primaryKey: string[] | null }
      stored = { ...stored, primaryKey: body.primaryKey, carried: false }
      return handlers.put ?? json({ primaryKey: body.primaryKey, queued: true })
    }
    return settings(stored)
  })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  mockClientFetch.mockReset()
  sampleRows()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Lets the debounce elapse and the check settle. */
async function afterCheck() {
  await vi.advanceTimersByTimeAsync(500)
}

describe('PrimaryKeyPicker', () => {
  it('reads the key as one line, so a chip never changes size when it is picked', async () => {
    // A chip that grows by a number reflows every chip after it, and the list
    // moves under the pointer as the key is built. With sixty columns the order
    // is not something to reconstruct by hunting for numbers either.
    route({})
    render(<PrimaryKeyPicker resourceId="r1" />)

    await waitFor(() => expect(screen.getByRole('button', { name: /line/ })).toBeInTheDocument())
    const before = screen.getByRole('button', { name: /line/ }).textContent
    fireEvent.click(screen.getByRole('button', { name: /line/ }))
    fireEvent.click(screen.getByRole('button', { name: /order/ }))

    expect(screen.getByRole('button', { name: /line/ })).toHaveTextContent(before!)
    expect(screen.getByRole('button', { name: /line/ })).toHaveAttribute('aria-pressed', 'true')

    // The order lives in the summary, in the order the columns were picked.
    const summary = screen.getByText('Key:').parentElement!
    expect(summary.textContent).toBe('Key:line→order(composite)')
  })

  it('keeps the key line in place when there is no key, and says which kind it is', async () => {
    // A line that comes and goes moves everything under it each time a key is
    // emptied or begun — including the chips being clicked.
    route({})
    render(<PrimaryKeyPicker resourceId="r1" />)

    await waitFor(() => expect(screen.getByText('Key:').parentElement).toHaveTextContent('(none)'))
    fireEvent.click(screen.getByRole('button', { name: /order/ }))
    expect(screen.getByText('Key:').parentElement).toHaveTextContent('(single)')
    fireEvent.click(screen.getByRole('button', { name: /line/ }))
    expect(screen.getByText('Key:').parentElement).toHaveTextContent('(composite)')
  })

  it(`shows each column's inferred type, which a name and a value do not always give`, async () => {
    // A date and the string of one look alike in a sample, and so does a code
    // with leading zeros next to a number that lost them.
    route({})
    render(<PrimaryKeyPicker resourceId="r1" />)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /order/ })).toHaveTextContent('(String)')
    )
  })

  it('does not let a column name set the width of the page', async () => {
    // A name is arbitrary text out of a CSV header, and where the delimiter was
    // not found there is one column named after the whole line. This renders
    // inside a `<td>`, which is sized from its content — so a chip that cannot
    // shrink takes the resource list and the page with it.
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
    render(<PrimaryKeyPicker resourceId="r1" />)

    const chip = await screen.findByRole('button', { name: new RegExp(wide.slice(0, 20)) })
    expect(chip).toHaveClass('max-w-full', 'min-w-0', 'shrink')
    expect(chip.querySelector('.truncate')).toHaveTextContent(wide)
    // And the section itself declares a width the cell can resolve, so nothing
    // inside it contributes to how wide the cell becomes.
    expect(chip.closest('div.flex.w-0')).not.toBeNull()
  })

  it('offers every column, not only the ones that stand alone', async () => {
    // A composite key is built out of columns that individually repeat; `unique`
    // marks the ones that need no checking, it does not gate the choice.
    route({})
    render(<PrimaryKeyPicker resourceId="r1" />)

    await waitFor(() => expect(screen.getByRole('button', { name: /line/ })).toBeEnabled())
    expect(screen.getByRole('button', { name: /order/ })).toHaveTextContent('unique')
    expect(screen.getByRole('button', { name: /line/ })).not.toHaveTextContent('unique')
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
    render(<PrimaryKeyPicker resourceId="r1" />)

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
    render(<PrimaryKeyPicker resourceId="r1" />)

    await waitFor(() => expect(screen.getByText(/does not record per-column/)).toBeInTheDocument())
    expect(screen.getByText(/would be of the previous content/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Rebuild the interpretation' })).toHaveLength(1)
  })

  it('says nothing about counts once the version has them', async () => {
    route({})
    render(<PrimaryKeyPicker resourceId="r1" />)

    await waitFor(() => expect(screen.getByRole('button', { name: /order/ })).toBeEnabled())
    expect(screen.queryByText(/does not record per-column/)).not.toBeInTheDocument()
  })

  it('will not apply on a verdict about a different key, nor on none at all', async () => {
    // The last answer stays up while the next is in flight, and a verdict is
    // not a caption: read without checking who it is about, the confirmation
    // warns about the key before last — and before the first answer lands there
    // is no verdict at all, so the apply goes through the gate that exists to
    // stop it. Either way the version is made and layer 2 refuses it (§6.6).
    route({ check: json({ checked: true, primaryKey: ['line'], fault: 'key-not-unique' }) })
    render(<PrimaryKeyPicker resourceId="r1" />)

    await waitFor(() => expect(screen.getByRole('button', { name: /line/ })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /line/ }))

    // Before the answer: nothing to apply on.
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    await afterCheck()
    await screen.findByText(/does not narrow a row down to one/)

    // The answer is about ['line']; the selection has moved on.
    fireEvent.click(screen.getByRole('button', { name: /order/ }))
    expect(screen.queryByText(/does not narrow a row down to one/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
  })

  it('says nothing where the key line and the help have already said it', async () => {
    // No key and nothing picked: the line above reads "(none)" and the help has
    // explained what a diff does without one. A third telling is not a state.
    route({})
    render(<PrimaryKeyPicker resourceId="r1" />)

    await waitFor(() => expect(screen.getByText('Key:').parentElement).toHaveTextContent('(none)'))
    expect(screen.queryByText(/one row added and one removed/)).not.toBeInTheDocument()

    // The pending removal still gets one, because that is about the button.
    route({ get: { primaryKey: ['order'] } })
    render(<PrimaryKeyPicker resourceId="r2" />)
    await waitFor(() => expect(screen.getByRole('button', { name: /order/ })).toBeInTheDocument())
    fireEvent.click(screen.getAllByRole('button', { name: /order/ })[1])
    expect(screen.getByText(/Applying removes the primary key/)).toBeInTheDocument()
  })

  it('says what a key would fail on before it is applied', async () => {
    route({ check: json({ checked: true, primaryKey: ['line'], fault: 'key-not-unique' }) })
    render(<PrimaryKeyPicker resourceId="r1" />)

    await waitFor(() => expect(screen.getByRole('button', { name: /line/ })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: /line/ }))
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
    render(<PrimaryKeyPicker resourceId="r1" />)

    await waitFor(() => expect(screen.getByRole('button', { name: /line/ })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: /line/ }))
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

  it('applies straight away when the key is not known to fail', async () => {
    // "Could not check" is not a fault, and treating it as one would make the
    // unknown case cost a confirmation it has nothing to warn about.
    route({ check: json({ checked: false, primaryKey: ['order'], reason: 'no-preview' }) })
    render(<PrimaryKeyPicker resourceId="r1" />)

    await waitFor(() => expect(screen.getByRole('button', { name: /order/ })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: /order/ }))
    await afterCheck()
    // The answer has to be on screen before Apply is offered — an apply with no
    // verdict is one the confirmation could not have stopped.
    await screen.findByText(/could not be checked/)
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() =>
      expect(mockClientFetch.mock.calls.some(([, i]) => i?.method === 'PUT')).toBe(true)
    )
  })

  it('does not turn "could not check" into a refusal', async () => {
    route({ check: json({ checked: false, primaryKey: ['order'], reason: 'no-preview' }) })
    render(<PrimaryKeyPicker resourceId="r1" />)

    await waitFor(() => expect(screen.getByRole('button', { name: /order/ })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: /order/ }))
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
    render(<PrimaryKeyPicker resourceId="r1" />)

    await waitFor(() => expect(screen.getByRole('button', { name: /order/ })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: /order/ }))
    fireEvent.click(screen.getByRole('button', { name: /line/ }))
    await afterCheck()

    expect(check).toHaveBeenCalledTimes(1)
    const body = JSON.parse(
      (mockClientFetch.mock.calls.find(([p]) => p.endsWith('/check'))![1]!.body as string) ?? '{}'
    )
    expect(body).toEqual({ primaryKey: ['order', 'line'] })
  })

  it('says a rebuild is on its way once a key is applied', async () => {
    // Settling a key creates a version — the bytes do not move, so the version
    // owns a copy of them (ADR-046 §3). The screen has to say that happened.
    route({ put: json({ primaryKey: ['order'], queued: true }) })
    const onRunQueued = vi.fn()
    render(<PrimaryKeyPicker resourceId="r1" onRunQueued={onRunQueued} />)

    await waitFor(() => expect(screen.getByRole('button', { name: /order/ })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: /order/ }))
    await afterCheck()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(screen.getByText(/A rebuild is queued/)).toBeInTheDocument())
    expect(onRunQueued).toHaveBeenCalled()
  })

  it('tells the owner a run is on the queue only where one was queued', async () => {
    // The owner refetches on this, and what it is watching for is a run. An
    // apply whose enqueue failed — it reports rather than throws — has nothing
    // to watch, and a refetch would put the badge back as it was.
    route({ get: { primaryKey: ['order'], carried: false }, put: json({ queued: false }) })
    const onRunQueued = vi.fn()
    render(<PrimaryKeyPicker resourceId="r1" onRunQueued={onRunQueued} />)

    await waitFor(() => expect(screen.getByRole('button', { name: /line/ })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: /line/ }))
    await afterCheck()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

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
    render(<PrimaryKeyPicker resourceId="r1" />)

    await waitFor(() => expect(screen.getByRole('button', { name: /line/ })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: /line/ }))
    await afterCheck()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

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
    render(<PrimaryKeyPicker resourceId="r1" />)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /order/ })).toHaveAttribute('aria-pressed', 'true')
    )
    fireEvent.click(screen.getByRole('button', { name: /order/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove the key' }))

    await waitFor(() => expect(screen.getByText(/A rebuild is queued/)).toBeInTheDocument())
  })

  it('drops the queued line once the run it announced has landed', async () => {
    // The owner moves `reloadKey` when the resource gains a version. Left up,
    // "a rebuild is queued" outlives the rebuild it was about.
    route({ put: json({ primaryKey: ['order'], queued: true }) })
    const { rerender } = render(<PrimaryKeyPicker resourceId="r1" reloadKey={3} />)

    await waitFor(() => expect(screen.getByRole('button', { name: /order/ })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: /order/ }))
    await afterCheck()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(screen.getByText(/A rebuild is queued/)).toBeInTheDocument())

    rerender(<PrimaryKeyPicker resourceId="r1" reloadKey={4} />)

    await waitFor(() => expect(screen.queryByText(/A rebuild is queued/)).not.toBeInTheDocument())
  })

  it('separates a settled key from one a version has been read under', async () => {
    // The two disagree for as long as a queued run has not landed, which is
    // ordinary rather than a fault (spec §6.4) — so it gets its own sentence.
    route({ get: { primaryKey: ['order'], carried: false } })
    render(<PrimaryKeyPicker resourceId="r1" />)

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

  it('shows what the columns hold, marking the ones the key is built from', async () => {
    // A column name does not say whether it identifies a row, and the counts
    // beside it do not say what a value looks like. Seeing the values is what
    // tells someone that two columns together are the key.
    sampleRows([
      { order: 'A-1', line: '1' },
      { order: 'A-1', line: '2' },
    ])
    route({})
    render(<PrimaryKeyPicker resourceId="r1" />)

    await waitFor(() =>
      expect(screen.getByRole('columnheader', { name: /order/ })).toBeInTheDocument()
    )
    expect(screen.getAllByRole('row')).toHaveLength(3) // header + two samples
    expect(screen.getAllByText('A-1')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: /line/ }))
    // Not a tint of `muted`: the row's own hover is `bg-muted/50`, so a muted
    // mark disappears exactly while a row is being read.
    expect(screen.getByRole('columnheader', { name: 'line' })).toHaveClass('bg-primary/15')
    expect(screen.getByRole('columnheader', { name: 'order' })).not.toHaveClass('bg-primary/15')
  })

  it('offers the rebuild the note names, which lives nowhere else in this screen', async () => {
    // The remedy for a stale interpretation is a rebuild from the object the
    // resource already holds. Its control is on the public resource page, so
    // without this the note points at a button that is not here.
    route({ get: { preview: 'preview-stale' } })
    render(<PrimaryKeyPicker resourceId="r1" />)

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
    route({ get: { preview: 'no-preview' } })
    render(<PrimaryKeyPicker resourceId="r1" />)

    await waitFor(() =>
      expect(screen.getByText(/no interpretation to show a sample from/)).toBeInTheDocument()
    )
    expect(
      screen.queryByRole('button', { name: 'Rebuild the interpretation' })
    ).not.toBeInTheDocument()
  })

  it('says why there is no sample rather than showing one from other bytes', async () => {
    // A run whose Interpret failed leaves the previous content's preview in
    // place. Showing it would be choosing a key over content the resource does
    // not serve — the same reason the check reports `preview-stale`.
    route({ get: { preview: 'preview-stale' } })
    render(<PrimaryKeyPicker resourceId="r1" />)

    await waitFor(() =>
      expect(screen.getByText(/would be of the previous content/)).toBeInTheDocument()
    )
    expect(screen.queryByRole('columnheader')).not.toBeInTheDocument()
  })

  it('shows only the columns a key can be chosen from', async () => {
    // The preview can carry a column the live version's frozen schema does not,
    // and offering it in the sample would advertise a choice the toggles above
    // do not have.
    sampleRows([{ order: 'A-1', line: '1', dropped: 'x' }])
    route({})
    render(<PrimaryKeyPicker resourceId="r1" />)

    await waitFor(() =>
      expect(screen.getByRole('columnheader', { name: /order/ })).toBeInTheDocument()
    )
    expect(screen.queryByRole('columnheader', { name: /dropped/ })).not.toBeInTheDocument()
  })

  it('has nothing to offer before anything has been interpreted', async () => {
    route({ get: { schema: null } })
    render(<PrimaryKeyPicker resourceId="r1" />)

    await waitFor(() =>
      expect(screen.getByText(/No columns have been interpreted/)).toBeInTheDocument()
    )
  })
})
