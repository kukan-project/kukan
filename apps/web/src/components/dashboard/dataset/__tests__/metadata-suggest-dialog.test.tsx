import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import { MetadataSuggestDialog } from '../metadata-suggest-dialog'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const mockClientFetch = vi.mocked(clientFetch)

const SUGGESTION = {
  suggestion: {
    title: '提案タイトル',
    notes: '提案の説明',
    tags: [
      { name: '防災', isNew: false },
      { name: '新規タグ', isNew: true },
    ],
    resources: [{ id: 'res-1', name: '提案リソース名', description: 'リソースの説明案' }],
  },
  generatedBy: { provider: 'ollama', model: 'gemma4:e4b' },
  usedResources: ['res-1'],
  skippedResources: ['res-2'],
}

const CURRENT = {
  title: '元タイトル',
  notes: '',
  tags: ['既存'],
  resources: [
    { id: 'res-1', name: 'data.csv', description: '', format: 'csv', pipelineStatus: 'complete' },
    { id: 'res-2', name: 'doc.pdf', description: null, format: 'pdf', pipelineStatus: 'complete' },
  ],
}

function jsonResponse(data: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => data } as Response
}

function renderDialog(onApply = vi.fn()) {
  render(
    <MetadataSuggestDialog
      nameOrId="test-pkg"
      open
      onOpenChange={vi.fn()}
      current={CURRENT}
      onApply={onApply}
    />
  )
  return onApply
}

describe('MetadataSuggestDialog', () => {
  beforeEach(() => {
    mockClientFetch.mockReset()
  })

  it('requests a suggestion with the locale and shows current vs proposed', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse(SUGGESTION))
    renderDialog()

    await waitFor(() => expect(screen.getByText('提案タイトル')).toBeInTheDocument())

    const [path, init] = mockClientFetch.mock.calls[0]
    expect(path).toBe('/api/v1/packages/test-pkg/suggest-metadata')
    expect(JSON.parse(init!.body as string)).toEqual({ locale: 'en' })

    expect(screen.getByText('元タイトル')).toBeInTheDocument()
    expect(screen.getByText('提案の説明')).toBeInTheDocument()
    expect(screen.getByText('リソースの説明案')).toBeInTheDocument()
    expect(screen.getByText('提案リソース名')).toBeInTheDocument()
    // The resource carries a format badge
    expect(screen.getByText('csv')).toBeInTheDocument()
    // isNew tags carry a badge; skipped resources are noted
    expect(screen.getByText('New: 新規タグ')).toBeInTheDocument()
    expect(screen.getByText(/could not be read/)).toBeInTheDocument()
  })

  it('applies only the selected fields; every toggle is opt-in', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse(SUGGESTION))
    const onApply = renderDialog()

    await waitFor(() => expect(screen.getByText('提案タイトル')).toBeInTheDocument())

    // Order: title, notes, tags, resource name, resource description.
    // Every toggle starts off — the user opts into each field
    const switches = screen.getAllByRole('switch')
    expect(switches.map((s) => s.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'false',
      'false',
      'false',
    ])
    // Opt into notes, tags, and both resource fields (leave the title off)
    fireEvent.click(switches[1])
    fireEvent.click(switches[2])
    fireEvent.click(switches[3])
    fireEvent.click(switches[4])

    fireEvent.click(screen.getByRole('button', { name: 'Adopt selected fields' }))

    expect(onApply).toHaveBeenCalledWith({
      notes: '提案の説明',
      tags: ['防災', '新規タグ'],
      resources: [{ id: 'res-1', name: '提案リソース名', description: 'リソースの説明案' }],
    })
  })

  it('lets the user edit an adopted proposal before applying', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse(SUGGESTION))
    const onApply = renderDialog()

    await waitFor(() => expect(screen.getByText('提案タイトル')).toBeInTheDocument())

    // Adopt the title, then its proposed value becomes editable
    fireEvent.click(screen.getAllByRole('switch')[0])
    fireEvent.change(screen.getByDisplayValue('提案タイトル'), {
      target: { value: '手直ししたタイトル' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Adopt selected fields' }))

    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ title: '手直ししたタイトル' }))
  })

  it('disables the toggle for a field the AI did not change', async () => {
    mockClientFetch.mockResolvedValue(
      jsonResponse({
        ...SUGGESTION,
        // Title identical to current → adopting is a no-op
        suggestion: { ...SUGGESTION.suggestion, title: CURRENT.title },
      })
    )
    renderDialog()

    await waitFor(() => expect(screen.getByText('提案の説明')).toBeInTheDocument())

    // First row is the title: unchanged → its switch is disabled and off
    const switches = screen.getAllByRole('switch')
    expect(switches[0]).toBeDisabled()
    expect(switches[0].getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText('No change')).toBeInTheDocument()
    // Other rows (notes/tags/resource) still differ and stay active
    expect(switches[1]).toBeEnabled()
  })

  it('shows the rate-limit message on 429', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse({}, false, 429))
    renderDialog()

    await waitFor(() => expect(screen.getByText(/usage limit/)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Adopt selected fields' })).toBeDisabled()
  })

  it('shows the unavailable message on 503', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse({}, false, 503))
    renderDialog()

    await waitFor(() => expect(screen.getByText(/currently unavailable/)).toBeInTheDocument())
  })

  it('requests only once per opening', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse(SUGGESTION))
    const { rerender } = render(
      <MetadataSuggestDialog
        nameOrId="test-pkg"
        open
        onOpenChange={vi.fn()}
        current={CURRENT}
        onApply={vi.fn()}
      />
    )
    await waitFor(() => expect(screen.getByText('提案タイトル')).toBeInTheDocument())

    rerender(
      <MetadataSuggestDialog
        nameOrId="test-pkg"
        open
        onOpenChange={vi.fn()}
        current={{ ...CURRENT, title: '変わった' }}
        onApply={vi.fn()}
      />
    )
    expect(mockClientFetch).toHaveBeenCalledTimes(1)
  })
})
