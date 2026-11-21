import { describe, it, expect } from 'vitest'
import { decimalText } from '../use-duckdb'

describe('decimalText', () => {
  it('places the point by the scale, as the hyparquet preview shows the number', () => {
    expect(decimalText('15', 1)).toBe('1.5')
    expect(decimalText('-325', 2)).toBe('-3.25')
    expect(decimalText('5', 3)).toBe('0.005')
    expect(decimalText('-5', 3)).toBe('-0.005')
    expect(decimalText('3000', 3)).toBe('3')
    expect(decimalText('42', 0)).toBe('42')
  })

  it('keeps every digit of a wide decimal', () => {
    expect(decimalText('1234567890123456789025', 2)).toBe('12345678901234567890.25')
  })
})
