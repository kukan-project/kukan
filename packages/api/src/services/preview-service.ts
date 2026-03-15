/**
 * KUKAN Preview Service
 * Fetches and parses resource files for preview display
 */

import { Readable } from 'stream'
import Papa from 'papaparse'
import Encoding from 'encoding-japanese'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { ValidationError, KukanError } from '@kukan/shared'

const MAX_PREVIEW_ROWS = 100
const MAX_PREVIEW_COLUMNS = 50
const MAX_CELL_LENGTH = 200
const MAX_BYTES = 5 * 1024 * 1024 // 5MB
const FETCH_TIMEOUT_MS = 10_000

export interface PreviewResult {
  headers: string[]
  rows: string[][]
  totalRows: number
  truncated: boolean
  format: string
  encoding: string
}

interface ResourceInfo {
  format?: string | null
  mimetype?: string | null
  storageKey?: string | null
  url?: string | null
}

export class PreviewService {
  constructor(private storage: StorageAdapter) {}

  async getPreview(resource: ResourceInfo): Promise<PreviewResult> {
    if (!isCsvFormat(resource.format, resource.mimetype)) {
      throw new ValidationError('Preview not available for this format')
    }

    const buf = await this.fetchBuffer(resource)
    const detected = Encoding.detect(buf)
    const encoding = typeof detected === 'string' ? detected : 'UTF8'
    const csvText = bufferToUtf8(buf, encoding)
    return parseCsv(csvText, encoding)
  }

  private async fetchBuffer(resource: ResourceInfo): Promise<Buffer> {
    if (resource.storageKey) {
      const stream = await this.storage.download(resource.storageKey)
      return streamToBuffer(stream, MAX_BYTES)
    }
    if (resource.url) {
      const response = await fetch(resource.url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!response.ok || !response.body) {
        throw new KukanError('Failed to fetch external resource', 'BAD_GATEWAY', 502)
      }
      const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
      return streamToBuffer(stream, MAX_BYTES)
    }
    throw new ValidationError('No data source available')
  }
}

function isCsvFormat(format?: string | null, mimetype?: string | null): boolean {
  const f = format?.toLowerCase()
  const m = mimetype?.toLowerCase()
  return f === 'csv' || m === 'text/csv' || m === 'application/csv'
}

function parseCsv(text: string, encoding: string): PreviewResult {
  const result = Papa.parse(text, { header: false, skipEmptyLines: true })

  if (result.errors.length > 0 && result.data.length === 0) {
    throw new ValidationError('Failed to parse CSV')
  }

  const allRows = result.data as string[][]
  if (allRows.length === 0) {
    return { headers: [], rows: [], totalRows: 0, truncated: false, format: 'csv', encoding }
  }

  const headers = allRows[0].slice(0, MAX_PREVIEW_COLUMNS).map((h) => truncate(h, MAX_CELL_LENGTH))
  const dataRows = allRows.slice(1)
  const truncated = dataRows.length > MAX_PREVIEW_ROWS

  const rows = dataRows
    .slice(0, MAX_PREVIEW_ROWS)
    .map((row) => row.slice(0, MAX_PREVIEW_COLUMNS).map((cell) => truncate(cell, MAX_CELL_LENGTH)))

  return {
    headers,
    rows,
    totalRows: dataRows.length,
    truncated,
    format: 'csv',
    encoding,
  }
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '...' : str
}

/** Convert buffer to UTF-8 string using detected encoding */
function bufferToUtf8(buf: Buffer, encoding: string): string {
  if (encoding !== 'UTF8' && encoding !== 'ASCII') {
    const converted = Encoding.convert(buf, { to: 'UNICODE', from: encoding as Encoding.Encoding })
    return Encoding.codeToString(converted)
  }
  return buf.toString('utf-8')
}

async function streamToBuffer(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let totalSize = 0
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalSize += buf.length
    if (totalSize > maxBytes) {
      stream.destroy()
      break
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}
