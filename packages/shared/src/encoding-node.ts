/**
 * Encoding detection and decoding utilities (Node.js only — uses Buffer and
 * chardet). NOT re-exported from index.ts to avoid polluting the frontend
 * bundle. Import as '@kukan/shared/encoding-node' from server-side code only.
 */

import chardet from 'chardet'
import Encoding from 'encoding-japanese'

const AUTO_DETECT_FORMATS = new Set(['csv', 'tsv', 'txt', 'text', 'html', 'htm'])

/**
 * Detect encoding based on format-specific rules.
 * - CSV/TSV/TXT/HTML/HTM: chardet auto-detection (Mozilla universal charset
 *   detector), with a Japanese second opinion where chardet is weakest
 *   ({@link japaneseBehind})
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
    const evidence = evidenceIn(buffer)
    return japaneseBehind(evidence, chardet.detect(evidence) ?? 'UTF-8')
  }
  if (format === 'xml') {
    return parseXmlDeclaredEncoding(buffer)
  }
  return 'UTF-8'
}

/** Every name chardet 2.2.0 gives a single-byte verdict: ISO-8859-1/2/5..9,
 *  windows-1250..1258, windows-874, KOI8-R. Listing them rather than inverting
 *  the multi-byte set keeps the failure mode safe — a recogniser we have not
 *  heard of skips the second opinion instead of qualifying for it. */
const SINGLE_BYTE = /^(?:windows-(?:125\d|874)|ISO-8859-\d+|KOI8-R)$/

/** encoding-japanese's names for the encodings it can vouch for, in chardet's
 *  vocabulary so both detectors answer alike. Its UTF8/UTF16/ASCII/UNICODE/
 *  BINARY verdicts say nothing about Japanese and are absent on purpose. */
const JAPANESE_ENCODINGS: Record<string, string> = {
  SJIS: 'Shift_JIS',
  EUCJP: 'EUC-JP',
  JIS: 'ISO-2022-JP',
}

/** Two adjacent kana or kanji. Half-width katakana is left out on purpose: it
 *  sits at 0xA1-0xDF, over KOI8-R's Cyrillic, and including it reads Russian as
 *  Japanese. */
const JAPANESE_RUN = /[぀-ヿ㐀-䶿一-鿿]{2}/

/**
 * The Japanese encoding hiding behind a single-byte verdict, or the verdict
 * unchanged.
 *
 * Deliberately Japan-specific, in a file that is otherwise locale-neutral:
 * KUKAN's data is Japanese open data, and this is where a general-purpose
 * detector costs us. The blast radius is bounded to verdicts that carry the
 * least evidence to begin with.
 *
 * Only single-byte verdicts are questioned. chardet's multi-byte recognisers are
 * validators — bytes that are not Big5 cannot score as Big5 — so their answers
 * carry real evidence. Its single-byte recognisers cannot be wrong in that way:
 * every byte is legal in every single-byte encoding, so nothing is ever ruled
 * out and the verdict rests on which language's trigrams the bytes happen to
 * hit. A 38-byte Shift_JIS CSV came back windows-1251 on one accidental "в".
 *
 * Nothing is overturned on encoding-japanese's say-so either: it proposes, and
 * the proposal has to survive being decoded and containing actual Japanese.
 * Both halves carry files the other lets through — see the regression tests.
 *
 * Not extended to chardet's CJK verdicts: the run test sees kanji, not language,
 * so it would read Chinese as Japanese and quietly rewrite Big5.
 */
function japaneseBehind(evidence: Buffer, detected: string): string {
  if (!SINGLE_BYTE.test(detected)) return detected
  const proposed = Encoding.detect(evidence)
  const candidate = proposed && JAPANESE_ENCODINGS[proposed]
  if (!candidate) return detected
  return JAPANESE_RUN.test(bufferToUtf8(evidence, candidate)) ? candidate : detected
}

/**
 * The part of a buffer chardet can learn anything from.
 *
 * ASCII bytes are the same in every candidate encoding, so they carry no
 * evidence — and chardet weighs the whole buffer, so they do not merely fail to
 * help: they outvote what evidence there is. A Shift_JIS body behind 100KB of
 * ids and dates comes back windows-1252, and the further the non-ASCII sits
 * from the head, the more confidently wrong the answer.
 *
 * So detection starts where the encodings first disagree. A buffer with no such
 * byte is ASCII, which every candidate decodes identically — the answer is
 * right either way, and passing megabytes of it costs a second of CPU to reach
 * (chardet is synchronous and makes a pass per recogniser).
 */
function evidenceIn(buffer: Buffer): Buffer {
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] & 0x80) return buffer.subarray(i)
  }
  return buffer
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
