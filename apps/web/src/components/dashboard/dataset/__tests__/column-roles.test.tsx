import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { ColumnRolesView } from '@kukan/shared'
import { clientFetch } from '@/lib/client-api'
import { ColumnRoles } from '../column-roles'

vi.mock('@/lib/client-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/client-api')>()),
  clientFetch: vi.fn(),
}))

const answer = (view: ColumnRolesView) =>
  vi.mocked(clientFetch).mockResolvedValue({ ok: true, json: async () => view } as Response)

beforeEach(() => {
  vi.mocked(clientFetch).mockReset()
})

describe('ColumnRoles', () => {
  it('shows each role with the rule that decided it', async () => {
    answer({
      columns: [
        {
          name: '定員',
          type: 'string',
          role: 'numeric-text',
          roleBasis: { rule: 'number-shape', share: 0.92, examples: ['-', '1,000'] },
        },
        {
          name: '施設コード',
          type: 'string',
          role: 'identifier',
          roleBasis: { rule: 'name-hint', hint: 'コード' },
        },
      ],
    })
    render(<ColumnRoles resourceId="r1" />)

    expect(await screen.findByText('Number (written as text)')).toBeInTheDocument()
    // What keeps it from being a number, for whoever publishes it
    expect(
      screen.getByText(
        '92% of values are number-shaped (values that do not read as numbers: -, 1,000)'
      )
    ).toBeInTheDocument()
    expect(screen.getByText('The field name contains “コード”')).toBeInTheDocument()
    expect(clientFetch).toHaveBeenCalledWith('/api/v1/resources/r1/column-roles', expect.anything())
  })

  it('shows nothing where the table has no roles', async () => {
    answer({ columns: null })
    const { container } = render(<ColumnRoles resourceId="r1" />)
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })
})
