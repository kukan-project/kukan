import React from 'react'

/**
 * Lightweight markdown renderer for dataset notes.
 * Supports: **bold**, *italic*, ~~strikethrough~~, `code`,
 * [text](url), HTML entities, newlines.
 * No external dependencies.
 */
export function renderSimpleMarkdown(text: string): React.ReactNode[] {
  const decoded = decodeHtmlEntities(text)
  const lines = decoded.split('\n')
  return lines.map((line, i) => {
    const parts = parseInline(line)
    return (
      <React.Fragment key={i}>
        {i > 0 && <br />}
        {parts}
      </React.Fragment>
    )
  })
}

// Order matters: longer/greedy patterns first to avoid partial matches
// - [text](url)  — links
// - `code`       — inline code
// - **bold**     — strong (before *italic* to avoid conflict)
// - *italic*     — emphasis
// - ~~strike~~   — strikethrough
const INLINE_PATTERN = /\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|~~([^~]+)~~/g

function parseInline(text: string): React.ReactNode[] {
  const regex = new RegExp(INLINE_PATTERN.source, 'g')
  const nodes: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index))
    }
    const key = match.index
    if (match[1] && match[2]) {
      // Link: [text](url) — recursively parse inner text for **bold** etc.
      const innerNodes = parseInline(match[1])
      nodes.push(
        <a
          key={key}
          href={match[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline-offset-4 hover:underline"
        >
          {innerNodes}
        </a>
      )
    } else if (match[3]) {
      // Inline code: `code`
      nodes.push(
        <code key={key} className="rounded bg-muted px-1.5 py-0.5 text-sm">
          {match[3]}
        </code>
      )
    } else if (match[4]) {
      // Bold: **text**
      nodes.push(<strong key={key}>{match[4]}</strong>)
    } else if (match[5]) {
      // Italic: *text*
      nodes.push(<em key={key}>{match[5]}</em>)
    } else if (match[6]) {
      // Strikethrough: ~~text~~
      nodes.push(<del key={key}>{match[6]}</del>)
    }
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }
  return nodes
}

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': '\u00A0',
  '&emsp;': '\u2003',
  '&ensp;': '\u2002',
  '&thinsp;': '\u2009',
  '&ndash;': '\u2013',
  '&mdash;': '\u2014',
  '&laquo;': '\u00AB',
  '&raquo;': '\u00BB',
  '&hellip;': '\u2026',
  '&copy;': '\u00A9',
  '&reg;': '\u00AE',
  '&trade;': '\u2122',
  '&yen;': '\u00A5',
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&[a-zA-Z]+;/g, (entity) => ENTITY_MAP[entity] ?? entity)
}
