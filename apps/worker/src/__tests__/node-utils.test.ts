import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

vi.mock('encoding-japanese', () => ({
  default: {
    detect: vi.fn(),
    convert: vi.fn(),
    codeToString: vi.fn(),
  },
}))

import Encoding from 'encoding-japanese'
import {
  detectEncoding,
  bufferToUtf8,
  streamToBuffer,
  streamToTempFile,
  cleanupTempFile,
  streamUtf8Lines,
} from '../pipeline/node-utils'

const mockEncoding = vi.mocked(Encoding)

describe('detectEncoding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should return UTF8 for json format', () => {
    const buf = Buffer.from('{"key":"value"}')
    expect(detectEncoding('json', buf)).toBe('UTF8')
    expect(mockEncoding.detect).not.toHaveBeenCalled()
  })

  it('should return UTF8 for md format', () => {
    const buf = Buffer.from('# Hello')
    expect(detectEncoding('md', buf)).toBe('UTF8')
  })

  it('should return UTF8 for geojson format', () => {
    const buf = Buffer.from('{"type":"FeatureCollection"}')
    expect(detectEncoding('geojson', buf)).toBe('UTF8')
  })

  it('should call Encoding.detect for csv format', () => {
    mockEncoding.detect.mockReturnValue('SJIS')
    const buf = Buffer.from('name,age')
    expect(detectEncoding('csv', buf)).toBe('SJIS')
    expect(mockEncoding.detect).toHaveBeenCalledWith(buf)
  })

  it('should call Encoding.detect for txt format', () => {
    mockEncoding.detect.mockReturnValue('EUCJP')
    const buf = Buffer.from('hello')
    expect(detectEncoding('txt', buf)).toBe('EUCJP')
    expect(mockEncoding.detect).toHaveBeenCalledWith(buf)
  })

  it('should call Encoding.detect for html format', () => {
    mockEncoding.detect.mockReturnValue('UTF8')
    const buf = Buffer.from('<html></html>')
    expect(detectEncoding('html', buf)).toBe('UTF8')
    expect(mockEncoding.detect).toHaveBeenCalledWith(buf)
  })

  it('should fall back to UTF8 when Encoding.detect returns false', () => {
    mockEncoding.detect.mockReturnValue(false)
    const buf = Buffer.from('binary')
    expect(detectEncoding('csv', buf)).toBe('UTF8')
  })

  it('should parse XML encoding declaration', () => {
    const buf = Buffer.from('<?xml version="1.0" encoding="Shift_JIS"?><root/>')
    expect(detectEncoding('xml', buf)).toBe('SJIS')
  })

  it('should default to UTF8 when no XML encoding declaration', () => {
    const buf = Buffer.from('<root><item>hello</item></root>')
    expect(detectEncoding('xml', buf)).toBe('UTF8')
  })
})

describe('bufferToUtf8', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should return UTF-8 string for UTF8 encoding', () => {
    const buf = Buffer.from('hello world')
    expect(bufferToUtf8(buf, 'UTF8')).toBe('hello world')
    expect(mockEncoding.convert).not.toHaveBeenCalled()
  })

  it('should return UTF-8 string for ASCII encoding', () => {
    const buf = Buffer.from('ascii text')
    expect(bufferToUtf8(buf, 'ASCII')).toBe('ascii text')
    expect(mockEncoding.convert).not.toHaveBeenCalled()
  })

  it('should convert non-UTF8 encoding via Encoding.convert', () => {
    const buf = Buffer.from([0x82, 0xb1, 0x82, 0xf1])
    const convertedArray = [12371, 12435]
    mockEncoding.convert.mockReturnValue(convertedArray)
    mockEncoding.codeToString.mockReturnValue('converted-text')

    const result = bufferToUtf8(buf, 'SJIS')

    expect(mockEncoding.convert).toHaveBeenCalledWith(buf, { to: 'UNICODE', from: 'SJIS' })
    expect(mockEncoding.codeToString).toHaveBeenCalledWith(convertedArray)
    expect(result).toBe('converted-text')
  })
})

describe('streamToBuffer', () => {
  it('should collect stream chunks into a single Buffer', async () => {
    const stream = Readable.from([Buffer.from('hello '), Buffer.from('world')])
    const result = await streamToBuffer(stream)
    expect(result.toString()).toBe('hello world')
  })

  it('should cap at maxBytes', async () => {
    const stream = Readable.from([Buffer.from('hello '), Buffer.from('world')])
    const result = await streamToBuffer(stream, 5)
    // First chunk (6 bytes "hello ") exceeds 5-byte limit, stream destroyed after it
    expect(result.length).toBeLessThanOrEqual(6)
  })

  it('should handle empty stream', async () => {
    const stream = Readable.from([])
    const result = await streamToBuffer(stream)
    expect(result.length).toBe(0)
  })
})

describe('streamToTempFile + cleanupTempFile', () => {
  it('should write stream to a temp file and clean up', async () => {
    const content = 'temp file content'
    const stream = Readable.from([Buffer.from(content)])

    const filePath = await streamToTempFile(stream)
    expect(existsSync(filePath)).toBe(true)

    const written = await readFile(filePath, 'utf-8')
    expect(written).toBe(content)

    await cleanupTempFile(filePath)
    expect(existsSync(filePath)).toBe(false)
  })
})

describe('streamUtf8Lines', () => {
  it('should yield lines from a simple stream', async () => {
    const stream = Readable.from(Buffer.from('line1\nline2\nline3'))
    const lines: string[] = []
    for await (const line of streamUtf8Lines(stream)) {
      lines.push(line)
    }
    expect(lines).toEqual(['line1', 'line2', 'line3'])
  })

  it('should handle stream with no newlines', async () => {
    const stream = Readable.from(Buffer.from('single line'))
    const lines: string[] = []
    for await (const line of streamUtf8Lines(stream)) {
      lines.push(line)
    }
    expect(lines).toEqual(['single line'])
  })

  it('should handle empty stream', async () => {
    const stream = Readable.from(Buffer.from(''))
    const lines: string[] = []
    for await (const line of streamUtf8Lines(stream)) {
      lines.push(line)
    }
    expect(lines).toEqual([])
  })

  it('should handle trailing newline without extra empty line', async () => {
    const stream = Readable.from(Buffer.from('a\nb\n'))
    const lines: string[] = []
    for await (const line of streamUtf8Lines(stream)) {
      lines.push(line)
    }
    expect(lines).toEqual(['a', 'b'])
  })

  it('should handle multi-byte characters split across chunks', async () => {
    // '東' = E6 9D B1 in UTF-8. Split it across two chunks.
    const chunk1 = Buffer.from([0x41, 0x0a, 0xe6, 0x9d]) // 'A\n' + first 2 bytes of '東'
    const chunk2 = Buffer.from([0xb1, 0x0a, 0x42])        // last byte of '東' + '\nB'

    const stream = new Readable({
      read() {
        this.push(chunk1)
        this.push(chunk2)
        this.push(null)
      },
    })

    const lines: string[] = []
    for await (const line of streamUtf8Lines(stream)) {
      lines.push(line)
    }
    expect(lines).toEqual(['A', '東', 'B'])
  })

  it('should handle large number of lines across multiple chunks', async () => {
    const text = Array.from({ length: 1000 }, (_, i) => `line${i}`).join('\n')
    const stream = Readable.from(Buffer.from(text))
    const lines: string[] = []
    for await (const line of streamUtf8Lines(stream)) {
      lines.push(line)
    }
    expect(lines).toHaveLength(1000)
    expect(lines[0]).toBe('line0')
    expect(lines[999]).toBe('line999')
  })
})
