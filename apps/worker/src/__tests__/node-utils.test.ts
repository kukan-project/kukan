/// <reference types="node" />
import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import {
  detectEncoding,
  bufferToUtf8,
  streamToBuffer,
  streamToTempFile,
  cleanupTempFile,
  streamUtf8Lines,
} from '../pipeline/node-utils'

describe('detectEncoding', () => {
  it('should return UTF-8 for json format without calling chardet', () => {
    const buf = Buffer.from('{"key":"value"}')
    expect(detectEncoding('json', buf)).toBe('UTF-8')
  })

  it('should return UTF-8 for md format', () => {
    const buf = Buffer.from('# Hello')
    expect(detectEncoding('md', buf)).toBe('UTF-8')
  })

  it('should return UTF-8 for geojson format', () => {
    const buf = Buffer.from('{"type":"FeatureCollection"}')
    expect(detectEncoding('geojson', buf)).toBe('UTF-8')
  })

  it('should parse XML encoding declaration', () => {
    const buf = Buffer.from('<?xml version="1.0" encoding="Shift_JIS"?><root/>')
    expect(detectEncoding('xml', buf)).toBe('Shift_JIS')
  })

  it('should default to UTF-8 when no XML encoding declaration', () => {
    const buf = Buffer.from('<root><item>hello</item></root>')
    expect(detectEncoding('xml', buf)).toBe('UTF-8')
  })
})

describe('bufferToUtf8', () => {
  it('should return UTF-8 string for UTF-8 encoding', () => {
    const buf = Buffer.from('hello world')
    expect(bufferToUtf8(buf, 'UTF-8')).toBe('hello world')
  })

  it('should return UTF-8 string for ASCII encoding', () => {
    const buf = Buffer.from('ascii text')
    expect(bufferToUtf8(buf, 'ASCII')).toBe('ascii text')
  })

  it('should convert Shift_JIS via TextDecoder', () => {
    // "こん" in Shift_JIS = 0x82B1 0x82F1
    const buf = Buffer.from([0x82, 0xb1, 0x82, 0xf1])
    expect(bufferToUtf8(buf, 'Shift_JIS')).toBe('こん')
  })

  it('should handle legacy SJIS name', () => {
    const buf = Buffer.from([0x82, 0xb1, 0x82, 0xf1])
    expect(bufferToUtf8(buf, 'SJIS')).toBe('こん')
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
  it('should sanitize extension to prevent path traversal', async () => {
    const stream = Readable.from([Buffer.from('x')])
    const filePath = await streamToTempFile(stream, '../../../etc/passwd')
    expect(filePath).toMatch(/data\.etcpasswd$/)
    await cleanupTempFile(filePath)
  })

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
    const chunk2 = Buffer.from([0xb1, 0x0a, 0x42]) // last byte of '東' + '\nB'

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
