/**
 * The streams of a compound file (MS-CFB), the container the legacy Office
 * formats — XLS, DOC, PPT — and Ichitaro keep their parts in. A stream is
 * reached by its path, its storages' names before its own: each of those
 * formats keeps its text at the top of the file, but an Ichitaro document
 * keeps a sheet after its first in a storage of its own.
 *
 * The file is read whole: what a format needs of a stream is scattered across
 * it, and the formats that reach here are bounded by the fetch limit. A
 * stream is a slice of it where its sectors run on, as a writer lays out a
 * file it saves at once, and a copy only where they do not.
 */

import { COMPOUND_FILE_SIGNATURE } from '@kukan/shared'

/** The sector numbers that end a chain or mark one free, the FAT's and the DIFAT's. */
const MAX_REGULAR_SECTOR = 0xfffffffa
const END_OF_CHAIN = 0xfffffffe

const HEADER_BYTES = 512
const MINI_SECTOR_BYTES = 64
const DIRECTORY_ENTRY_BYTES = 128
/** The DIFAT entries the header holds; more are in a chain of their own. */
const HEADER_DIFAT_ENTRIES = 109
const NO_STREAM = 0xffffffff

/**
 * Storages within storages a path may pass through. An Ichitaro document's
 * deepest is 6; past this a path's names, each repeating its parent's, would
 * grow with the square of the nesting.
 */
const MAX_DEPTH = 32

const STORAGE = 1
const STREAM = 2
const ROOT = 5

export interface CompoundFile {
  /**
   * A stream by its path (`DocumentText`, `ObjectSheets/DocSheet/DOCS_0001/DocumentText`),
   * ignoring case; undefined where there is none.
   */
  stream(path: string): Buffer | undefined
  /** The paths of the file's streams, as `stream` takes them. */
  paths(): string[]
}

/** Read the compound file `bytes` is, or throw where it is not one or is broken. */
export function readCompoundFile(bytes: Buffer): CompoundFile {
  if (
    bytes.length < HEADER_BYTES ||
    bytes.toString('latin1', 0, COMPOUND_FILE_SIGNATURE.length) !== COMPOUND_FILE_SIGNATURE
  ) {
    throw new Error('Not a compound file')
  }
  const sectorShift = bytes.readUInt16LE(0x1e)
  if ((sectorShift !== 9 && sectorShift !== 12) || bytes.readUInt16LE(0x20) !== 6) {
    throw new Error(`Compound file has sectors of 2^${sectorShift} bytes`)
  }
  const sectorSize = 1 << sectorShift
  // The header takes the first sector's place, padded to a sector's size. The
  // last may be cut short, its padding left off, as readers of the format allow
  const sectorCount = Math.max(0, Math.ceil((bytes.length - sectorSize) / sectorSize))
  /** A sector of the FAT or DIFAT, padded with zeros where the file ends inside it. */
  const sector = (n: number) => {
    if (n >= sectorCount) throw new Error(`Compound file sector ${n} is past its end`)
    const start = (n + 1) * sectorSize
    const s = bytes.subarray(start, start + sectorSize)
    return s.length === sectorSize ? s : Buffer.concat([s, Buffer.alloc(sectorSize - s.length)])
  }
  const entriesPerSector = sectorSize / 4

  /**
   * The sectors of a chain from `first`, each at most once: a loop is a broken
   * file. A stream's chain is walked only as far as its size needs (`wanted`):
   * one running on past it would otherwise be walked whole for a few bytes.
   */
  const chain = (
    first: number,
    next: (n: number) => number,
    limit: number,
    wanted = Infinity
  ): number[] => {
    const sectors: number[] = []
    for (let n = first; n !== END_OF_CHAIN && sectors.length < wanted; n = next(n)) {
      if (n > MAX_REGULAR_SECTOR || sectors.length >= limit) {
        throw new Error('Compound file has a broken sector chain')
      }
      sectors.push(n)
    }
    return sectors
  }

  // The FAT's own sectors: the header's 109, then the DIFAT chain's. As many
  // as the header counts and no more: a DIFAT naming one sector over and over
  // would otherwise build a FAT far larger than the file
  const fatCount = bytes.readUInt32LE(0x2c)
  if (fatCount > sectorCount) {
    throw new Error(`Compound file has ${fatCount} FAT sectors, more than its ${sectorCount}`)
  }
  const fatSectors: number[] = []
  const addFat = (n: number) => {
    if (n <= MAX_REGULAR_SECTOR && fatSectors.length < fatCount) fatSectors.push(n)
  }
  for (let i = 0; i < HEADER_DIFAT_ENTRIES; i++) addFat(bytes.readUInt32LE(0x4c + i * 4))
  let difat = bytes.readUInt32LE(0x44)
  for (let seen = 0; difat <= MAX_REGULAR_SECTOR && fatSectors.length < fatCount; seen++) {
    if (seen >= sectorCount) throw new Error('Compound file has a broken DIFAT chain')
    const s = sector(difat)
    for (let i = 0; i < entriesPerSector - 1; i++) addFat(s.readUInt32LE(i * 4))
    difat = s.readUInt32LE(sectorSize - 4)
  }
  const fat = Buffer.concat(fatSectors.map(sector))
  const nextSector = (n: number) => {
    if (n * 4 + 4 > fat.length) throw new Error(`Compound file sector ${n} is not in its FAT`)
    return fat.readUInt32LE(n * 4)
  }
  /** The bytes of the chain of sectors from `first`, or of its first `wanted`. */
  const chainBytes = (first: number, wanted?: number) => {
    const sectors = chain(first, nextSector, sectorCount, wanted)
    if (sectors.some((n) => n >= sectorCount))
      throw new Error('Compound file sector is past its end')
    return gather(bytes, sectors, sectorSize, sectorSize)
  }
  const read = (first: number, size: number) =>
    fitted(chainBytes(first, Math.ceil(size / sectorSize)), size)

  const directory = chainBytes(bytes.readUInt32LE(0x30))
  const entryCount = Math.floor(directory.length / DIRECTORY_ENTRY_BYTES)
  const entry = (i: number) => {
    if (i >= entryCount) throw new Error(`Compound file directory entry ${i} is past its end`)
    const e = directory.subarray(i * DIRECTORY_ENTRY_BYTES, (i + 1) * DIRECTORY_ENTRY_BYTES)
    const nameBytes = Math.min(64, e.readUInt16LE(0x40))
    return {
      name: e.toString('utf16le', 0, Math.max(0, nameBytes - 2)),
      type: e[0x42],
      left: e.readUInt32LE(0x44),
      right: e.readUInt32LE(0x48),
      child: e.readUInt32LE(0x4c),
      start: e.readUInt32LE(0x74),
      // The high half is 0 in a file of 512-byte sectors, and past what we read in any
      size: e.readUInt32LE(0x78),
    }
  }
  const root = entry(0)
  if (root.type !== ROOT) throw new Error('Compound file has no root entry')

  // A storage's children, a tree by name: walked, not searched, as a writer may
  // not balance it. An entry is reached once at most, whatever storage names it
  const streams = new Map<string, { path: string; start: number; size: number }>()
  const pending: [number, string, number][] = root.child === NO_STREAM ? [] : [[root.child, '', 0]]
  const visited = new Set<number>()
  while (pending.length > 0) {
    const [i, parent, depth] = pending.pop()!
    if (visited.has(i)) throw new Error('Compound file directory has a loop')
    visited.add(i)
    const e = entry(i)
    const path = parent + e.name
    if (e.type === STREAM) streams.set(path.toLowerCase(), { path, ...e })
    if (e.type === STORAGE && e.child !== NO_STREAM) {
      if (depth >= MAX_DEPTH) throw new Error('Compound file storages nest too deep')
      pending.push([e.child, `${path}/`, depth + 1])
    }
    if (e.left !== NO_STREAM) pending.push([e.left, parent, depth])
    if (e.right !== NO_STREAM) pending.push([e.right, parent, depth])
  }

  const miniCutoff = bytes.readUInt32LE(0x38)
  let mini: { stream: Buffer; fat: Buffer } | undefined
  const miniParts = () => {
    if (!mini) {
      const firstMiniFat = bytes.readUInt32LE(0x3c)
      mini = {
        stream: root.start > MAX_REGULAR_SECTOR ? Buffer.alloc(0) : read(root.start, root.size),
        fat: firstMiniFat > MAX_REGULAR_SECTOR ? Buffer.alloc(0) : chainBytes(firstMiniFat),
      }
    }
    return mini
  }
  const readMini = (first: number, size: number) => {
    const { stream, fat: miniFat } = miniParts()
    const limit = Math.floor(stream.length / MINI_SECTOR_BYTES)
    const next = (n: number) => {
      if (n * 4 + 4 > miniFat.length)
        throw new Error(`Compound file mini sector ${n} is not in its FAT`)
      return miniFat.readUInt32LE(n * 4)
    }
    const sectors = chain(first, next, limit, Math.ceil(size / MINI_SECTOR_BYTES))
    if (sectors.some((n) => n >= limit))
      throw new Error('Compound file mini sector is past its end')
    return fitted(gather(stream, sectors, MINI_SECTOR_BYTES, 0), size)
  }

  return {
    stream(path) {
      const e = streams.get(path.toLowerCase())
      if (!e) return undefined
      if (e.size === 0) return Buffer.alloc(0)
      return e.size < miniCutoff ? readMini(e.start, e.size) : read(e.start, e.size)
    },
    paths: () => [...streams.values()].map((e) => e.path),
  }
}

/**
 * The `unit`-byte sectors `sectors` of `source`, the first at `base`: a slice
 * of it where they run on, copied together only where they do not, and padded
 * with zeros where the file ends inside the last.
 */
function gather(source: Buffer, sectors: number[], unit: number, base: number): Buffer {
  const parts: Buffer[] = []
  let length = 0
  for (let i = 0; i < sectors.length;) {
    let j = i + 1
    while (j < sectors.length && sectors[j] === sectors[j - 1] + 1) j++
    const start = base + sectors[i] * unit
    const part = source.subarray(start, start + (j - i) * unit)
    parts.push(part)
    length += part.length
    i = j
  }
  const short = sectors.length * unit - length
  if (short > 0) parts.push(Buffer.alloc(short))
  return parts.length === 1 ? parts[0] : Buffer.concat(parts)
}

/** `data` cut to the `size` its directory entry gives. */
function fitted(data: Buffer, size: number): Buffer {
  if (data.length < size) throw new Error('Compound file stream is shorter than it says')
  return data.subarray(0, size)
}
