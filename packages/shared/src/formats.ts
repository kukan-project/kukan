/**
 * Canonical format names, MIME types, and detection utilities.
 * Single source of truth for file format mapping across the codebase.
 */

/** Extension (lowercase) → canonical format name */
const FORMAT_MAP: Record<string, string> = {
  csv: 'CSV',
  tsv: 'TSV',
  json: 'JSON',
  geojson: 'GeoJSON',
  xml: 'XML',
  xlsx: 'XLSX',
  xls: 'XLS',
  pdf: 'PDF',
  zip: 'ZIP',
  doc: 'DOC',
  docx: 'DOCX',
  ppt: 'PPT',
  pptx: 'PPTX',
  odt: 'ODT',
  odp: 'ODP',
  ods: 'ODS',
  rtf: 'RTF',
  txt: 'TXT',
  html: 'HTML',
  htm: 'HTML',
  rdf: 'RDF',
  png: 'PNG',
  jpg: 'JPEG',
  jpeg: 'JPEG',
  gif: 'GIF',
  webp: 'WebP',
  svg: 'SVG',
  bmp: 'BMP',
  tif: 'TIFF',
  tiff: 'TIFF',
}

/** Extension (lowercase) → MIME type */
const MIME_MAP: Record<string, string> = {
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  geojson: 'application/geo+json',
  xml: 'application/xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  pdf: 'application/pdf',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  odp: 'application/vnd.oasis.opendocument.presentation',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  rtf: 'application/rtf',
  txt: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  rdf: 'application/rdf+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
}

function getExtension(filename: string): string | undefined {
  const dotIndex = filename.lastIndexOf('.')
  if (dotIndex <= 0) return undefined
  return filename.slice(dotIndex + 1).toLowerCase()
}

/** Normalize a format string to its canonical case (e.g. 'csv' → 'CSV', 'geojson' → 'GeoJSON') */
export function normalizeFormat(format: string): string {
  return FORMAT_MAP[format.toLowerCase()] ?? format.toUpperCase()
}

/** Detect format from filename extension (e.g. 'data.csv' → 'CSV') */
export function detectFormat(filename: string): string | undefined {
  const ext = getExtension(filename)
  if (!ext) return undefined
  return normalizeFormat(ext)
}

/** Get MIME type from a format string (e.g. 'pdf' → 'application/pdf', 'CSV' → 'text/csv') */
export function getMimeType(format: string): string | undefined {
  return MIME_MAP[format.toLowerCase()]
}

/** Detect MIME type from filename extension (e.g. 'data.csv' → 'text/csv') */
export function detectContentType(filename: string): string {
  const ext = getExtension(filename)
  return (ext && MIME_MAP[ext]) || 'application/octet-stream'
}

const CSV_MIMES = new Set(['text/csv', 'application/csv', 'text/tab-separated-values'])

/** Check if a format/mimetype indicates CSV or TSV */
export function isCsvFormat(format?: string | null, mimetype?: string | null): boolean {
  const f = format?.toLowerCase()
  const m = mimetype?.toLowerCase()
  return f === 'csv' || f === 'tsv' || (!!m && CSV_MIMES.has(m))
}

const JSON_FORMATS = new Set(['json', 'geojson'])

/** Check if a format is JSON-based (JSON or GeoJSON) */
export function isJsonFormat(format: string | null): boolean {
  if (!format) return false
  return JSON_FORMATS.has(format.toLowerCase())
}

const TEXT_FORMATS = new Set(['txt', 'text', 'json', 'geojson', 'xml', 'html', 'htm', 'md'])

/** Check if a format is text-based (CSV/TSV or plain text variants) */
export function isTextFormat(format: string | null): boolean {
  if (!format) return false
  const f = format.toLowerCase()
  return isCsvFormat(format) || TEXT_FORMATS.has(f)
}

/**
 * Normalize encoding name to WHATWG charset label.
 * Accepts IANA names from chardet (e.g. "Shift_JIS", "UTF-8") and
 * legacy encoding-japanese names (e.g. "SJIS", "UTF8") for backward
 * compatibility with existing pipeline data.
 * @see https://encoding.spec.whatwg.org/#names-and-labels
 */
const ENCODING_TO_CHARSET: Record<string, string> = {
  // Legacy encoding-japanese names
  UTF8: 'utf-8',
  ASCII: 'utf-8',
  SJIS: 'shift_jis',
  EUCJP: 'euc-jp',
  JIS: 'iso-2022-jp',
  UNICODE: 'utf-8',
  UNKNOWN: 'utf-8',
}

/** Convert encoding name to WHATWG charset label (defaults to utf-8).
 *  Unknown or invalid encoding names are rejected and fall back to utf-8. */
export function toCharset(encoding: string): string {
  const legacy = ENCODING_TO_CHARSET[encoding]
  if (legacy) return legacy
  const lower = encoding.toLowerCase()
  if (lower === 'ascii') return 'utf-8'
  if (!lower) return 'utf-8'
  // Validate against WHATWG encoding labels via TextDecoder
  try {
    new TextDecoder(lower)
    return lower
  } catch {
    return 'utf-8'
  }
}

/** Maximum upload file size (100 MB) — shared between client and server */
export const MAX_UPLOAD_SIZE = 100 * 1024 * 1024

/** Storage key prefix for resource raw files */
export const RESOURCE_PREFIX = 'resources/'

/** Storage key prefix for preview files */
export const PREVIEW_PREFIX = 'previews/'

/** Compute storage key for a resource's raw file */
export function getStorageKey(packageId: string, resourceId: string): string {
  return `${RESOURCE_PREFIX}${packageId}/${resourceId}`
}

/** Compute storage key for a resource's preview file */
export function getPreviewKey(
  packageId: string,
  resourceId: string,
  ext: 'parquet' | 'json' = 'parquet'
): string {
  return `${PREVIEW_PREFIX}${packageId}/${resourceId}.${ext}`
}

const OFFICE_FORMATS = new Set(['xlsx', 'xls', 'doc', 'docx', 'ppt', 'pptx'])

/** Check if a format is viewable via Office Online Viewer (Excel/Word/PowerPoint) */
export function isOfficeFormat(format: string | null): boolean {
  if (!format) return false
  return OFFICE_FORMATS.has(format.toLowerCase())
}

const DOCUMENT_FORMATS = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'odt', 'odp', 'ods', 'rtf'])

/** Check if a format is a document that supports text extraction via officeparser */
export function isDocumentFormat(format: string | null): boolean {
  if (!format) return false
  return DOCUMENT_FORMATS.has(format.toLowerCase())
}

/** Check if a format is a PDF document */
export function isPdfFormat(format: string | null): boolean {
  if (!format) return false
  return format.toLowerCase() === 'pdf'
}

/** Check if a format is GeoJSON */
export function isGeoJsonFormat(format: string | null): boolean {
  if (!format) return false
  return format.toLowerCase() === 'geojson'
}

const IMAGE_FORMATS = new Set(['png', 'jpeg', 'jpg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff'])

/** Check if a format is an image */
export function isImageFormat(format: string | null): boolean {
  if (!format) return false
  return IMAGE_FORMATS.has(format.toLowerCase())
}

/** Check if a format is a ZIP archive */
export function isZipFormat(format: string | null): boolean {
  if (!format) return false
  return format.toLowerCase() === 'zip'
}
