import { describe, it, expect } from 'vitest'
import { getFormatColorClass } from '../format-colors'

describe('getFormatColorClass', () => {
  it('should return default gray for null/undefined/empty', () => {
    const defaultClass = 'bg-gray-500 text-white'
    expect(getFormatColorClass(null)).toBe(defaultClass)
    expect(getFormatColorClass(undefined)).toBe(defaultClass)
    expect(getFormatColorClass('')).toBe(defaultClass)
  })

  it('should return correct color for known formats', () => {
    expect(getFormatColorClass('csv')).toBe('bg-green-600 text-white')
    expect(getFormatColorClass('pdf')).toBe('bg-red-600 text-white')
    expect(getFormatColorClass('json')).toBe('bg-purple-600 text-white')
    expect(getFormatColorClass('xlsx')).toBe('bg-blue-700 text-white')
    expect(getFormatColorClass('zip')).toBe('bg-gray-600 text-white')
  })

  it('should be case-insensitive', () => {
    expect(getFormatColorClass('CSV')).toBe('bg-green-600 text-white')
    expect(getFormatColorClass('Pdf')).toBe('bg-red-600 text-white')
    expect(getFormatColorClass('JSON')).toBe('bg-purple-600 text-white')
  })

  it('should return default gray for unknown formats', () => {
    expect(getFormatColorClass('unknown')).toBe('bg-gray-500 text-white')
    expect(getFormatColorClass('mp4')).toBe('bg-gray-500 text-white')
  })
})
