import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ParquetField } from '@/hooks/use-parquet-schema'
import { ResourceFields } from '../resource-fields'

const mockUseParquetSchema = vi.fn()

vi.mock('@/hooks/use-parquet-schema', () => ({
  useParquetSchema: (...args: unknown[]) => mockUseParquetSchema(...args),
}))

function setHook(state: {
  fields?: ParquetField[] | null
  loading?: boolean
  error?: string | null
}) {
  mockUseParquetSchema.mockReturnValue({
    fields: state.fields ?? null,
    loading: state.loading ?? false,
    error: state.error ?? null,
  })
}

describe('ResourceFields', () => {
  beforeEach(() => mockUseParquetSchema.mockReset())

  it('renders nothing while loading', () => {
    setHook({ loading: true })
    const { container } = render(<ResourceFields resourceId="r1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing on error or when there are no fields', () => {
    setHook({ error: 'boom' })
    const { container, rerender } = render(<ResourceFields resourceId="r1" />)
    expect(container).toBeEmptyDOMElement()

    setHook({ fields: [] })
    rerender(<ResourceFields resourceId="r1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders a row per field with type badge, types, nullable and size', () => {
    setHook({
      fields: [
        {
          name: 'pref',
          type: 'string',
          physicalType: 'BYTE_ARRAY',
          logicalType: 'UTF8',
          nullable: true,
          compressedSize: 101,
        },
        {
          name: 'count',
          type: 'integer',
          physicalType: 'INT64',
          logicalType: null,
          nullable: false,
          compressedSize: 0,
        },
      ],
    })

    render(<ResourceFields resourceId="r1" />)

    // Field count in the summary (en.json: "{count} fields")
    expect(screen.getByText('2 fields')).toBeInTheDocument()

    // Names + raw types
    expect(screen.getByText('pref')).toBeInTheDocument()
    expect(screen.getByText('count')).toBeInTheDocument()
    expect(screen.getByText('BYTE_ARRAY')).toBeInTheDocument()
    expect(screen.getByText('INT64')).toBeInTheDocument()

    // Semantic type badges (en.json)
    expect(screen.getByText('String')).toBeInTheDocument()
    expect(screen.getByText('Integer')).toBeInTheDocument()

    // null logicalType renders the em-dash placeholder
    expect(screen.getByText('—')).toBeInTheDocument()

    // Nullable Yes/No (en.json)
    expect(screen.getByText('Yes')).toBeInTheDocument()
    expect(screen.getByText('No')).toBeInTheDocument()

    // Size via formatBytes
    expect(screen.getByText('101 B')).toBeInTheDocument()
    expect(screen.getByText('0 B')).toBeInTheDocument()
  })
})
