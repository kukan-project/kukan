import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AnalyticsDateRange } from '../analytics-date-range'

describe('AnalyticsDateRange', () => {
  const defaultProps = {
    startDate: '30daysAgo',
    endDate: 'today',
    onRangeChange: vi.fn(),
  }

  it('renders preset options', () => {
    render(<AnalyticsDateRange {...defaultProps} />)
    // Select trigger should show the current preset
    expect(screen.getByRole('combobox')).toBeInTheDocument()
  })

  it('detects 30d preset from startDate', () => {
    render(<AnalyticsDateRange {...defaultProps} startDate="30daysAgo" />)
    // No date inputs should be visible for preset mode
    expect(screen.queryByDisplayValue(/\d{4}-\d{2}-\d{2}/)).not.toBeInTheDocument()
  })

  it('detects 7d preset', () => {
    render(<AnalyticsDateRange {...defaultProps} startDate="7daysAgo" />)
    expect(screen.queryByDisplayValue(/\d{4}-\d{2}-\d{2}/)).not.toBeInTheDocument()
  })

  it('shows date inputs in custom mode', () => {
    render(<AnalyticsDateRange {...defaultProps} startDate="2026-01-01" endDate="2026-06-01" />)
    expect(screen.getByDisplayValue('2026-01-01')).toBeInTheDocument()
    expect(screen.getByDisplayValue('2026-06-01')).toBeInTheDocument()
  })

  it('calls onRangeChange when custom start date changes', () => {
    const onRangeChange = vi.fn()
    render(
      <AnalyticsDateRange
        startDate="2026-01-01"
        endDate="2026-06-01"
        onRangeChange={onRangeChange}
      />
    )
    fireEvent.change(screen.getByDisplayValue('2026-01-01'), {
      target: { value: '2026-03-01' },
    })
    expect(onRangeChange).toHaveBeenCalledWith('2026-03-01', '2026-06-01')
  })

  it('calls onRangeChange when custom end date changes', () => {
    const onRangeChange = vi.fn()
    render(
      <AnalyticsDateRange
        startDate="2026-01-01"
        endDate="2026-06-01"
        onRangeChange={onRangeChange}
      />
    )
    fireEvent.change(screen.getByDisplayValue('2026-06-01'), {
      target: { value: '2026-12-31' },
    })
    expect(onRangeChange).toHaveBeenCalledWith('2026-01-01', '2026-12-31')
  })
})
