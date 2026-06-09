import { describe, it, expect } from 'vitest'
import { Readable } from 'stream'
import { JsonMinifyStream } from '../../streams/json-minify-stream'

async function minify(input: string, chunkSize?: number): Promise<string> {
  const buffers: Buffer[] = []
  const inputBuf = Buffer.from(input, 'utf-8')
  if (chunkSize) {
    // Feed input in fixed-size chunks to test cross-chunk state
    const parts: Buffer[] = []
    for (let i = 0; i < inputBuf.length; i += chunkSize) {
      parts.push(inputBuf.subarray(i, i + chunkSize))
    }
    const stream = Readable.from(parts).pipe(new JsonMinifyStream())
    for await (const chunk of stream) buffers.push(chunk as Buffer)
  } else {
    const stream = Readable.from([inputBuf]).pipe(new JsonMinifyStream())
    for await (const chunk of stream) buffers.push(chunk as Buffer)
  }
  return Buffer.concat(buffers).toString('utf-8')
}

describe('JsonMinifyStream', () => {
  it('should strip whitespace from simple object', async () => {
    const input = '{ "a" : 1 , "b" : 2 }'
    expect(await minify(input)).toBe('{"a":1,"b":2}')
  })

  it('should strip newlines and indentation', async () => {
    const input = `{
  "name": "test",
  "value": 42
}`
    expect(await minify(input)).toBe('{"name":"test","value":42}')
  })

  it('should preserve whitespace inside strings', async () => {
    const input = '{ "message" : "hello  world\\tnow" }'
    expect(await minify(input)).toBe('{"message":"hello  world\\tnow"}')
  })

  it('should handle escaped quotes in strings', async () => {
    const input = '{ "key" : "value \\"with\\" quotes" }'
    expect(await minify(input)).toBe('{"key":"value \\"with\\" quotes"}')
  })

  it('should handle escaped backslash before quote', async () => {
    const input = '{ "key" : "value\\\\" }'
    expect(await minify(input)).toBe('{"key":"value\\\\"}')
  })

  it('should handle nested structures', async () => {
    const input = `{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": {
        "type": "Point",
        "coordinates": [ 139.6917, 35.6895 ]
      }
    }
  ]
}`
    const expected =
      '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[139.6917,35.6895]}}]}'
    expect(await minify(input)).toBe(expected)
  })

  it('should handle already-minified input', async () => {
    const input = '{"a":1,"b":[2,3]}'
    expect(await minify(input)).toBe(input)
  })

  it('should handle empty object and array', async () => {
    expect(await minify('{  }')).toBe('{}')
    expect(await minify('[  ]')).toBe('[]')
  })

  it('should work correctly across chunk boundaries', async () => {
    const input = '{ "key" : "hello  world" , "n" : 1 }'
    expect(await minify(input, 3)).toBe('{"key":"hello  world","n":1}')
  })

  it('should handle chunk boundary inside escape sequence', async () => {
    const input = '{"k":"a\\"b"}'
    expect(await minify(input, 5)).toBe('{"k":"a\\"b"}')
  })

  it('should preserve multi-byte UTF-8 characters', async () => {
    const input = '{ "名前" : "東京タワー" }'
    expect(await minify(input)).toBe('{"名前":"東京タワー"}')
  })
})
