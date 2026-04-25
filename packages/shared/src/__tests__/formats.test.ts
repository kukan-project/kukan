import { describe, it, expect } from 'vitest'
import {
  normalizeFormat,
  detectFormat,
  getMimeType,
  detectContentType,
  isCsvFormat,
  isTextFormat,
  isOfficeFormat,
  isPdfFormat,
  isDocumentFormat,
  isGeoJsonFormat,
  isZipFormat,
  toCharset,
  getStorageKey,
  getPreviewKey,
} from '../formats'

describe('normalizeFormat', () => {
  it('should normalize known lowercase extensions', () => {
    expect(normalizeFormat('csv')).toBe('CSV')
    expect(normalizeFormat('json')).toBe('JSON')
    expect(normalizeFormat('pdf')).toBe('PDF')
  })

  it('should normalize case-insensitive input', () => {
    expect(normalizeFormat('CSV')).toBe('CSV')
    expect(normalizeFormat('Csv')).toBe('CSV')
    expect(normalizeFormat('Json')).toBe('JSON')
  })

  it('should preserve special casing for GeoJSON', () => {
    expect(normalizeFormat('geojson')).toBe('GeoJSON')
    expect(normalizeFormat('GEOJSON')).toBe('GeoJSON')
  })

  it('should map htm to HTML', () => {
    expect(normalizeFormat('htm')).toBe('HTML')
  })

  it('should uppercase unknown formats', () => {
    expect(normalizeFormat('parquet')).toBe('PARQUET')
    expect(normalizeFormat('yaml')).toBe('YAML')
  })
})

describe('detectFormat', () => {
  it('should detect format from filename extension', () => {
    expect(detectFormat('data.csv')).toBe('CSV')
    expect(detectFormat('report.pdf')).toBe('PDF')
    expect(detectFormat('map.geojson')).toBe('GeoJSON')
  })

  it('should handle uppercase extensions', () => {
    expect(detectFormat('DATA.CSV')).toBe('CSV')
    expect(detectFormat('file.JSON')).toBe('JSON')
  })

  it('should use last extension for multiple dots', () => {
    expect(detectFormat('data.backup.csv')).toBe('CSV')
    expect(detectFormat('archive.tar.zip')).toBe('ZIP')
  })

  it('should return undefined for no extension', () => {
    expect(detectFormat('README')).toBeUndefined()
  })

  it('should return undefined for dot-only filename', () => {
    expect(detectFormat('.gitignore')).toBeUndefined()
  })

  it('should return undefined for empty string', () => {
    expect(detectFormat('')).toBeUndefined()
  })

  it('should uppercase unknown extensions', () => {
    expect(detectFormat('file.parquet')).toBe('PARQUET')
  })
})

describe('getMimeType', () => {
  it('should return MIME type for known formats', () => {
    expect(getMimeType('csv')).toBe('text/csv')
    expect(getMimeType('json')).toBe('application/json')
    expect(getMimeType('pdf')).toBe('application/pdf')
    expect(getMimeType('geojson')).toBe('application/geo+json')
    expect(getMimeType('xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
  })

  it('should be case-insensitive', () => {
    expect(getMimeType('CSV')).toBe('text/csv')
    expect(getMimeType('Pdf')).toBe('application/pdf')
  })

  it('should return undefined for unknown formats', () => {
    expect(getMimeType('parquet')).toBeUndefined()
    expect(getMimeType('yaml')).toBeUndefined()
  })
})

describe('detectContentType', () => {
  it('should detect content type from filename', () => {
    expect(detectContentType('data.csv')).toBe('text/csv')
    expect(detectContentType('doc.pdf')).toBe('application/pdf')
    expect(detectContentType('page.html')).toBe('text/html')
    expect(detectContentType('page.htm')).toBe('text/html')
  })

  it('should default to application/octet-stream for unknown extension', () => {
    expect(detectContentType('file.unknown')).toBe('application/octet-stream')
  })

  it('should default to application/octet-stream for no extension', () => {
    expect(detectContentType('README')).toBe('application/octet-stream')
  })
})

describe('isCsvFormat', () => {
  it('should return true for csv format', () => {
    expect(isCsvFormat('csv')).toBe(true)
    expect(isCsvFormat('CSV')).toBe(true)
  })

  it('should return true for tsv format', () => {
    expect(isCsvFormat('tsv')).toBe(true)
    expect(isCsvFormat('TSV')).toBe(true)
  })

  it('should return true for csv MIME types', () => {
    expect(isCsvFormat(undefined, 'text/csv')).toBe(true)
    expect(isCsvFormat(undefined, 'application/csv')).toBe(true)
    expect(isCsvFormat(undefined, 'text/tab-separated-values')).toBe(true)
  })

  it('should be case-insensitive for MIME types', () => {
    expect(isCsvFormat(undefined, 'Text/CSV')).toBe(true)
  })

  it('should return false for non-csv formats', () => {
    expect(isCsvFormat('json')).toBe(false)
    expect(isCsvFormat('pdf')).toBe(false)
    expect(isCsvFormat(undefined, 'application/json')).toBe(false)
  })

  it('should return false for null/undefined', () => {
    expect(isCsvFormat()).toBe(false)
    expect(isCsvFormat(null, null)).toBe(false)
    expect(isCsvFormat(undefined, undefined)).toBe(false)
  })
})

describe('isTextFormat', () => {
  it('should return true for CSV/TSV (via isCsvFormat)', () => {
    expect(isTextFormat('csv')).toBe(true)
    expect(isTextFormat('tsv')).toBe(true)
  })

  it('should return true for text-based formats', () => {
    expect(isTextFormat('txt')).toBe(true)
    expect(isTextFormat('json')).toBe(true)
    expect(isTextFormat('geojson')).toBe(true)
    expect(isTextFormat('xml')).toBe(true)
    expect(isTextFormat('html')).toBe(true)
    expect(isTextFormat('htm')).toBe(true)
    expect(isTextFormat('md')).toBe(true)
  })

  it('should be case-insensitive', () => {
    expect(isTextFormat('JSON')).toBe(true)
    expect(isTextFormat('TXT')).toBe(true)
  })

  it('should return false for binary formats', () => {
    expect(isTextFormat('pdf')).toBe(false)
    expect(isTextFormat('xlsx')).toBe(false)
    expect(isTextFormat('zip')).toBe(false)
    expect(isTextFormat('doc')).toBe(false)
  })

  it('should return false for null', () => {
    expect(isTextFormat(null)).toBe(false)
  })
})

describe('toCharset', () => {
  it('should map encoding-japanese names to WHATWG charset labels', () => {
    expect(toCharset('UTF8')).toBe('utf-8')
    expect(toCharset('ASCII')).toBe('utf-8')
    expect(toCharset('SJIS')).toBe('shift_jis')
    expect(toCharset('EUCJP')).toBe('euc-jp')
    expect(toCharset('JIS')).toBe('iso-2022-jp')
    expect(toCharset('UNICODE')).toBe('utf-8')
  })

  it('should default to utf-8 for unknown encodings', () => {
    expect(toCharset('UNKNOWN')).toBe('utf-8')
    expect(toCharset('')).toBe('utf-8')
  })
})

describe('getStorageKey', () => {
  it('should compute storage key from package and resource IDs', () => {
    expect(getStorageKey('pkg-123', 'res-456')).toBe('resources/pkg-123/res-456')
  })
})

describe('getPreviewKey', () => {
  it('should compute preview key with .parquet extension by default', () => {
    expect(getPreviewKey('pkg-123', 'res-456')).toBe('previews/pkg-123/res-456.parquet')
  })

  it('should compute preview key with specified extension', () => {
    expect(getPreviewKey('pkg-123', 'res-456', 'json')).toBe('previews/pkg-123/res-456.json')
  })
})

describe('isOfficeFormat', () => {
  it('should return true for Office formats', () => {
    expect(isOfficeFormat('xlsx')).toBe(true)
    expect(isOfficeFormat('xls')).toBe(true)
    expect(isOfficeFormat('doc')).toBe(true)
    expect(isOfficeFormat('docx')).toBe(true)
    expect(isOfficeFormat('ppt')).toBe(true)
    expect(isOfficeFormat('pptx')).toBe(true)
    expect(isOfficeFormat('DOCX')).toBe(true)
    expect(isOfficeFormat('PPTX')).toBe(true)
  })

  it('should return false for non-Office formats', () => {
    expect(isOfficeFormat('pdf')).toBe(false)
    expect(isOfficeFormat('csv')).toBe(false)
    expect(isOfficeFormat('txt')).toBe(false)
  })

  it('should return false for null', () => {
    expect(isOfficeFormat(null)).toBe(false)
  })
})

describe('isPdfFormat', () => {
  it('should return true for PDF format', () => {
    expect(isPdfFormat('pdf')).toBe(true)
    expect(isPdfFormat('PDF')).toBe(true)
    expect(isPdfFormat('Pdf')).toBe(true)
  })

  it('should return false for non-PDF formats', () => {
    expect(isPdfFormat('docx')).toBe(false)
    expect(isPdfFormat('csv')).toBe(false)
  })

  it('should return false for null', () => {
    expect(isPdfFormat(null)).toBe(false)
  })
})

describe('isDocumentFormat', () => {
  it('should return true for all officeparser-supported formats', () => {
    expect(isDocumentFormat('pdf')).toBe(true)
    expect(isDocumentFormat('docx')).toBe(true)
    expect(isDocumentFormat('xlsx')).toBe(true)
    expect(isDocumentFormat('pptx')).toBe(true)
    expect(isDocumentFormat('odt')).toBe(true)
    expect(isDocumentFormat('odp')).toBe(true)
    expect(isDocumentFormat('ods')).toBe(true)
    expect(isDocumentFormat('rtf')).toBe(true)
  })

  it('should be case-insensitive', () => {
    expect(isDocumentFormat('DOCX')).toBe(true)
    expect(isDocumentFormat('PDF')).toBe(true)
  })

  it('should return false for legacy Office formats', () => {
    expect(isDocumentFormat('doc')).toBe(false)
    expect(isDocumentFormat('xls')).toBe(false)
    expect(isDocumentFormat('ppt')).toBe(false)
  })

  it('should return false for non-document formats', () => {
    expect(isDocumentFormat('csv')).toBe(false)
    expect(isDocumentFormat('txt')).toBe(false)
    expect(isDocumentFormat('zip')).toBe(false)
  })

  it('should return false for null', () => {
    expect(isDocumentFormat(null)).toBe(false)
  })
})

describe('isGeoJsonFormat', () => {
  it('should return true for GeoJSON format', () => {
    expect(isGeoJsonFormat('geojson')).toBe(true)
    expect(isGeoJsonFormat('GeoJSON')).toBe(true)
    expect(isGeoJsonFormat('GEOJSON')).toBe(true)
  })

  it('should return false for non-GeoJSON formats', () => {
    expect(isGeoJsonFormat('json')).toBe(false)
    expect(isGeoJsonFormat('csv')).toBe(false)
  })

  it('should return false for null', () => {
    expect(isGeoJsonFormat(null)).toBe(false)
  })
})

describe('isZipFormat', () => {
  it('should return true for zip format', () => {
    expect(isZipFormat('zip')).toBe(true)
    expect(isZipFormat('ZIP')).toBe(true)
    expect(isZipFormat('Zip')).toBe(true)
  })

  it('should return false for non-zip formats', () => {
    expect(isZipFormat('pdf')).toBe(false)
    expect(isZipFormat('csv')).toBe(false)
    expect(isZipFormat('tar')).toBe(false)
  })

  it('should return false for null', () => {
    expect(isZipFormat(null)).toBe(false)
  })
})
