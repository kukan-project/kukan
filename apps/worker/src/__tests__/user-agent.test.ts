import { describe, it, expect } from 'vitest'
import { buildUserAgent } from '../user-agent'

describe('buildUserAgent', () => {
  it('names the release and the site an operator can reach whoever runs it through', () => {
    expect(buildUserAgent({ USER_AGENT_URL: 'https://catalog.example/' }, '0.31.0')).toBe(
      'KUKAN/0.31.0 (+https://catalog.example)'
    )
  })

  it('names only itself when no site is configured', () => {
    expect(buildUserAgent({}, '0.31.0')).toBe('KUKAN/0.31.0')
  })

  it('still names itself when the release cannot be read', () => {
    expect(buildUserAgent({}, null)).toBe('KUKAN')
  })

  it("reads the release from the repository's package.json", async () => {
    const { version } = (await import('../../../../package.json')).default
    expect(buildUserAgent({})).toBe(`KUKAN/${version}`)
  })
})
