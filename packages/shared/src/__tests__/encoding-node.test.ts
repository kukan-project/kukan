/// <reference types="node" />
import { describe, it, expect } from 'vitest'
import { detectEncoding, bufferToUtf8, stripTrailingReplacementChar } from '../encoding-node'

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

  // --- Regression: single-byte verdicts over short Japanese ---
  //
  // chardet scores single-byte encodings on trigram hits alone, so a handful of
  // Japanese characters loses to whichever European language the bytes happen to
  // resemble. Both fixtures are real files from the Tokyo open data portal.

  const bytes = (hex: string) => Buffer.from(hex.replace(/\s+/g, ''), 'hex')

  it('should detect Shift_JIS over Cyrillic for a 38-byte CSV', () => {
    // "質問,割合(%)/はい,26.1/いいえ,73.9" — came back windows-1251
    const buf = bytes(`8e bf 96 e2 2c 8a 84 8d 87 28 25 29 0d 0a 82 cd
                       82 a2 2c 32 36 2e 31 0d 0a 82 a2 82 a2 82 a6 2c
                       37 33 2e 39 0d 0a`)
    expect(detectEncoding('csv', buf)).toBe('Shift_JIS')
  })

  it('should detect Shift_JIS for kanji-only content with no hiragana', () => {
    // "016,微小粒子状物質,PM2.5,μg/m3" — came back KOI8-R. chardet scores
    // Shift_JIS off a frequency table that is almost entirely hiragana, so a
    // line of kanji scores the same as no Japanese at all.
    const buf = bytes(`30 31 36 2c 94 f7 8f ac 97 b1 8e 71 8f f3 95 a8
                       8e bf 2c 50 4d 32 2e 35 2c 83 ca 67 2f 6d 33 0d
                       0a`)
    expect(detectEncoding('csv', buf)).toBe('Shift_JIS')
  })

  it('should leave genuinely non-Japanese single-byte content alone', () => {
    const cases: [string, string][] = [
      // Russian, windows-1251
      [
        `e3 ee f0 ee e4 2c ed e0 f1 e5 eb e5 ed e8 e5 0a
         cc ee f1 ea e2 e0 2c 31 33 30 31 30 31 31 32 0a
         d1 e0 ed ea f2 2d cf e5 f2 e5 f0 e1 f3 f0 e3 2c
         35 36 30 31 39 31 31 0a`,
        'windows-1251',
      ],
      // Russian, KOI8-R — 0xA1-0xDF is half-width katakana in Shift_JIS
      [
        `c7 cf d2 cf c4 2c ce c1 d3 c5 cc c5 ce c9 c5 0a
         ed cf d3 cb d7 c1 2c 31 33 30 31 30 31 31 32 0a`,
        'KOI8-R',
      ],
      // French — "Montréal", "Québec": e-acute + a letter is a legal Shift_JIS pair
      [
        `76 69 6c 6c 65 2c 70 6f 70 75 6c 61 74 69 6f 6e
         0a 4d 6f 6e 74 72 e9 61 6c 2c 31 37 36 32 39 34
         39 0a 51 75 e9 62 65 63 2c 35 34 39 34 35 39 0a
         47 65 6e e8 76 65 2c 32 30 33 38 35 36 0a`,
        'ISO-8859-1',
      ],
      // Icelandic — "íbúar" is two consecutive legal Shift_JIS pairs, so it
      // decodes to the kanji pair 兊俉 and only the run length rejects it
      [
        `62 6f 72 67 2c ed 62 fa 61 72 0a 52 65 79 6b 6a
         61 76 ed 6b 2c 31 33 39 38 37 35 0a 41 6b 75 72
         65 79 72 69 2c 31 39 37 37 31 0a`,
        'ISO-8859-1',
      ],
    ]
    for (const [hex, expected] of cases) {
      expect(detectEncoding('csv', bytes(hex))).toBe(expected)
    }
  })

  it('should not rewrite other CJK encodings as Japanese', () => {
    // Kanji is kanji; only chardet can tell which language's. Its multi-byte
    // verdicts are validators, so they are left as they are.
    const big5 = bytes(`bf a4 a5 ab 2c a4 48 a4 66 0a bb 4f a5 5f a5 ab
                        2c 32 34 38 31 30 30 30 0a b7 73 a5 5f a5 ab 2c
                        34 30 30 34 30 30 30 0a`)
    const eucKr = bytes(`b5 b5 bd c3 2c c0 ce b1 b8 0a bc ad bf ef c6 af
                         ba b0 bd c3 2c 39 34 31 31 30 30 30 0a ba ce bb
                         ea b1 a4 bf aa bd c3 2c 33 33 34 34 30 30 30 0a`)
    expect(detectEncoding('csv', big5)).not.toBe('Shift_JIS')
    expect(detectEncoding('csv', eucKr)).toBe('EUC-KR')
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

describe('stripTrailingReplacementChar', () => {
  it('removes a trailing U+FFFD left by byte-boundary truncation', () => {
    // "日本" (6 bytes UTF-8) cut at 5 bytes -> "日" + U+FFFD
    const cut = Buffer.from('日本').subarray(0, 5).toString('utf-8')
    expect(cut.endsWith('\uFFFD')).toBe(true)
    expect(stripTrailingReplacementChar(cut)).toBe('日')
  })

  it('keeps text without a trailing replacement char unchanged', () => {
    expect(stripTrailingReplacementChar('日本')).toBe('日本')
    expect(stripTrailingReplacementChar('')).toBe('')
  })

  it('removes only the trailing occurrence', () => {
    expect(stripTrailingReplacementChar('a\uFFFDb\uFFFD')).toBe('a\uFFFDb')
  })
})
