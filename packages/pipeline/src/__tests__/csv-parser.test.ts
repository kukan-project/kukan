import { describe, it, expect } from 'vitest'
import { parseBuffer, isCsvFormat } from '../parsers/csv-parser'
import Encoding from 'encoding-japanese'

describe('isCsvFormat', () => {
  it('should return true for CSV format', () => {
    expect(isCsvFormat('CSV')).toBe(true)
    expect(isCsvFormat('csv')).toBe(true)
  })

  it('should return true for TSV format', () => {
    expect(isCsvFormat('TSV')).toBe(true)
    expect(isCsvFormat('tsv')).toBe(true)
  })

  it('should return true for CSV mimetypes', () => {
    expect(isCsvFormat(null, 'text/csv')).toBe(true)
    expect(isCsvFormat(null, 'application/csv')).toBe(true)
    expect(isCsvFormat(null, 'text/tab-separated-values')).toBe(true)
  })

  it('should return false for non-CSV formats', () => {
    expect(isCsvFormat('PDF')).toBe(false)
    expect(isCsvFormat('JSON')).toBe(false)
    expect(isCsvFormat(null, 'application/json')).toBe(false)
    expect(isCsvFormat(null, null)).toBe(false)
  })
})

describe('parseBuffer', () => {
  it('should parse basic CSV', () => {
    const csv = 'name,age,city\nAlice,30,Tokyo\nBob,25,Osaka\n'
    const buf = Buffer.from(csv, 'utf-8')
    const result = parseBuffer(buf)

    expect(result.headers).toEqual(['name', 'age', 'city'])
    expect(result.rows).toEqual([
      ['Alice', '30', 'Tokyo'],
      ['Bob', '25', 'Osaka'],
    ])

    expect(result.encoding).toBe('ASCII')
  })

  it('should skip title rows (single non-empty cell)', () => {
    const csv = '人口統計データ,,,\n\nname,age,city\nAlice,30,Tokyo\nBob,25,Osaka\n'
    const buf = Buffer.from(csv, 'utf-8')
    const result = parseBuffer(buf)

    expect(result.headers).toEqual(['name', 'age', 'city'])
    expect(result.rows).toEqual([
      ['Alice', '30', 'Tokyo'],
      ['Bob', '25', 'Osaka'],
    ])
  })

  it('should remove footer rows', () => {
    const csv = 'name,count\nA,10\nB,20\n合計,30\n※ 2024年データ,,\n'
    const buf = Buffer.from(csv, 'utf-8')
    const result = parseBuffer(buf)

    expect(result.headers).toEqual(['name', 'count'])
    expect(result.rows).toEqual([
      ['A', '10'],
      ['B', '20'],
    ])
  })

  it('should handle empty CSV', () => {
    const buf = Buffer.from('', 'utf-8')
    const result = parseBuffer(buf)

    expect(result.headers).toEqual([])
    expect(result.rows).toEqual([])
  })

  it('should detect and convert Shift_JIS encoding', () => {
    const text = '名前,年齢\n太郎,30\n花子,25\n'
    const sjisArray = Encoding.convert(Encoding.stringToCode(text), {
      to: 'SJIS',
      from: 'UNICODE',
    })
    const buf = Buffer.from(sjisArray)
    const result = parseBuffer(buf)

    expect(result.headers).toEqual(['名前', '年齢'])
    expect(result.rows).toEqual([
      ['太郎', '30'],
      ['花子', '25'],
    ])
    expect(result.encoding).toBe('SJIS')
  })

  it('should preserve full cell values (no truncation)', () => {
    const longValue = 'x'.repeat(300)
    const csv = `name,value\ntest,${longValue}\n`
    const buf = Buffer.from(csv, 'utf-8')
    const result = parseBuffer(buf)

    expect(result.rows[0][1].length).toBe(300)
  })

  it('should handle TSV data', () => {
    const tsv = 'name\tage\nAlice\t30\nBob\t25\n'
    const buf = Buffer.from(tsv, 'utf-8')
    const result = parseBuffer(buf)

    expect(result.headers).toEqual(['name', 'age'])
    expect(result.rows).toEqual([
      ['Alice', '30'],
      ['Bob', '25'],
    ])
  })

  it('should remove footer with "備考" prefix', () => {
    const csv = 'a,b\n1,2\n備考: this is a note\n'
    const buf = Buffer.from(csv, 'utf-8')
    const result = parseBuffer(buf)

    expect(result.rows).toEqual([['1', '2']])
  })

  it('should remove footer with "出典" prefix', () => {
    const csv = 'a,b\n1,2\n出典: 総務省\n'
    const buf = Buffer.from(csv, 'utf-8')
    const result = parseBuffer(buf)

    expect(result.rows).toEqual([['1', '2']])
  })

  it('should handle multiple title rows', () => {
    const csv = 'Report Title,,,\nSubtitle,,,\n,,,\nname,age,city,country\nAlice,30,Tokyo,Japan\n'
    const buf = Buffer.from(csv, 'utf-8')
    const result = parseBuffer(buf)

    expect(result.headers).toEqual(['name', 'age', 'city', 'country'])
    expect(result.rows).toEqual([['Alice', '30', 'Tokyo', 'Japan']])
  })
})
