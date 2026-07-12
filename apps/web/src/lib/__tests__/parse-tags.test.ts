import { describe, it, expect } from 'vitest'
import { parseTags } from '../parse-tags'

describe('parseTags', () => {
  it('should return empty array for empty input', () => {
    expect(parseTags('')).toEqual([])
    expect(parseTags('  ')).toEqual([])
  })

  it('should split on the ASCII comma and trim', () => {
    expect(parseTags('防災, 人口 ,統計')).toEqual(['防災', '人口', '統計'])
  })

  it('should also split on the Japanese ideographic comma', () => {
    expect(parseTags('防災、人口、統計')).toEqual(['防災', '人口', '統計'])
  })

  it('should filter out empty segments', () => {
    expect(parseTags('防災,,人口, ,統計')).toEqual(['防災', '人口', '統計'])
  })
})
