import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { formatDateTime, formatDateTimeCompact, DateTime, CompactDate } from '../date-time'

describe('formatDateTime', () => {
  it('should return a formatted string for a valid date', () => {
    const result = formatDateTime('2025-06-15T10:30:00Z', 'en')
    expect(result).toBeTruthy()
    expect(typeof result).toBe('string')
  })

  it('should return empty string for invalid date', () => {
    expect(formatDateTime('not-a-date', 'en')).toBe('')
  })
})

describe('formatDateTimeCompact', () => {
  it('should return a compact formatted string for a valid date', () => {
    const result = formatDateTimeCompact('2025-06-15T10:30:00Z', 'en')
    expect(result).toBeTruthy()
  })

  it('should return empty string for invalid date', () => {
    expect(formatDateTimeCompact('invalid', 'en')).toBe('')
  })
})

describe('DateTime', () => {
  it('should render a time element with dateTime attribute', () => {
    const iso = '2025-06-15T10:30:00Z'
    render(<DateTime value={iso} />)
    const el = screen.getByText(/.+/)
    expect(el.tagName).toBe('TIME')
    expect(el).toHaveAttribute('dateTime', iso)
  })

  it('should return null for invalid date', () => {
    const { container } = render(<DateTime value="invalid" />)
    expect(container.innerHTML).toBe('')
  })
})

describe('CompactDate', () => {
  it('should render a time element', () => {
    const iso = '2025-06-15T10:30:00Z'
    render(<CompactDate value={iso} />)
    const el = screen.getByText(/.+/)
    expect(el.tagName).toBe('TIME')
    expect(el).toHaveAttribute('dateTime', iso)
  })

  it('should return null for invalid date', () => {
    const { container } = render(<CompactDate value="bad" />)
    expect(container.innerHTML).toBe('')
  })
})
