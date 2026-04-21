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
import { detectEncoding, bufferToUtf8, streamToBuffer, streamToTempFile, cleanupTempFile } from '../pipeline/node-utils'

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
