/**
 * Whether an Office package (a ZIP) is one ibisOffice may be given (ADR-065
 * decision 3). Only a plainly built archive passes: one whose directory and
 * local headers agree, with nothing before, between or after them, so that no
 * two readers can see different contents in it. Its size is what the entries
 * actually unpack to, as the sizes it declares can say anything.
 */

const EOCD = 0x06054b50
const CENTRAL_HEADER = 0x02014b50
const LOCAL_HEADER = 0x04034b50

const EOCD_SIZE = 22
const CENTRAL_HEADER_SIZE = 46
const LOCAL_HEADER_SIZE = 30

/** Encrypted, or strongly so */
const ENCRYPTED = 0x0041
const DATA_DESCRIPTOR = 0x0008
const DESCRIPTOR = 0x08074b50
const ZIP64_SIZE = 0xffffffff

const METHOD_STORED = 0
const METHOD_DEFLATED = 8

const MAX_ENTRIES = 10_000

export type PackageVerdict = 'ok' | 'too-large' | 'refused'

export interface PackageCheckRequest {
  bytes: ArrayBuffer
  limit: number
}

interface PlacedEntry {
  method: number
  data: Uint8Array
}

/**
 * The entries with their data, or null for an archive not plainly built. A read
 * past the file throws, which the caller takes for the same; an offset that only
 * grows cannot land on the directory after running past it.
 */
function plainEntries(bytes: Uint8Array): PlacedEntry[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u16 = (at: number) => view.getUint16(at, true)
  const u32 = (at: number) => view.getUint32(at, true)
  // The bytes as they are: decoded, different bytes could read as one name
  const name = (at: number, length: number) =>
    String.fromCharCode(...bytes.subarray(at, at + length))

  const eocd = bytes.length - EOCD_SIZE
  // At the very end, so with nothing after it, and saying it has no comment
  if (u32(eocd) !== EOCD || u16(eocd + 20) !== 0) return null
  const count = u16(eocd + 10)
  const directory = u32(eocd + 16)
  if (
    u16(eocd + 4) !== 0 ||
    u16(eocd + 6) !== 0 ||
    u16(eocd + 8) !== count ||
    count > MAX_ENTRIES ||
    directory + u32(eocd + 12) !== eocd
  ) {
    return null
  }

  const entries: {
    name: string
    method: number
    flags: number
    crc: number
    compressedSize: number
    size: number
    localOffset: number
  }[] = []
  let at = directory
  for (let i = 0; i < count; i++) {
    if (u32(at) !== CENTRAL_HEADER) return null
    const flags = u16(at + 8)
    const method = u16(at + 10)
    if (flags & ENCRYPTED || (method !== METHOD_STORED && method !== METHOD_DEFLATED)) {
      return null
    }
    const nameLength = u16(at + 28)
    entries.push({
      name: name(at + CENTRAL_HEADER_SIZE, nameLength),
      method,
      flags,
      crc: u32(at + 16),
      compressedSize: u32(at + 20),
      size: u32(at + 24),
      localOffset: u32(at + 42),
    })
    at += CENTRAL_HEADER_SIZE + nameLength + u16(at + 30) + u16(at + 32)
  }
  // One name, to a reader that folds case or takes a backslash for a slash
  const folded = new Set(entries.map(({ name }) => name.replaceAll('\\', '/').toLowerCase()))
  if (at !== eocd || folded.size !== count) return null

  // Its signature is optional and its sizes 4 or 8 bytes: its length says which
  const descriptorAgrees = (
    at: number,
    length: number,
    { crc, compressedSize, size }: { crc: number; compressedSize: number; size: number }
  ) => {
    if (![12, 16, 20, 24].includes(length)) return false
    const signed = length % 8 === 0
    if (signed && u32(at) !== DESCRIPTOR) return false
    const fields = at + (signed ? 4 : 0)
    const wide = length >= 20
    return (
      u32(fields) === crc &&
      u32(fields + 4) === compressedSize &&
      u32(fields + (wide ? 12 : 8)) === size &&
      (!wide || (u32(fields + 8) === 0 && u32(fields + 16) === 0))
    )
  }

  // The local headers, in file order, leaving no gap up to the directory
  entries.sort((a, b) => a.localOffset - b.localOffset)
  const placed: PlacedEntry[] = []
  let next = 0
  for (const [i, entry] of entries.entries()) {
    const descriptor = entry.flags & DATA_DESCRIPTOR
    const nameLength = u16(next + 26)
    const localSize = u32(next + 18)
    if (
      entry.localOffset !== next ||
      u32(next) !== LOCAL_HEADER ||
      u16(next + 6) & ENCRYPTED ||
      (u16(next + 6) & DATA_DESCRIPTOR) !== descriptor ||
      u16(next + 8) !== entry.method ||
      // Under a descriptor the size comes after the data: left empty, or marked as zip64
      (localSize !== entry.compressedSize &&
        !(descriptor && (localSize === 0 || localSize === ZIP64_SIZE))) ||
      (!descriptor && (u32(next + 14) !== entry.crc || u32(next + 22) !== entry.size)) ||
      name(next + LOCAL_HEADER_SIZE, nameLength) !== entry.name
    ) {
      return null
    }
    const start = next + LOCAL_HEADER_SIZE + nameLength + u16(next + 28)
    next = start + entry.compressedSize
    placed.push({ method: entry.method, data: bytes.subarray(start, next) })
    if (descriptor) {
      const following = entries[i + 1]?.localOffset ?? directory
      if (!descriptorAgrees(next, following - next, entry)) return null
      next = following
    }
  }
  return next === directory ? placed : null
}

/** What the archive's entries unpack to, stopping as soon as that passes `limit`. */
async function unpacksWithin(placed: PlacedEntry[], limit: number): Promise<boolean> {
  let total = 0
  for (const { method, data } of placed) {
    if (method === METHOD_STORED) {
      total += data.length
      if (total > limit) return false
      continue
    }
    // Empty input is an error to DecompressionStream
    if (data.length === 0) continue
    const unpacked = new Blob([data as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream('deflate-raw'))
    const reader = unpacked.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > limit) {
        await reader.cancel()
        return false
      }
    }
  }
  return true
}

/** The verdict on a package whose unpacked contents may come to `limit` bytes. */
export async function checkPackage(bytes: Uint8Array, limit: number): Promise<PackageVerdict> {
  try {
    const placed = plainEntries(bytes)
    if (!placed) return 'refused'
    return (await unpacksWithin(placed, limit)) ? 'ok' : 'too-large'
  } catch {
    // Out of bounds, or data that does not inflate
    return 'refused'
  }
}
