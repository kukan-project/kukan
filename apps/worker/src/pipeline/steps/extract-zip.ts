/**
 * KUKAN Pipeline — ZIP Manifest Extraction
 * Reads ZIP central directory and produces a file listing manifest.
 * Does NOT extract or decompress file contents.
 */

import yauzl from 'yauzl'
import type { ZipEntry, ZipManifest } from '@kukan/shared'

export type { ZipEntry, ZipManifest }

const MAX_ZIP_ENTRIES = 10_000
const EPOCH_LOCAL = '1970-01-01T00:00:00'

/** General purpose bit flag 11 indicates UTF-8 encoded file names */
const UTF8_FLAG = 0x800

const sjisDecoder = new TextDecoder('shift_jis')
const utf8Decoder = new TextDecoder('utf-8')

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
 * ZIP files from Japanese Windows typically use Shift_JIS encoding.
 * If the UTF-8 flag (bit 11) is set, decode as UTF-8; otherwise try Shift_JIS.
 */
function decodeFileName(buf: Buffer, flags: number): string {
  if (flags & UTF8_FLAG) {
    return utf8Decoder.decode(buf)
  }
  // Try Shift_JIS for non-UTF-8 entries (common in Japanese ZIP files)
  return sjisDecoder.decode(buf)
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

function openZipFromFile(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, YAUZL_OPTIONS, (err, zipFile) => {
      if (err || !zipFile) return reject(err ?? new Error('Failed to open ZIP'))
      resolve(zipFile)
    })
  })
}

/**
 * Extract file listing manifest from a ZIP buffer or file path.
 * Accepts a Buffer (for tests/small files) or a file path (for large files).
 * Returns null if the input is not a valid ZIP.
 */
export async function extractZipManifest(input: Buffer | string): Promise<ZipManifest | null> {
  let zipFile: yauzl.ZipFile
  try {
    zipFile =
      typeof input === 'string' ? await openZipFromFile(input) : await openZipFromBuffer(input)
  } catch {
    return null
  }

  const entries: ZipEntry[] = []
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
          const isDirectory = fileName.endsWith('/')
          if (!isDirectory) totalFiles++

          if (entries.length < MAX_ZIP_ENTRIES) {
            entries.push({
              path: fileName,
              size: entry.uncompressedSize,
              compressedSize: entry.compressedSize,
              lastModified: formatLocalDate(entry.getLastModDate()),
              isDirectory,
            })
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
          truncated: zipFile.entryCount > MAX_ZIP_ENTRIES,
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
