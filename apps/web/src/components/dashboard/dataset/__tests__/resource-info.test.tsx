import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ResourceSchema } from '@kukan/shared'
import { ResourceInfo } from '../resource-info'

vi.mock('@/hooks/use-site-settings', () => ({
  useSiteSettings: () => ({ resourceSummaryEnabled: true }),
}))

function schemaOf(rowCount: number, names: string[]): ResourceSchema {
  return {
    rowCount,
    columns: names.map((name) => ({ name, type: 'string', nullable: true, nullCount: 0 })),
  }
}

describe('ResourceInfo', () => {
  it('lists what the catalogue holds, with the table shape and the AI description', () => {
    render(
      <ResourceInfo
        resource={{
          id: 'r1',
          format: 'CSV',
          mimetype: 'text/csv',
          size: 2048,
          hash: 'sha256:0123456789abcdef0123456789',
          summary: 'この資料は人口の統計である。',
          summaryMeta: { source: 'ai', material: 'schema', version: 2 },
        }}
        latestVersion={2}
        schema={schemaOf(1234, ['a', 'b'])}
      />
    )

    expect(screen.getByText('text/csv')).toBeInTheDocument()
    expect(screen.getByText('v2')).toBeInTheDocument()
    expect(screen.getByText('Rows').nextSibling).toHaveTextContent('1,234')
    expect(screen.getByText('Columns').nextSibling).toHaveTextContent('2')
    expect(screen.getByText('sha256:0123456789abcdef0123456789')).toBeInTheDocument()
    expect(screen.getByText('この資料は人口の統計である。')).toBeInTheDocument()
    // Read-only: nothing here edits the description
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('shows no table shape for a file that is not a table, and leaves out what is unknown', () => {
    render(<ResourceInfo resource={{ id: 'r2', format: 'PDF' }} schema={schemaOf(3, ['a'])} />)

    expect(screen.queryByText('Rows')).not.toBeInTheDocument()
    expect(screen.queryByText('MIME type')).not.toBeInTheDocument()
  })

  it('shows the table shape of a workbook only when its reading found columns', () => {
    const { unmount } = render(
      <ResourceInfo resource={{ id: 'r3', format: 'XLSX' }} schema={schemaOf(0, [])} />
    )
    expect(screen.queryByText('Rows')).not.toBeInTheDocument()
    unmount()

    render(
      <ResourceInfo resource={{ id: 'r3', format: 'XLSX' }} schema={schemaOf(12, ['a', 'b'])} />
    )
    expect(screen.getByText('Rows').nextSibling).toHaveTextContent('12')
    expect(screen.getByText('Columns').nextSibling).toHaveTextContent('2')
  })

  it('shows no description that was hidden from readers', () => {
    render(
      <ResourceInfo
        resource={{
          id: 'r3',
          format: 'PDF',
          summary: 'hidden text',
          summaryMeta: { source: 'ai', hidden: true },
        }}
      />
    )
    expect(screen.queryByText('hidden text')).not.toBeInTheDocument()
  })
})
