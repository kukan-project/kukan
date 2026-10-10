import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { createSiteMetadata } from '@/lib/site-metadata'
import { SiteDate, SiteNumber, SiteText } from '../site-metadata'

vi.mock('@/lib/server-api', () => ({
  getSiteMetadata: async () =>
    createSiteMetadata({
      population: 123456,
      change: -12,
      'as-of': '2026-06-01',
      tagline: { ja: '探す', en: 'Find' },
    }),
}))

// The setup's next-intl/server mock reads as an English page
describe('site metadata components', () => {
  it('should render a number, a signed change, a date and a text for the page locale', async () => {
    const { container } = render(
      <p>
        {await SiteNumber({ name: 'population' })}|
        {await SiteNumber({ name: 'change', signed: true })}|{await SiteDate({ name: 'as-of' })}|
        {await SiteText({ name: 'tagline' })}
      </p>
    )
    expect(container).toHaveTextContent('123,456|-12|June 1, 2026|Find')
    expect(container.querySelector('time')).toHaveAttribute('datetime', '2026-06-01')
  })

  it('should render nothing for a missing key or a value of another type', async () => {
    expect(await SiteNumber({ name: 'households' })).toBeNull()
    expect(await SiteDate({ name: 'population' })).toBeNull()
    expect(await SiteNumber({ name: 'tagline' })).toBeNull()
  })
})
