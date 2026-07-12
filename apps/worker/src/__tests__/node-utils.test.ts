/// <reference types="node" />
import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import {
  streamToBuffer,
  streamToTempFile,
  cleanupTempFile,
  streamUtf8Lines,
} from '../pipeline/node-utils'

// detectEncoding / bufferToUtf8 tests live in packages/shared (encoding-node.test.ts)

describe('streamToBuffer', () => {
  it('should collect stream chunks into a single Buffer', async () => {
    const stream = Readable.from([Buffer.from('hello '), Buffer.from('world')])
    const result = await streamToBuffer(stream)
    expect(result.toString()).toBe('hello world')
  })

  it('should cap at maxBytes and include the cap-crossing chunk so truncation is detectable', async () => {
    const stream = Readable.from([Buffer.from('hello '), Buffer.from('world')])
    const result = await streamToBuffer(stream, 5)
    // First chunk (6 bytes "hello ") crosses the 5-byte cap; it is included and
    // the stream is then destroyed, so length >= maxBytes signals truncation.
    expect(result.length).toBeGreaterThanOrEqual(5)
    expect(result.toString()).toBe('hello ')
  })

  it('should return the whole stream when under maxBytes (no truncation)', async () => {
    const stream = Readable.from([Buffer.from('ab'), Buffer.from('cd')])
    const result = await streamToBuffer(stream, 100)
    expect(result.toString()).toBe('abcd')
    expect(result.length).toBeLessThan(100)
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
