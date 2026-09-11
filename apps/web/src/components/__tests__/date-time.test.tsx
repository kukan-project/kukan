import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { act, type ReactElement } from 'react'
import { hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import {
  formatDate,
  formatDateTime,
  formatDateTimeCompact,
  DateTime,
  CompactDate,
} from '../date-time'

// The site's zone has to differ from this host's, or the flip to the viewer's
// zone would be invisible and the hydration tests below would prove nothing.
const SITE_TIME_ZONE =
  Intl.DateTimeFormat().resolvedOptions().timeZone === 'UTC' ? 'Asia/Tokyo' : 'UTC'
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTimeZone: () => SITE_TIME_ZONE,
}))

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

describe('formatDateTime with a time zone', () => {
  const iso = '2025-06-15T10:30:00Z'

  it('formats the clock time and zone name in that zone', () => {
    expect(formatDateTime(iso, 'ja', 'Asia/Tokyo')).toBe('2025年6月15日 19時30分 (日本標準時)')
    expect(formatDateTime(iso, 'ja', 'UTC')).toBe('2025年6月15日 10時30分 (協定世界時)')
    expect(formatDateTime(iso, 'en', 'UTC')).toBe(
      'June 15, 2025 10:30 AM (Coordinated Universal Time)'
    )
  })

  it('pads single-digit Japanese hours and minutes', () => {
    expect(formatDateTime('2025-06-15T00:05:00+09:00', 'ja', 'Asia/Tokyo')).toContain('00時05分')
  })
})

describe('server render', () => {
  it("renders the text in the site's zone, whatever the host zone", () => {
    const iso = '2025-06-15T10:30:00Z'
    expect(renderToString(<DateTime value={iso} />)).toBe(
      `<time dateTime="${iso}">${formatDateTime(iso, 'en', SITE_TIME_ZONE)}</time>`
    )
    expect(renderToString(<CompactDate value={iso} />)).toBe(
      `<time dateTime="${iso}">${formatDate(iso, 'en', SITE_TIME_ZONE)}</time>`
    )
  })
})

describe('hydration', () => {
  const iso = '2025-06-15T10:30:00Z'

  async function hydrate(serverHtml: string, element: ReactElement) {
    const container = document.createElement('div')
    container.innerHTML = serverHtml
    const errors: unknown[] = []
    let root: Root | undefined
    await act(async () => {
      root = hydrateRoot(container, element, {
        onRecoverableError: (error) => errors.push(error),
      })
    })
    const text = container.textContent
    await act(async () => root?.unmount())
    return { text, errors }
  }

  it("matches the server's text, then shows the host's zone", async () => {
    const element = <DateTime value={iso} />
    const serverHtml = renderToString(element)
    const { text, errors } = await hydrate(serverHtml, element)
    expect(errors).toEqual([])
    expect(text).toBe(formatDateTime(iso, 'en'))
    expect(serverHtml).not.toContain(formatDateTime(iso, 'en'))
  })

  // The guard the test above relies on: text from one zone hydrated against
  // another does mismatch, and React reports it.
  it('reports a mismatch when the two renders use different zones (control)', async () => {
    const serverHtml = `<time dateTime="${iso}">${formatDateTime(iso, 'en', 'UTC')}</time>`
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { errors } = await hydrate(
      serverHtml,
      <time dateTime={iso}>{formatDateTime(iso, 'en', 'Asia/Tokyo')}</time>
    )
    spy.mockRestore()
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toMatch(/hydrat/i)
  })
})
