import { describe, it, expect } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import { checkPackage } from '../office-package-check'

const LIMIT = 1024 * 1024

interface Part {
  name: string
  data?: Buffer
  stored?: boolean
  flags?: number
  descriptor?: 'signed' | 'unsigned' | 'signed zip64' | 'unsigned zip64'
  localFlags?: number
  localCrc?: number
  localUnpacked?: number
  descriptorSignature?: number
  descriptorCrc?: number
  descriptorLie?: number
  latin1?: boolean
  localSize?: number
  localName?: string
  localMethod?: number
  method?: number
}

function u16(n: number) {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}
function u32(n: number) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}

/** A ZIP as a plain writer builds it, or with a part of it made otherwise. */
function zip(
  parts: Part[],
  {
    prefix = Buffer.alloc(0),
    comment = '',
    gapAfterFirst = 0,
    count,
  }: {
    prefix?: Buffer
    comment?: string
    gapAfterFirst?: number
    count?: number
  } = {}
): Uint8Array {
  const body: Buffer[] = [prefix]
  const directory: Buffer[] = []
  let at = prefix.length
  parts.forEach((part, i) => {
    const raw = part.data ?? Buffer.from('content')
    const data = part.stored ? raw : deflateRawSync(raw)
    const method = part.method ?? (part.stored ? 0 : 8)
    const flags = (part.flags ?? 0) | (part.descriptor ? 8 : 0)
    const encoding = part.latin1 ? 'latin1' : 'utf8'
    const localName = Buffer.from(part.localName ?? part.name, encoding)
    const name = Buffer.from(part.name, encoding)
    const sizes = [u32(0), u32(data.length), u32(raw.length)]
    const zip64 = part.descriptor?.endsWith('zip64')
    const descriptorCrc = part.descriptorCrc ?? 0
    const lie = part.descriptorLie ?? 0
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(part.localFlags ?? flags),
      u16(part.localMethod ?? method),
      u32(0),
      u32(part.localCrc ?? 0),
      u32(part.localSize ?? data.length),
      u32(part.localUnpacked ?? raw.length),
      u16(localName.length),
      u16(0),
      localName,
      data,
      ...(part.descriptor?.startsWith('signed')
        ? [u32(part.descriptorSignature ?? 0x08074b50)]
        : []),
      ...(part.descriptor
        ? zip64
          ? [u32(descriptorCrc), u32(data.length + lie), u32(0), u32(raw.length), u32(0)]
          : [u32(descriptorCrc), u32(data.length + lie), u32(raw.length)]
        : []),
      Buffer.alloc(i === 0 ? gapAfterFirst : 0),
    ])
    directory.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(flags),
        u16(method),
        u32(0),
        ...sizes,
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(at),
        name,
      ])
    )
    body.push(local)
    at += local.length
  })
  const dir = Buffer.concat(directory)
  const n = count ?? parts.length
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(n),
    u16(n),
    u32(dir.length),
    u32(at),
    u16(comment.length),
    Buffer.from(comment),
  ])
  return new Uint8Array(Buffer.concat([...body, dir, eocd]))
}

const check = (bytes: Uint8Array) => checkPackage(bytes, LIMIT)

/** The end record claiming a comment the file does not have. */
function noted(bytes: Uint8Array): Uint8Array {
  bytes[bytes.length - 2] = 5
  return bytes
}

describe('checkPackage (ADR-065 decision 3)', () => {
  it('passes a plainly built package', async () => {
    const parts = [{ name: '[Content_Types].xml' }, { name: 'xl/workbook.xml' }]
    expect(await check(zip(parts))).toBe('ok')
  })

  it('passes stored entries and empty ones, as a folder entry is', async () => {
    const parts = [
      { name: 'a.xml', stored: true },
      { name: 'folder/', stored: true, data: Buffer.alloc(0) },
    ]
    expect(await check(zip(parts))).toBe('ok')
  })

  it.each(['signed', 'unsigned', 'signed zip64', 'unsigned zip64'] as const)(
    'passes data descriptors, %s',
    async (descriptor) => {
      const parts = [
        { name: 'a.xml', descriptor },
        { name: 'b.xml', descriptor },
      ]
      expect(await check(zip(parts))).toBe('ok')
    }
  )

  it('passes a local size left empty under a descriptor', async () => {
    expect(await check(zip([{ name: 'a', descriptor: 'signed', localSize: 0 }]))).toBe('ok')
  })

  it('passes a deflated entry with no data', async () => {
    const part = { name: 'a', method: 8, stored: true, data: Buffer.alloc(0) }
    expect(await check(zip([part]))).toBe('ok')
  })

  it('tells names apart by their bytes, not what they decode to', async () => {
    // Both decode to U+FFFD
    const parts = [
      { name: '\xff', latin1: true },
      { name: '\xfe', latin1: true },
    ]
    expect(await check(zip(parts))).toBe('ok')
  })

  it('counts what entries unpack to, whatever they declare', async () => {
    const bomb = { name: 'sheet.xml', data: Buffer.alloc(LIMIT + 1) }
    const bytes = zip([bomb])
    expect(bytes.length).toBeLessThan(LIMIT / 100)
    expect(await check(bytes)).toBe('too-large')
  })

  it('adds up the entries', async () => {
    const half = Buffer.alloc(LIMIT / 2 + 1)
    const parts = [
      { name: 'a.xml', data: half },
      { name: 'b.xml', data: half },
    ]
    expect(await check(zip(parts))).toBe('too-large')
  })

  it('counts stored entries too', async () => {
    const parts = [{ name: 'a.bin', stored: true, data: Buffer.alloc(LIMIT + 1) }]
    expect(await check(zip(parts))).toBe('too-large')
  })

  it.each<[string, Uint8Array]>([
    ['bytes before the archive', zip([{ name: 'a' }], { prefix: Buffer.from('MZ') })],
    ['a gap between entries', zip([{ name: 'a' }, { name: 'b' }], { gapAfterFirst: 4 })],
    ['a comment', zip([{ name: 'a' }], { comment: 'hello' })],
    ['bytes after the archive', new Uint8Array([...zip([{ name: 'a' }]), 0, 0, 0, 0])],
    ['an encrypted entry', zip([{ name: 'a', flags: 1 }])],
    ['an entry encrypted in its local header alone', zip([{ name: 'a', localFlags: 1 }])],
    ['a local size other than the directory’s', zip([{ name: 'a', localSize: 1 }])],
    ['a local CRC other than the directory’s', zip([{ name: 'a', localCrc: 1 }])],
    ['a local unpacked size other than the directory’s', zip([{ name: 'a', localUnpacked: 1 }])],
    [
      'bytes between an entry and its descriptor',
      zip([{ name: 'a', descriptor: 'signed' }, { name: 'b' }], { gapAfterFirst: 3 }),
    ],
    ['a comment length with no comment', noted(zip([{ name: 'a' }]))],
    [
      'a descriptor the local header does not announce',
      zip([{ name: 'a', descriptor: 'signed', localFlags: 0 }]),
    ],
    [
      'a size under a descriptor other than the directory’s',
      zip([{ name: 'a', descriptor: 'signed', localSize: 1 }]),
    ],
    [
      'a descriptor with the wrong signature',
      zip([{ name: 'a', descriptor: 'signed', descriptorSignature: 0x12345678 }]),
    ],
    ['a descriptor with another CRC', zip([{ name: 'a', descriptor: 'signed', descriptorCrc: 1 }])],
    [
      'a descriptor with another size',
      zip([{ name: 'a', descriptor: 'unsigned', descriptorLie: 1 }]),
    ],
    [
      'a zip64 descriptor with another size',
      zip([{ name: 'a', descriptor: 'signed zip64', descriptorLie: 1 }]),
    ],
    ['names differing only in case', zip([{ name: 'xl/A.xml' }, { name: 'xl/a.xml' }])],
    ['names differing only in the slash', zip([{ name: 'xl/a.xml' }, { name: 'xl\\a.xml' }])],
    ['strong encryption', zip([{ name: 'a', flags: 0x40 }])],
    ['the same name twice', zip([{ name: 'a' }, { name: 'a' }])],
    ['a local name other than the directory’s', zip([{ name: 'a', localName: 'b' }])],
    ['a local method other than the directory’s', zip([{ name: 'a', localMethod: 0 }])],
    ['a method it cannot read', zip([{ name: 'a', method: 9 }])],
    [
      'a count that disagrees with the directory',
      zip([{ name: 'a' }, { name: 'b' }], { count: 1 }),
    ],
    ['a truncated archive', zip([{ name: 'a' }]).subarray(0, 40)],
    ['nothing at all', new Uint8Array(0)],
  ])('refuses %s', async (_, bytes) => {
    expect(await check(bytes)).toBe('refused')
  })

  it('refuses data that does not inflate', async () => {
    const bytes = zip([{ name: 'a', data: Buffer.from('12345678') }])
    // The entry's data begins after the 30-byte header and its 1-byte name
    bytes.fill(0xff, 31, 35)
    expect(await check(bytes)).toBe('refused')
  })

  it('refuses more entries than a document has', async () => {
    const parts = Array.from({ length: 10_001 }, (_, i) => ({
      name: `f${i}`,
      stored: true,
      data: Buffer.alloc(0),
    }))
    expect(await check(zip(parts))).toBe('refused')
  })
})
