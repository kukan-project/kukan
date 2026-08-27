import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { ResourceSchema } from '@kukan/shared'
import { DataApiDialog } from '../data-api-dialog'

const mockClientFetch = vi.fn()

vi.mock('@/lib/client-api', () => ({
  clientFetch: (...args: unknown[]) => mockClientFetch(...args),
  problemDetail: async (res: Response) => {
    const body = await res.json().catch(() => null)
    return (body as { detail?: string } | null)?.detail || undefined
  },
}))

// Default: highlighter not loaded (plain rendering). Individual tests flip it
// to a truthy value to exercise the shiki path without loading real shiki.
const mockUseHighlighter = vi.fn()

vi.mock('@/hooks/use-shiki', () => ({
  useHighlighter: () => mockUseHighlighter(),
  // Mirrors real shiki output where it matters: escaped content, and a
  // tabindex="0" on the pre unless focusable: false suppresses it.
  highlight: (_h: unknown, code: string, lang: string, opts?: { focusable?: boolean }) =>
    `<pre class="shiki" data-lang="${lang}"${opts?.focusable === false ? '' : ' tabindex="0"'}><code>${code
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')}</code></pre>`,
}))

const schema: ResourceSchema = {
  columns: [
    { name: 'prefecture', type: 'string', nullable: false, nullCount: 0 },
    { name: 'count', type: 'integer', nullable: false, nullCount: 0 },
  ],
  rowCount: 47,
}

function renderAndOpen(s: ResourceSchema = schema) {
  render(<DataApiDialog resourceId="r1" schema={s} />)
  fireEvent.click(screen.getByRole('button', { name: 'Data API' }))
}

function runFirstExample() {
  fireEvent.click(screen.getAllByRole('button', { name: 'Run' })[0])
}

/** Successful /query response with the given overrides. */
function mockQuerySuccess(
  overrides: Partial<{
    columns: string[]
    rows: Record<string, unknown>[]
    rowCount: number
    truncated: boolean
    elapsedMs: number
  }> = {}
) {
  mockClientFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      columns: [],
      rows: [],
      rowCount: 0,
      truncated: false,
      elapsedMs: 0,
      ...overrides,
    }),
  })
}

/** Matches an element whose full text contains the fragment (code blocks are multi-line). */
const containing = (fragment: string) => (_: string, el: Element | null) =>
  el?.tagName === 'PRE' && (el.textContent?.includes(fragment) ?? false)

describe('DataApiDialog', () => {
  beforeEach(() => {
    mockClientFetch.mockReset()
    mockUseHighlighter.mockReset()
    mockUseHighlighter.mockReturnValue(null)
  })

  it('renders only the trigger button until opened', () => {
    render(<DataApiDialog resourceId="r1" schema={schema} />)
    expect(screen.getByRole('button', { name: 'Data API' })).toBeInTheDocument()
    expect(screen.queryByText('Endpoints')).not.toBeInTheDocument()
  })

  it('shows the schema and query endpoints for this resource', () => {
    renderAndOpen()
    const origin = window.location.origin
    expect(
      screen.getByText(containing(`GET ${origin}/api/v1/resources/r1/schema`))
    ).toBeInTheDocument()
    expect(
      screen.getByText(containing(`POST ${origin}/api/v1/resources/r1/query`))
    ).toBeInTheDocument()
  })

  it('shows a curl example posting a query', () => {
    renderAndOpen()
    expect(
      screen.getByText(containing(`-d '{"sql": "SELECT * FROM data LIMIT 10"}'`))
    ).toBeInTheDocument()
  })

  it('shows the fetch example when switching to the JavaScript tab', () => {
    renderAndOpen()
    // Radix Tabs selects on mousedown, not click
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'JavaScript' }))
    expect(
      screen.getByText(
        containing(`await fetch('${window.location.origin}/api/v1/resources/r1/query'`)
      )
    ).toBeInTheDocument()
  })

  it('builds the aggregate SQL example from the first column name', () => {
    renderAndOpen()
    expect(screen.getByDisplayValue(/GROUP BY "prefecture"/)).toBeInTheDocument()
  })

  it('doubles embedded quotes when quoting a column name', () => {
    renderAndOpen({
      columns: [{ name: 'we"ird', type: 'string', nullable: false, nullCount: 0 }],
      rowCount: 1,
    })
    expect(screen.getByDisplayValue(/GROUP BY "we""ird"/)).toBeInTheDocument()
  })

  it('renders highlighted code and a transparent-text SQL editor once shiki loads', () => {
    mockUseHighlighter.mockReturnValue({})
    renderAndOpen()

    // The curl block goes through the highlighter but keeps its content
    const curlBlock = screen.getByText(containing(`-d '{"sql": "SELECT * FROM data LIMIT 10"}'`))
    expect(curlBlock).toHaveClass('shiki')
    expect(curlBlock).toHaveAttribute('data-lang', 'bash')

    // The visible code block keeps shiki's keyboard-scrollable tabindex
    expect(curlBlock).toHaveAttribute('tabindex', '0')

    // The SQL editor gains the highlighted mirror and hides its own text
    const editor = screen.getByDisplayValue('SELECT * FROM data LIMIT 10')
    expect(editor).toHaveClass('text-transparent')
    const mirror = screen.getByText(containing('GROUP BY "prefecture"'))
    // The aria-hidden mirror must never be a tab stop
    expect(mirror).not.toHaveAttribute('tabindex')
  })

  it('keeps the highlight mirror scrolled in sync with the textarea', () => {
    mockUseHighlighter.mockReturnValue({})
    renderAndOpen()

    const editor = screen.getByDisplayValue(/GROUP BY "prefecture"/)
    const mirror = screen.getByText(containing('GROUP BY "prefecture"')).parentElement!
    editor.scrollTop = 40
    editor.scrollLeft = 25
    fireEvent.scroll(editor)

    expect(mirror.scrollTop).toBe(40)
    expect(mirror.scrollLeft).toBe(25)
  })

  it('aborts an in-flight query when the dialog unmounts', () => {
    mockClientFetch.mockReturnValue(new Promise(() => {}))

    const { unmount } = render(<DataApiDialog resourceId="r1" schema={schema} />)
    fireEvent.click(screen.getByRole('button', { name: 'Data API' }))
    runFirstExample()

    const { signal } = mockClientFetch.mock.calls[0][1] as { signal: AbortSignal }
    expect(signal.aborted).toBe(false)
    unmount()
    expect(signal.aborted).toBe(true)
  })

  it('lists the usage limitations', () => {
    renderAndOpen()
    expect(
      screen.getByText(
        'Only a single SELECT / WITH statement can be run. The table is always named data.'
      )
    ).toBeInTheDocument()
  })

  it('runs an example against the query endpoint and shows the result table', async () => {
    mockQuerySuccess({
      columns: ['prefecture', 'count'],
      rows: [
        { prefecture: 'Tokyo', count: 14 },
        { prefecture: null, count: 3 },
      ],
      rowCount: 2,
      elapsedMs: 5,
    })

    renderAndOpen()
    runFirstExample()

    expect(await screen.findByText('Tokyo')).toBeInTheDocument()
    expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/resources/r1/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT * FROM data LIMIT 10' }),
      signal: expect.any(AbortSignal),
    })
    // null cells render the em-dash placeholder
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByText('2 rows / 5 ms')).toBeInTheDocument()
  })

  it('posts the edited SQL when the example is rewritten', async () => {
    mockQuerySuccess({ columns: ['n'], rows: [{ n: 1 }], rowCount: 1, elapsedMs: 1 })

    renderAndOpen()
    fireEvent.change(screen.getByDisplayValue('SELECT * FROM data LIMIT 10'), {
      target: { value: 'SELECT COUNT(*) AS n FROM data' },
    })
    runFirstExample()

    expect(await screen.findByText('1 rows / 1 ms')).toBeInTheDocument()
    expect(mockClientFetch).toHaveBeenCalledWith(
      '/api/v1/resources/r1/query',
      expect.objectContaining({ body: JSON.stringify({ sql: 'SELECT COUNT(*) AS n FROM data' }) })
    )
  })

  it('disables Run while a query is in flight and when the SQL is blank', async () => {
    let settle!: (value: unknown) => void
    mockClientFetch.mockReturnValue(new Promise((resolve) => (settle = resolve)))

    renderAndOpen()
    const runButton = screen.getAllByRole('button', { name: 'Run' })[0]
    fireEvent.click(runButton)
    expect(runButton).toBeDisabled()

    settle({
      ok: true,
      json: async () => ({ columns: [], rows: [], rowCount: 0, truncated: false, elapsedMs: 0 }),
    })
    await screen.findByText('0 rows / 0 ms')
    expect(runButton).toBeEnabled()

    fireEvent.change(screen.getByDisplayValue('SELECT * FROM data LIMIT 10'), {
      target: { value: '   ' },
    })
    expect(runButton).toBeDisabled()
  })

  it('copies a code block to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    renderAndOpen()
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0])

    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith(
      `GET ${window.location.origin}/api/v1/resources/r1/schema`
    )
  })

  it('renders duplicate aliases under their deduplicated column names', async () => {
    // The sandbox deduplicates repeated output names (a, a:1) so columns
    // always match the row keys — both values must show up.
    mockQuerySuccess({
      columns: ['a', 'a:1'],
      rows: [{ a: 'Tokyo', 'a:1': 14 }],
      rowCount: 1,
      elapsedMs: 2,
    })

    renderAndOpen()
    runFirstExample()

    expect(await screen.findByText('Tokyo')).toBeInTheDocument()
    expect(screen.getByText('14')).toBeInTheDocument()
  })

  it('caps the rendered rows and says so', async () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({ n: i }))
    mockQuerySuccess({ columns: ['n'], rows, rowCount: 600, elapsedMs: 3 })

    renderAndOpen()
    runFirstExample()

    expect(await screen.findByText(/showing first 500 rows/)).toBeInTheDocument()
    // 500 data rows + 1 header row
    expect(screen.getAllByRole('row')).toHaveLength(501)
  })

  it('notes when the result was truncated at the cap', async () => {
    mockQuerySuccess({
      columns: ['prefecture'],
      rows: [{ prefecture: 'Tokyo' }],
      rowCount: 1,
      truncated: true,
      elapsedMs: 12,
    })

    renderAndOpen()
    runFirstExample()

    expect(await screen.findByText(/truncated at the cap/)).toBeInTheDocument()
  })

  it('shows the problem detail when the query fails', async () => {
    mockClientFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ detail: 'Query exceeded the time limit' }),
    })

    renderAndOpen()
    runFirstExample()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Query exceeded the time limit')
  })

  it('falls back to a generic message when the request itself fails', async () => {
    mockClientFetch.mockRejectedValue(new TypeError('network down'))

    renderAndOpen()
    runFirstExample()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Failed to run the query')
  })
})
