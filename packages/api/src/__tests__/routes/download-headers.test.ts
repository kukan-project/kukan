import { describe, it, expect } from 'vitest'
import { downloadHeaders } from '../../routes/resources'

function disposition(filename: string): string {
  return downloadHeaders(filename, 'text/csv', null)['Content-Disposition']
}

describe('downloadHeaders', () => {
  it('should keep backslashes and quotes out of the quoted ASCII fallback', () => {
    expect(disposition('abc\\"def.csv')).toBe(
      `attachment; filename="abc__def.csv"; filename*=UTF-8''abc%5C%22def.csv`
    )
  })

  it('should replace non-ASCII in the fallback and keep it in filename*', () => {
    expect(disposition('人口.csv')).toBe(
      `attachment; filename="__.csv"; filename*=UTF-8''%E4%BA%BA%E5%8F%A3.csv`
    )
  })
})
