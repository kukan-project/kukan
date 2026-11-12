import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ResourceInfo } from '../resource-info'

const fetched = vi.hoisted(() => ({ paths: [] as (string | null)[], data: null as unknown }))
vi.mock('@/hooks/use-fetch', () => ({
  useFetch: (path: string | null) => {
    fetched.paths.push(path)
    return { data: path ? fetched.data : null, loading: false, error: false }
  },
}))
vi.mock('@/hooks/use-site-settings', () => ({
  useSiteSettings: () => ({ resourceSummaryEnabled: true }),
}))

beforeEach(() => {
  fetched.paths = []
  fetched.data = null
})

describe('ResourceInfo', () => {
  it('lists what the catalogue holds, with the table shape and the AI description', () => {
    fetched.data = {
      schema: { rowCount: 1234, columns: [{ name: 'a' }, { name: 'b' }] },
    }
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
      />
    )

    expect(fetched.paths).toContain('/api/v1/resources/r1/schema')
    expect(screen.getByText('text/csv')).toBeInTheDocument()
    expect(screen.getByText('v2')).toBeInTheDocument()
    expect(screen.getByText('Rows').nextSibling).toHaveTextContent('1,234')
    expect(screen.getByText('Columns').nextSibling).toHaveTextContent('2')
    expect(screen.getByText('sha256:0123456789abcdef0123456789')).toBeInTheDocument()
    expect(screen.getByText('この資料は人口の統計である。')).toBeInTheDocument()
    // Read-only: nothing here edits the description
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('asks for no table shape for a file that is not a table, and leaves out what is unknown', () => {
    render(<ResourceInfo resource={{ id: 'r2', format: 'PDF' }} />)

    expect(fetched.paths.every((p) => p === null)).toBe(true)
    expect(screen.queryByText('Rows')).not.toBeInTheDocument()
    expect(screen.queryByText('MIME type')).not.toBeInTheDocument()
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
