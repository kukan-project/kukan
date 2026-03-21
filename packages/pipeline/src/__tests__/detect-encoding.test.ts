import { describe, it, expect } from 'vitest'
import Encoding from 'encoding-japanese'
import { detectEncoding } from '../node-utils'

describe('detectEncoding', () => {
  it('should auto-detect ASCII for CSV', () => {
    const buf = Buffer.from('name,age\nAlice,30\n')
    expect(detectEncoding('csv', buf)).toBe('ASCII')
  })

  it('should auto-detect Shift_JIS for CSV', () => {
    const sjisArray = Encoding.convert(Encoding.stringToCode('名前,年齢\n太郎,30\n'), {
      to: 'SJIS',
      from: 'UNICODE',
    })
    const buf = Buffer.from(sjisArray)
    expect(detectEncoding('csv', buf)).toBe('SJIS')
  })

  it('should auto-detect for TSV', () => {
    const buf = Buffer.from('name\tage\nAlice\t30\n')
    expect(detectEncoding('tsv', buf)).toBe('ASCII')
  })

  it('should auto-detect for TXT', () => {
    const buf = Buffer.from('Hello, world!')
    expect(detectEncoding('txt', buf)).toBe('ASCII')
  })

  it('should auto-detect for HTML', () => {
    const buf = Buffer.from('<html><body>Hello</body></html>')
    expect(detectEncoding('html', buf)).toBe('ASCII')
  })

  it('should auto-detect for HTM', () => {
    const buf = Buffer.from('<html><body>Hello</body></html>')
    expect(detectEncoding('htm', buf)).toBe('ASCII')
  })

  it('should return UTF8 for JSON', () => {
    const buf = Buffer.from('{"key":"value"}')
    expect(detectEncoding('json', buf)).toBe('UTF8')
  })

  it('should return UTF8 for GeoJSON', () => {
    const buf = Buffer.from('{"type":"FeatureCollection"}')
    expect(detectEncoding('geojson', buf)).toBe('UTF8')
  })

  it('should return UTF8 for MD', () => {
    const buf = Buffer.from('# Hello')
    expect(detectEncoding('md', buf)).toBe('UTF8')
  })

  it('should parse XML encoding="Shift_JIS" declaration', () => {
    const buf = Buffer.from('<?xml version="1.0" encoding="Shift_JIS"?><root/>')
    expect(detectEncoding('xml', buf)).toBe('SJIS')
  })

  it('should parse XML encoding="EUC-JP" declaration', () => {
    const buf = Buffer.from('<?xml version="1.0" encoding="EUC-JP"?><root/>')
    expect(detectEncoding('xml', buf)).toBe('EUCJP')
  })

  it('should parse XML encoding="ISO-2022-JP" declaration', () => {
    const buf = Buffer.from('<?xml version="1.0" encoding="ISO-2022-JP"?><root/>')
    expect(detectEncoding('xml', buf)).toBe('JIS')
  })

  it('should parse XML encoding="UTF-8" declaration', () => {
    const buf = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><root/>')
    expect(detectEncoding('xml', buf)).toBe('UTF8')
  })

  it('should default to UTF8 for XML without declaration', () => {
    const buf = Buffer.from('<root><item>hello</item></root>')
    expect(detectEncoding('xml', buf)).toBe('UTF8')
  })

  it('should default to UTF8 for XML with version-only declaration', () => {
    const buf = Buffer.from('<?xml version="1.0"?><root/>')
    expect(detectEncoding('xml', buf)).toBe('UTF8')
  })

  it('should handle case-insensitive XML encoding names', () => {
    const buf = Buffer.from('<?xml version="1.0" encoding="shift_jis"?><root/>')
    expect(detectEncoding('xml', buf)).toBe('SJIS')
  })
})
