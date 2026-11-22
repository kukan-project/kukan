import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DataExplorer } from '../data-explorer'
import { CellMarksContext, cellKey } from '../cell-marks'

// Both engines are mocked as mutable state the tests drive between rerenders:
// the static reader always has rows, the duck engine flips through the
// boot/failure states the demotion logic has to survive.
const duckState = {
  ready: false,
  loading: false,
  queryLoading: false,
  error: null as string | null,
  columns: [] as string[],
  totalRows: 0,
  filteredRows: 0,
  rows: [] as Record<string, string>[],
  query: vi.fn(),
}
let lastEnabled: boolean | undefined

vi.mock('@/hooks/use-duckdb', () => ({
  useDuckDB: ({ enabled }: { enabled: boolean }) => {
    lastEnabled = enabled
    return { ...duckState }
  },
}))

// One array and one footer, as the real reader keeps them between renders
const staticRows = [{ name: 'x' }, { name: 'y' }]
const staticMetadata = { numRows: 2, columns: ['name'] }

vi.mock('@/hooks/use-parquet-preview', () => ({
  useParquetPreview: () => ({
    metadata: staticMetadata,
    rows: staticRows,
    page: 0,
    totalPages: 1,
    loading: false,
    pageLoading: false,
    error: null,
    goToPage: vi.fn(),
  }),
}))

function renderExplorer() {
  return render(<DataExplorer resourceId="r1" />)
}

// The header holds the sort button and the filter trigger; the sort one is first
const sortButton = () => screen.getAllByRole('button', { name: /name/ })[0]

beforeEach(() => {
  Object.assign(duckState, {
    ready: false,
    loading: false,
    queryLoading: false,
    error: null,
    columns: [],
    totalRows: 0,
    filteredRows: 0,
    rows: [],
    query: vi.fn(),
  })
  lastEnabled = undefined
})

describe('implicit engine boot and demotion', () => {
  it('renders the static rows without asking for the engine', () => {
    renderExplorer()
    expect(screen.getByText('x')).toBeInTheDocument()
    expect(lastEnabled).toBe(false)
  })

  it('requests the engine on the first sort interaction', () => {
    renderExplorer()
    fireEvent.click(sortButton())
    expect(lastEnabled).toBe(true)
  })

  it('demotes on boot failure: sticky note, static rows, engine released for retry', () => {
    const view = renderExplorer()
    fireEvent.click(sortButton())

    duckState.error = 'boot failed'
    view.rerender(<DataExplorer resourceId="r1" />)

    // The note stays and the criteria the engine never applied are dropped
    expect(screen.getByText(/sort and filter are unavailable/i)).toBeInTheDocument()
    expect(screen.getByText('x')).toBeInTheDocument()
    expect(lastEnabled).toBe(false)

    // The disabled hook clears its own error; the note must survive that
    duckState.error = null
    view.rerender(<DataExplorer resourceId="r1" />)
    expect(screen.getByText(/sort and filter are unavailable/i)).toBeInTheDocument()

    // The next interaction retries the boot
    fireEvent.click(sortButton())
    expect(lastEnabled).toBe(true)
  })

  it('keeps the note when a query fails while the engine is ready', () => {
    const view = renderExplorer()
    fireEvent.click(sortButton())

    // Boot succeeds — the note (if any) clears
    Object.assign(duckState, { ready: true, columns: ['name'], rows: [{ name: 'y' }] })
    view.rerender(<DataExplorer resourceId="r1" />)
    expect(screen.queryByText(/sort and filter are unavailable/i)).not.toBeInTheDocument()

    // A query failure sets error while ready stays true: the note must show
    // and must not be raced away by the ready-based clear
    duckState.error = 'query failed'
    view.rerender(<DataExplorer resourceId="r1" />)
    expect(screen.getByText(/sort and filter are unavailable/i)).toBeInTheDocument()
    expect(lastEnabled).toBe(false)
  })
})

describe('cells marked by the screen around it', () => {
  it('marks the cells the judge names, on the rows shown', async () => {
    const judge = vi.fn(async () => new Set([cellKey(1, 'name')]))
    // One value, as the settings memoize it: a new one is a new judge
    const marks = { judge, title: 'would not convert' }
    render(
      <CellMarksContext.Provider value={marks}>
        <DataExplorer resourceId="r1" />
      </CellMarksContext.Provider>
    )

    await waitFor(() => expect(screen.getByText('y')).toHaveAttribute('data-marked', 'true'))
    expect(screen.getByText('y')).toHaveAttribute('title', 'would not convert')
    expect(screen.getByText('x')).not.toHaveAttribute('data-marked')
    expect(judge).toHaveBeenCalledWith([{ name: 'x' }, { name: 'y' }])
  })

  it('shows no marks from the last rows while the new ones are judged', async () => {
    let settle: (cells: Set<string>) => void = () => {}
    const judge = vi
      .fn<(rows: Record<string, string>[]) => Promise<Set<string>>>()
      .mockResolvedValueOnce(new Set([cellKey(1, 'name')]))
      .mockImplementationOnce(() => new Promise((resolve) => (settle = resolve)))
    const marks = { judge, title: 'would not convert' }
    const view = render(
      <CellMarksContext.Provider value={marks}>
        <DataExplorer resourceId="r1" />
      </CellMarksContext.Provider>
    )
    await waitFor(() => expect(screen.getByText('y')).toHaveAttribute('data-marked', 'true'))

    // The engine takes over with other rows: row 1 is now another value
    Object.assign(duckState, {
      ready: true,
      columns: ['name'],
      totalRows: 2,
      filteredRows: 2,
      rows: [{ name: 'p' }, { name: 'q' }],
    })
    view.rerender(
      <CellMarksContext.Provider value={marks}>
        <DataExplorer resourceId="r1" />
      </CellMarksContext.Provider>
    )
    expect(screen.getByText('q')).not.toHaveAttribute('data-marked')

    settle(new Set([cellKey(0, 'name')]))
    await waitFor(() => expect(screen.getByText('p')).toHaveAttribute('data-marked', 'true'))
  })
})
