/// <reference types="node" />
import { describe, it, expect } from 'vitest'
import { detectEncoding, bufferToUtf8 } from '../pipeline/node-utils'

describe('detectEncoding', () => {
  // --- Auto-detect formats (CSV/TSV/TXT/HTML) ---

  it('should detect UTF-8 for CSV with ASCII content', () => {
    const buf = Buffer.from('name,age\nAlice,30\n')
    // chardet returns ISO-8859-1 for pure ASCII, which is a valid superset
    const result = detectEncoding('csv', buf)
    expect(['ISO-8859-1', 'UTF-8', 'ASCII']).toContain(result)
  })

  it('should detect Shift_JIS for CSV with SJIS content', () => {
    // First 176 bytes of a real Shift_JIS CSV (population statistics header)
    // "都道府県コード又は市区町村コード,地域コード,都道府県名,市区町村名,調査年月日,..."
    const buf = Buffer.from([
      0x93, 0x73, 0x93, 0xb9, 0x95, 0x7b, 0x8c, 0xa7, 0x83, 0x52, 0x81, 0x5b, 0x83, 0x68, 0x96,
      0x94, 0x82, 0xcd, 0x8e, 0x73, 0x8b, 0xe6, 0x92, 0xac, 0x91, 0xba, 0x83, 0x52, 0x81, 0x5b,
      0x83, 0x68, 0x2c, 0x92, 0x6e, 0x88, 0xe6, 0x83, 0x52, 0x81, 0x5b, 0x83, 0x68, 0x2c, 0x93,
      0x73, 0x93, 0xb9, 0x95, 0x7b, 0x8c, 0xa7, 0x96, 0xbc, 0x2c, 0x8e, 0x73, 0x8b, 0xe6, 0x92,
      0xac, 0x91, 0xba, 0x96, 0xbc, 0x2c, 0x92, 0xb2, 0x8d, 0xb8, 0x94, 0x4e, 0x8c, 0x8e, 0x93,
      0xfa, 0x2c, 0x92, 0x6e, 0x88, 0xe6, 0x96, 0xbc, 0x2c, 0x91, 0x8d, 0x90, 0x6c, 0x8c, 0xfb,
      0x2c, 0x92, 0x6a, 0x90, 0xab, 0x2c, 0x8f, 0x97, 0x90, 0xab, 0x2c, 0x30, 0x2d, 0x34, 0x8d,
      0xce, 0x82, 0xcc, 0x92, 0x6a, 0x90, 0xab, 0x2c, 0x30, 0x2d, 0x34, 0x8d, 0xce, 0x82, 0xcc,
      0x8f, 0x97, 0x90, 0xab, 0x2c, 0x35, 0x2d, 0x39, 0x8d, 0xce, 0x82, 0xcc, 0x92, 0x6a, 0x90,
      0xab, 0x2c, 0x35, 0x2d, 0x39, 0x8d, 0xce, 0x82, 0xcc, 0x8f, 0x97, 0x90, 0xab, 0x2c, 0x31,
      0x30, 0x2d, 0x31, 0x34, 0x8d, 0xce, 0x82, 0xcc, 0x92, 0x6a, 0x90, 0xab, 0x2c, 0x31, 0x30,
      0x2d, 0x31, 0x34, 0x8d, 0xce, 0x82, 0xcc, 0x8f, 0x97, 0x90, 0xab,
    ])
    expect(detectEncoding('csv', buf)).toBe('Shift_JIS')
  })

  it('should detect UTF-8 for CSV with UTF-8 Japanese', () => {
    const buf = Buffer.from('名前,年齢\n太郎,30\n花子,25\n')
    expect(detectEncoding('csv', buf)).toBe('UTF-8')
  })

  it('should auto-detect for TSV', () => {
    const buf = Buffer.from('名前\t年齢\n太郎\t30\n')
    expect(detectEncoding('tsv', buf)).toBe('UTF-8')
  })

  it('should auto-detect for TXT', () => {
    const buf = Buffer.from('Hello, world!')
    const result = detectEncoding('txt', buf)
    expect(['ISO-8859-1', 'UTF-8', 'ASCII']).toContain(result)
  })

  it('should auto-detect for HTML', () => {
    const buf = Buffer.from('<html><body>こんにちは</body></html>')
    expect(detectEncoding('html', buf)).toBe('UTF-8')
  })

  it('should auto-detect for HTM (alias)', () => {
    const buf = Buffer.from('<html><body>テスト</body></html>')
    expect(detectEncoding('htm', buf)).toBe('UTF-8')
  })

  it('should auto-detect for text (alias of txt)', () => {
    const buf = Buffer.from('日本語テキスト')
    expect(detectEncoding('text', buf)).toBe('UTF-8')
  })

  it('should return UTF-8 for unknown format', () => {
    const buf = Buffer.from('anything')
    expect(detectEncoding('pdf', buf)).toBe('UTF-8')
    expect(detectEncoding('xlsx', buf)).toBe('UTF-8')
    expect(detectEncoding('', buf)).toBe('UTF-8')
  })

  // --- Fixed encoding formats ---

  it('should return UTF-8 for JSON', () => {
    expect(detectEncoding('json', Buffer.from('{"key":"value"}'))).toBe('UTF-8')
  })

  it('should return UTF-8 for GeoJSON', () => {
    expect(detectEncoding('geojson', Buffer.from('{"type":"FeatureCollection"}'))).toBe('UTF-8')
  })

  it('should return UTF-8 for MD', () => {
    expect(detectEncoding('md', Buffer.from('# Hello'))).toBe('UTF-8')
  })

  // --- XML declaration parsing ---

  it('should parse XML encoding="Shift_JIS" declaration', () => {
    const buf = Buffer.from('<?xml version="1.0" encoding="Shift_JIS"?><root/>')
    expect(detectEncoding('xml', buf)).toBe('Shift_JIS')
  })

  it('should parse XML encoding="EUC-JP" declaration', () => {
    const buf = Buffer.from('<?xml version="1.0" encoding="EUC-JP"?><root/>')
    expect(detectEncoding('xml', buf)).toBe('EUC-JP')
  })

  it('should parse XML encoding="ISO-2022-JP" declaration', () => {
    const buf = Buffer.from('<?xml version="1.0" encoding="ISO-2022-JP"?><root/>')
    expect(detectEncoding('xml', buf)).toBe('ISO-2022-JP')
  })

  it('should parse XML encoding="UTF-8" declaration', () => {
    const buf = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><root/>')
    expect(detectEncoding('xml', buf)).toBe('UTF-8')
  })

  it('should default to UTF-8 for XML without declaration', () => {
    expect(detectEncoding('xml', Buffer.from('<root><item>hello</item></root>'))).toBe('UTF-8')
  })

  it('should default to UTF-8 for XML with version-only declaration', () => {
    expect(detectEncoding('xml', Buffer.from('<?xml version="1.0"?><root/>'))).toBe('UTF-8')
  })

  it('should preserve original case in XML encoding declaration', () => {
    const buf = Buffer.from('<?xml version="1.0" encoding="shift_jis"?><root/>')
    expect(detectEncoding('xml', buf)).toBe('shift_jis')
  })

  // --- Regression: SJIS misdetection ---

  it('should detect Shift_JIS even when data rows are mostly ASCII numbers', () => {
    // Shift_JIS header with 200+ numeric columns — previously misdetected as UNICODE
    // Header: 都道府県コード,市区町村名,...
    const header = Buffer.from([
      0x93, 0x73, 0x93, 0xb9, 0x95, 0x7b, 0x8c, 0xa7, 0x83, 0x52, 0x81, 0x5b, 0x83, 0x68, 0x2c,
      0x8e, 0x73, 0x8b, 0xe6, 0x92, 0xac, 0x91, 0xba, 0x96, 0xbc, 0x0a,
    ])
    // Data: 402303,糸島市,2019-05-31,1515,758,757,26,27,...(many numbers)
    const dataRow = Buffer.from([
      0x34,
      0x30,
      0x32,
      0x33,
      0x30,
      0x33,
      0x2c, // 402303,
      0x8e,
      0x85,
      0x93,
      0x87,
      0x8e,
      0x73,
      0x2c, // 糸島市,
      0x32,
      0x30,
      0x31,
      0x39,
      0x2d,
      0x30,
      0x35,
      0x2d,
      0x33,
      0x31,
      0x2c, // 2019-05-31,
      // lots of numbers
      0x31,
      0x35,
      0x31,
      0x35,
      0x2c,
      0x37,
      0x35,
      0x38,
      0x2c,
      0x37,
      0x35,
      0x37,
      0x2c,
      0x32,
      0x36,
      0x2c,
      0x32,
      0x37,
      0x2c,
      0x33,
      0x38,
      0x2c,
      0x32,
      0x38,
      0x2c,
      0x35,
      0x35,
      0x2c,
      0x34,
      0x34,
      0x2c,
      0x34,
      0x32,
      0x2c,
      0x32,
      0x39,
      0x0a,
    ])
    const buf = Buffer.concat([header, ...Array(500).fill(dataRow)])
    expect(buf.length).toBeGreaterThan(10_000)
    expect(detectEncoding('csv', buf)).toBe('Shift_JIS')
  })
})

describe('bufferToUtf8', () => {
  it('should pass through UTF-8 buffers', () => {
    const buf = Buffer.from('名前,年齢')
    expect(bufferToUtf8(buf, 'UTF-8')).toBe('名前,年齢')
  })

  it('should convert Shift_JIS to UTF-8', () => {
    // "名前" in Shift_JIS
    const buf = Buffer.from([0x96, 0xbc, 0x91, 0x4f])
    expect(bufferToUtf8(buf, 'Shift_JIS')).toBe('名前')
  })

  it('should convert EUC-JP to UTF-8', () => {
    // "日本" in EUC-JP
    const buf = Buffer.from([0xc6, 0xfc, 0xcb, 0xdc])
    expect(bufferToUtf8(buf, 'EUC-JP')).toBe('日本')
  })

  it('should handle ASCII as UTF-8', () => {
    const buf = Buffer.from('Hello')
    expect(bufferToUtf8(buf, 'ASCII')).toBe('Hello')
  })

  it('should decode ISO-8859-1 via TextDecoder', () => {
    // "Résumé" in ISO-8859-1: é = 0xE9
    const buf = Buffer.from([0x52, 0xe9, 0x73, 0x75, 0x6d, 0xe9])
    expect(bufferToUtf8(buf, 'ISO-8859-1')).toBe('Résumé')
  })

  it('should handle legacy encoding-japanese names', () => {
    // "名前" in Shift_JIS, using legacy name SJIS
    const buf = Buffer.from([0x96, 0xbc, 0x91, 0x4f])
    expect(bufferToUtf8(buf, 'SJIS')).toBe('名前')
  })

  it('should handle legacy EUCJP name', () => {
    const buf = Buffer.from([0xc6, 0xfc, 0xcb, 0xdc])
    expect(bufferToUtf8(buf, 'EUCJP')).toBe('日本')
  })

  it('should handle legacy JIS name', () => {
    // "日本" in ISO-2022-JP: ESC $ B + encoded + ESC ( B
    const buf = Buffer.from([0x1b, 0x24, 0x42, 0x46, 0x7c, 0x4b, 0x5c, 0x1b, 0x28, 0x42])
    expect(bufferToUtf8(buf, 'JIS')).toBe('日本')
  })

  it('should handle legacy UTF8 name', () => {
    const buf = Buffer.from('テスト')
    expect(bufferToUtf8(buf, 'UTF8')).toBe('テスト')
  })

  it('should handle legacy UNICODE and UNKNOWN names', () => {
    const buf = Buffer.from('Hello')
    expect(bufferToUtf8(buf, 'UNICODE')).toBe('Hello')
    expect(bufferToUtf8(buf, 'UNKNOWN')).toBe('Hello')
  })

  it('should decode EUC-KR', () => {
    // "한국" in EUC-KR
    const buf = Buffer.from([0xc7, 0xd1, 0xb1, 0xb9])
    expect(bufferToUtf8(buf, 'EUC-KR')).toBe('한국')
  })

  it('should decode Big5', () => {
    // "中文" in Big5
    const buf = Buffer.from([0xa4, 0xa4, 0xa4, 0xe5])
    expect(bufferToUtf8(buf, 'Big5')).toBe('中文')
  })

  it('should decode Windows-1252', () => {
    // "café" in Windows-1252: é = 0xE9
    const buf = Buffer.from([0x63, 0x61, 0x66, 0xe9])
    expect(bufferToUtf8(buf, 'windows-1252')).toBe('café')
  })
})
