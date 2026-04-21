import { describe, it, expect } from 'vitest'
import { formatBytes } from '../format-utils'

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
