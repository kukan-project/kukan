/**
 * KUKAN Pipeline — ZIP Manifest Extraction
 * Reads ZIP central directory and produces a file listing manifest.
 * Does NOT extract or decompress file contents.
 */

import fs from 'node:fs'
import { PassThrough, Readable } from 'node:stream'
import { promisify } from 'node:util'
import yauzl from 'yauzl'
import type { ZipEntry, ZipManifest } from '@kukan/shared'

export type { ZipEntry, ZipManifest }

const MAX_ZIP_ENTRIES = 10_000
/**
 * Characters of entry names listed, at most. A name may be 64 KB, so the entry
 * cap alone lets a small archive put hundreds of megabytes of names on the heap
 */
const MAX_ZIP_NAME_CHARS = 2_000_000
const EPOCH_LOCAL = '1970-01-01T00:00:00'

/** General purpose bit flag 11 indicates UTF-8 encoded file names */
const UTF8_FLAG = 0x800

const sjisDecoder = new TextDecoder('shift_jis')
const utf8Decoder = new TextDecoder('utf-8')
const utf8StrictDecoder = new TextDecoder('utf-8', { fatal: true })

/**
 * Format a Date as a timezone-free local time string.
 * ZIP timestamps have no timezone info (DOS date/time format),
 * so we preserve the raw local time values without UTC conversion.
 */
function formatLocalDate(date: Date): string {
  const ts = date.getTime()
  if (Number.isNaN(ts)) return EPOCH_LOCAL
  const y = date.getFullYear()
  const mo = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const h = String(date.getHours()).padStart(2, '0')
  const mi = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`
}

/**
 * Decode file name buffer from a ZIP entry.
 *
 * Strategy:
 * 1. UTF-8 flag set → decode as UTF-8
 * 2. Flag not set → try UTF-8 first (some tools omit the flag),
 *    fall back to Shift_JIS if the bytes are not valid UTF-8
 */
function decodeFileName(buf: Buffer, flags: number): string {
  if (flags & UTF8_FLAG) {
    return utf8Decoder.decode(buf)
  }
  // Many modern tools emit UTF-8 without setting the flag.
  // Try strict UTF-8 first; fall back to Shift_JIS on failure.
  try {
    return utf8StrictDecoder.decode(buf)
  } catch {
    return sjisDecoder.decode(buf)
  }
}

const YAUZL_OPTIONS = { lazyEntries: true, decodeStrings: false } as const

function openZipFromBuffer(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, YAUZL_OPTIONS, (err, zipFile) => {
      if (err || !zipFile) return reject(err ?? new Error('Failed to open ZIP'))
      resolve(zipFile)
    })
  })
}

/**
 * A file reader for yauzl that refuses ranges outside the file. yauzl reads at
 * offsets the archive itself states, and its own file reader hands them to
 * `fs.read` from inside an earlier read's callback: an offset past what a
 * Number holds exactly makes `fs.read` throw there, outside any promise, and
 * takes the process down. Refused here, the read fails through yauzl's own
 * error path instead.
 */
class BoundedFileReader extends yauzl.RandomAccessReader {
  constructor(
    private readonly fd: number,
    private readonly size: number
  ) {
    super()
  }

  private outside(start: number, end: number): Error | undefined {
    const inside =
      Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      start >= 0 &&
      start <= end &&
      end <= this.size
    if (inside) return undefined
    return new Error(`ZIP read ${start}..${end} is outside the file (${this.size} bytes)`)
  }

  override read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (err: Error | null, bytesRead?: number) => void
  ): void {
    const err = this.outside(position, position + length)
    if (err) {
      setImmediate(() => callback(err))
      return
    }
    fs.read(this.fd, buffer, offset, length, position, (readErr, bytesRead) =>
      callback(readErr, bytesRead)
    )
  }

  override _readStreamForRange(start: number, end: number): Readable {
    const err = this.outside(start, end)
    if (err) {
      const stream = new PassThrough()
      setImmediate(() => stream.destroy(err))
      return stream
    }
    // Not fs.createReadStream: destroying one closes its descriptor whatever
    // autoClose says, and yauzl destroys each stream it is done with
    const fd = this.fd
    let position = start
    const stream: Readable = new Readable({
      read(size) {
        const length = Math.min(size, end - position)
        if (length <= 0) {
          stream.push(null)
          return
        }
        const buffer = Buffer.allocUnsafe(length)
        fs.read(fd, buffer, 0, length, position, (err, bytesRead) => {
          if (err) {
            stream.destroy(err)
          } else if (bytesRead === 0) {
            stream.push(null)
          } else {
            position += bytesRead
            stream.push(buffer.subarray(0, bytesRead))
          }
        })
      },
    })
    return stream
  }

  override close(callback: (err: Error | null) => void): void {
    fs.close(this.fd, callback)
  }
}

/** Open a ZIP file with yauzl's options, reading it only within its bounds. */
export async function openZipFile(
  filePath: string,
  options: yauzl.Options = YAUZL_OPTIONS
): Promise<yauzl.ZipFile> {
  // A bare descriptor rather than a FileHandle: the reader closes it, and a
  // FileHandle left unclosed would close the same number again when collected
  const fd = await promisify(fs.open)(filePath, 'r')
  try {
    const { size } = await promisify(fs.fstat)(fd)
    return await new Promise<yauzl.ZipFile>((resolve, reject) => {
      yauzl.fromRandomAccessReader(
        new BoundedFileReader(fd, size),
        size,
        // yauzl writes its defaults into the options it is given
        { ...options },
        (err, zipFile) =>
          err || !zipFile ? reject(err ?? new Error('Failed to open ZIP')) : resolve(zipFile)
      )
    })
  } catch (err) {
    // yauzl leaves the reader open when the archive does not open
    await promisify(fs.close)(fd).catch(() => {})
    throw err
  }
}

/**
 * Extract file listing manifest from a ZIP buffer or file path.
 * Accepts a Buffer (for tests/small files) or a file path (for large files).
 * Returns null if the input is not a valid ZIP.
 */
export async function extractZipManifest(input: Buffer | string): Promise<ZipManifest | null> {
  let zipFile: yauzl.ZipFile
  try {
    zipFile = typeof input === 'string' ? await openZipFile(input) : await openZipFromBuffer(input)
  } catch {
    return null
  }

  const entries: ZipEntry[] = []
  let nameChars = 0
  let totalFiles = 0
  let totalSize = 0
  let totalCompressed = 0

  try {
    return await new Promise<ZipManifest | null>((resolve) => {
      let settled = false
      const finish = (result: ZipManifest | null) => {
        if (settled) return
        settled = true
        zipFile.close()
        resolve(result)
      }

      zipFile.on('entry', (entry: yauzl.Entry) => {
        try {
          totalSize += entry.uncompressedSize
          totalCompressed += entry.compressedSize

          const fileName = decodeFileName(
            entry.fileName as unknown as Buffer,
            entry.generalPurposeBitFlag
          )
          nameChars += fileName.length
          const isDirectory = fileName.endsWith('/')
          if (!isDirectory) totalFiles++

          entries.push({
            path: fileName,
            size: entry.uncompressedSize,
            compressedSize: entry.compressedSize,
            lastModified: formatLocalDate(entry.getLastModDate()),
            isDirectory,
          })

          // The central directory may claim millions of entries in a small
          // file; walking the rest only to add up totals is unbounded work.
          // The counts and sizes then cover only the entries listed, with the
          // archive's own claim, folders included, beside them.
          const full = entries.length >= MAX_ZIP_ENTRIES || nameChars >= MAX_ZIP_NAME_CHARS
          if (full && entries.length < zipFile.entryCount) {
            finish({
              totalFiles,
              totalEntries: zipFile.entryCount,
              totalSize,
              totalCompressed,
              truncated: true,
              entries,
            })
            return
          }

          zipFile.readEntry()
        } catch {
          finish(null)
        }
      })

      zipFile.on('end', () => {
        finish({
          totalFiles,
          totalSize,
          totalCompressed,
          truncated: false,
          entries,
        })
      })

      zipFile.on('error', () => {
        finish(null)
      })

      zipFile.readEntry()
    })
  } catch {
    return null
  }
}
