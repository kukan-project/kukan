import { describe, it, expect } from 'vitest'
import { buildUserAgent } from '../user-agent'

describe('buildUserAgent', () => {
  it('names the site an operator can reach whoever runs it through, and never the release', () => {
    expect(buildUserAgent({ USER_AGENT_URL: 'https://catalog.example/' })).toBe(
      'KUKAN (+https://catalog.example)'
    )
  })

  it('names only itself when no site is configured', () => {
    expect(buildUserAgent({})).toBe('KUKAN')
  })
})
