import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ResourceSchema } from '@kukan/shared'
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

  it('marks the primary-key column with a badge', () => {
    setHook({
      fields: [
        {
          name: 'id',
          type: 'integer',
          physicalType: 'INT64',
          logicalType: null,
          nullable: false,
          compressedSize: 0,
        },
      ],
    })

    render(<ResourceFields resourceId="r1" primaryKey={['id']} />)
    expect(screen.getByText('Primary key')).toBeInTheDocument()
  })

  it('numbers the columns of a composite key in their chosen order', () => {
    const field = (name: string) => ({
      name,
      type: 'string' as const,
      physicalType: 'BYTE_ARRAY',
      logicalType: null,
      nullable: false,
      compressedSize: 0,
    })
    setHook({ fields: [field('pref'), field('city')] })

    // The key's own order, not the table's: city was picked first.
    render(<ResourceFields resourceId="r1" primaryKey={['city', 'pref']} />)
    expect(screen.getByText('Primary key 1')).toBeInTheDocument()
    expect(screen.getByText('Primary key 2')).toBeInTheDocument()
  })

  describe('column roles (ADR-063)', () => {
    const field = (name: string) => ({
      name,
      type: 'string' as const,
      physicalType: 'BYTE_ARRAY',
      logicalType: null,
      nullable: false,
      compressedSize: 0,
    })
    const schemaOf = (...names: string[]): ResourceSchema => ({
      rowCount: 1,
      columns: names.map((name) => ({ name, type: 'string', nullable: false, nullCount: 0 })),
    })

    it('shows each role, and not the rule that decided it', () => {
      setHook({ fields: [field('定員'), field('施設コード')] })
      render(
        <ResourceFields
          resourceId="r1"
          schema={schemaOf('定員', '施設コード')}
          columnRoles={[{ role: 'numeric-text' }, { role: 'identifier' }]}
        />
      )
      expect(screen.getByText('Role')).toBeInTheDocument()
      expect(screen.getByText('Number (written as text)')).toBeInTheDocument()
      expect(screen.getByText('Identifier')).toBeInTheDocument()
      // The reasons are on the editors' settings, not the public page
      expect(screen.queryByText(/number-shaped/)).not.toBeInTheDocument()
    })

    it('leaves the role out where the table has none', () => {
      setHook({ fields: [field('a')] })
      render(<ResourceFields resourceId="r1" schema={schemaOf('a')} columnRoles={null} />)
      expect(screen.queryByText('Role')).not.toBeInTheDocument()
    })

    it('does not put a role on a field the schema does not describe', () => {
      // The footer and the schema come from two requests; a reprocess between
      // them must not label one table's columns with the other's roles
      setHook({ fields: [field('new')] })
      render(
        <ResourceFields
          resourceId="r1"
          schema={schemaOf('old')}
          columnRoles={[{ role: 'category' }]}
        />
      )
      expect(screen.getByText('Role')).toBeInTheDocument()
      expect(screen.queryByText('Category')).not.toBeInTheDocument()
    })
  })
})
