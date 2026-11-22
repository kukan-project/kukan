import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ExplorerTable } from '../explorer-table'

function renderRows(rows: Record<string, string | null>[]) {
  return render(
    <table>
      <ExplorerTable
        columns={['name']}
        rows={rows}
        sort={null}
        filters={[]}
        onSortChange={vi.fn()}
        onFilterApply={vi.fn()}
        onFilterClear={vi.fn()}
      />
    </table>
  )
}

describe('ExplorerTable', () => {
  it('tells a cell with no value from an empty string and from a value spelling the label', () => {
    renderRows([{ name: null }, { name: '' }, { name: '(no value)' }])
    const cells = screen.getAllByRole('cell')

    // Drawn from an attribute, so copying the cell copies nothing
    const none = cells[0].querySelector('[data-label]')!
    expect(none).toHaveAttribute('data-label', '(no value)')
    expect(none).toHaveAttribute('title', 'No value (NULL)')
    expect(cells[0]).toHaveTextContent(/^$/)

    expect(cells[1].querySelector('[data-label]')).toBeNull()
    expect(cells[1]).toHaveTextContent(/^$/)

    expect(cells[2].querySelector('[data-label]')).toBeNull()
    expect(cells[2]).toHaveTextContent('(no value)')
  })
})
