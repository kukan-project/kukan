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
  txt: 'TXT',
  html: 'HTML',
  htm: 'HTML',
  rdf: 'RDF',
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
  txt: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  rdf: 'application/rdf+xml',
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

/** Compute storage key for a resource's raw file */
export function getStorageKey(packageId: string, resourceId: string): string {
  return `resources/${packageId}/${resourceId}`
}

/** Compute storage key for a resource's Parquet preview */
export function getPreviewKey(packageId: string, resourceId: string): string {
  return `previews/${packageId}/${resourceId}.parquet`
}
