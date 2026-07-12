/**
 * Encoding detection and decoding utilities (Node.js only — uses Buffer and
 * chardet). NOT re-exported from index.ts to avoid polluting the frontend
 * bundle. Import as '@kukan/shared/encoding-node' from server-side code only.
 */

import chardet from 'chardet'

const AUTO_DETECT_FORMATS = new Set(['csv', 'tsv', 'txt', 'text', 'html', 'htm'])

/**
 * Detect encoding based on format-specific rules.
 * - CSV/TSV/TXT/HTML/HTM: chardet auto-detection (Mozilla universal charset detector)
 * - XML: parse <?xml encoding="..."> declaration, default UTF-8
 * - JSON/GeoJSON/MD: UTF-8 fixed (by spec)
 *
 * chardet returns encoding names in IANA format (e.g. "Shift_JIS", "UTF-8").
 * bufferToUtf8() uses TextDecoder which accepts IANA names directly.
 *
 * @param format - lowercase format string
 */
export function detectEncoding(format: string, buffer: Buffer): string {
  if (AUTO_DETECT_FORMATS.has(format)) {
    const detected = chardet.detect(buffer)
    return detected ?? 'UTF-8'
  }
  if (format === 'xml') {
    return parseXmlDeclaredEncoding(buffer)
  }
  return 'UTF-8'
}

/**
 * Parse encoding from XML declaration (<?xml ... encoding="..." ?>).
 * Returns IANA encoding name, or 'UTF-8' if no declaration.
 */
function parseXmlDeclaredEncoding(buffer: Buffer): string {
  const head = buffer.subarray(0, 200).toString('ascii')
  const match = head.match(/<\?xml[^?]*encoding=["']([^"']+)["']/)
  return match ? match[1] : 'UTF-8'
}

/** Map legacy encoding-japanese names to IANA names for TextDecoder */
const LEGACY_ENCODING_MAP: Record<string, string> = {
  utf8: 'utf-8',
  sjis: 'shift_jis',
  eucjp: 'euc-jp',
  jis: 'iso-2022-jp',
  unicode: 'utf-8',
  unknown: 'utf-8',
}

/** Convert buffer to UTF-8 string using detected encoding.
 *  Uses Node.js TextDecoder which supports IANA encoding names
 *  (Shift_JIS, EUC-JP, EUC-KR, Big5, GB18030, ISO-8859-*, Windows-125*, etc.).
 *  Also accepts legacy encoding-japanese names (SJIS, EUCJP, JIS) for
 *  backward compatibility with existing pipeline data. */
export function bufferToUtf8(buf: Buffer, encoding: string): string {
  const lower = encoding.toLowerCase()
  const iana = LEGACY_ENCODING_MAP[lower] ?? lower
  if (iana === 'utf-8' || iana === 'ascii') {
    return buf.toString('utf-8')
  }
  const decoder = new TextDecoder(iana)
  return decoder.decode(buf)
}

/** Remove a trailing U+FFFD left by cutting a multi-byte character at a
 *  byte-boundary truncation (range reads, byte-limited indexing). */
export function stripTrailingReplacementChar(text: string): string {
  return text.replace(/\uFFFD$/, '')
}
