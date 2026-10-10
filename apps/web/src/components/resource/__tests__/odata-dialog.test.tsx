import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { OdataKey } from '@kukan/shared'
import { OdataDialog, type ReportedRefusal } from '../odata-dialog'

const OWN_KEY: OdataKey = { names: ['code'], synthetic: false, fallback: null }
const ROW_ID: OdataKey = { names: ['RowId'], synthetic: true, fallback: 'not-designated' }

function renderPanel(
  odataRefusal: ReportedRefusal | null = null,
  odataKey: OdataKey | null = ROW_ID,
  odataWideRows = false
) {
  render(
    <OdataDialog
      resourceId="r1"
      odataRefusal={odataRefusal}
      odataKey={odataKey}
      odataWideRows={odataWideRows}
    />
  )
  return screen.getByRole('button', { name: 'OData' })
}

describe('OdataDialog (ADR-055)', () => {
  it('offers both URLs when the feed is served', () => {
    fireEvent.click(renderPanel())
    expect(screen.getByText('http://localhost:3000/odata/v1/resources/r1/Rows')).toBeInTheDocument()
    expect(screen.getByText('http://localhost:3000/odata/v1/resources/r1')).toBeInTheDocument()
  })

  it('dims the button and says why, without marking it unavailable', () => {
    // The button works — it explains the refusal — so neither `disabled` (no
    // hover events, unreachable by keyboard) nor `aria-disabled` (tells a
    // screen reader not to press the control carrying the explanation).
    const button = renderPanel({
      reason: 'unsupported-columns',
      columns: ['人口（人）', '面積 (km²)'],
    })
    expect(button).not.toBeDisabled()
    expect(button).not.toHaveAttribute('aria-disabled')
    expect(button).toHaveClass('opacity-60')
    expect(button.getAttribute('title')).toMatch(/人口（人）/)

    // and the same text is in the accessible tree, not just the tooltip
    const description = document.getElementById(button.getAttribute('aria-describedby')!)
    expect(description).toHaveTextContent('人口（人）')

    fireEvent.click(button)
    expect(screen.getAllByText(/人口（人）/).length).toBeGreaterThan(0)
  })

  it('names the headings at fault, and counts the rest', () => {
    fireEvent.click(
      renderPanel({
        reason: 'unsupported-columns',
        columns: ['a b', 'c d', 'e f', 'g h', 'i j', 'k l', 'm n'],
      })
    )
    // twice over: the dialog's own paragraph, and the trigger's description
    expect(screen.getAllByText(/“a b”/)).toHaveLength(2)
    expect(screen.getAllByText(/and 2 more/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/\/odata\/v1/)).not.toBeInTheDocument()
  })

  it("says what this table's rows are identified by, not the rule in general", () => {
    fireEvent.click(renderPanel(null, OWN_KEY))
    // Under a heading of its own, so it does not read as one more note about
    // OData in general
    expect(screen.getByText('How rows are identified in this table')).toBeInTheDocument()
    expect(screen.getByText(/primary key “code”/)).toBeInTheDocument()
    expect(screen.queryByText(/RowId/)).not.toBeInTheDocument()
    // and nothing to remove, because nothing was added
    expect(screen.queryByText(/remove that column/)).not.toBeInTheDocument()
  })

  it('says why a column was added, so the publisher knows what to do about it', () => {
    fireEvent.click(renderPanel(null, { names: ['RowId'], synthetic: true, fallback: 'key-float' }))
    expect(screen.getByText(/Number \(floating-point\) column/)).toBeInTheDocument()
    expect(screen.getByText(/remove that column in the BI tool/)).toBeInTheDocument()
  })

  it('says so when the dataset is not public', () => {
    fireEvent.click(renderPanel({ reason: 'not-public', columns: [] }))
    expect(screen.getAllByText(/public datasets/).length).toBeGreaterThan(0)
  })

  it('cautions where the rows may be too wide to read, without refusing', () => {
    fireEvent.click(renderPanel(null, ROW_ID, true))
    // Said as a status, not an alert: nothing is wrong yet, and the URLs are
    // still offered — only the read can settle it (ADR-055 §6).
    expect(screen.getByRole('status')).toHaveTextContent(/BI|read/i)
    expect(screen.getByText('http://localhost:3000/odata/v1/resources/r1/Rows')).toBeInTheDocument()
  })

  it('says nothing about width where the table is comfortably inside it', () => {
    fireEvent.click(renderPanel())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
