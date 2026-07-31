import { describe, it, expect } from 'vitest'
import { formatBytes, formatCell } from '../format-utils'

describe('formatBytes', () => {
  it('should return null for null/undefined', () => {
    expect(formatBytes(null)).toBeNull()
    expect(formatBytes(undefined)).toBeNull()
  })

  it('should return null for negative values', () => {
    expect(formatBytes(-1)).toBeNull()
    expect(formatBytes(-100)).toBeNull()
  })

  it('should return "0 B" for zero', () => {
    expect(formatBytes(0)).toBe('0 B')
  })

  it('should format bytes', () => {
    expect(formatBytes(500)).toBe('500 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('should format kilobytes', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
  })

  it('should format megabytes', () => {
    expect(formatBytes(1048576)).toBe('1.0 MB')
    expect(formatBytes(5242880)).toBe('5.0 MB')
  })

  it('should format gigabytes', () => {
    expect(formatBytes(1073741824)).toBe('1.0 GB')
  })

  it('should format terabytes', () => {
    expect(formatBytes(1099511627776)).toBe('1.0 TB')
  })
})

describe('formatCell', () => {
  it('renders a DATE as a plain date, not a JS Date toString', () => {
    // What a DATE column comes back as: midnight UTC. Showing a time of day
    // would invent precision the column does not have.
    expect(formatCell(new Date('2023-04-01T00:00:00.000Z'))).toBe('2023-04-01')
  })

  it('renders a TIMESTAMP with its time of day', () => {
    expect(formatCell(new Date('2023-04-01T09:30:15.000Z'))).toBe('2023-04-01 09:30:15')
  })

  it('renders a 64-bit integer without the BigInt suffix', () => {
    expect(formatCell(9007199254740993n)).toBe('9007199254740993')
  })

  it('renders a missing value as empty rather than "null"', () => {
    expect(formatCell(null)).toBe('')
    expect(formatCell(undefined)).toBe('')
  })

  it('leaves ordinary values alone', () => {
    expect(formatCell('札幌市')).toBe('札幌市')
    expect(formatCell(0)).toBe('0')
    expect(formatCell(false)).toBe('false')
  })
})
