'use client'

import { memo } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ImageIcon } from 'lucide-react'
import { absoluteSafeHref } from '@/lib/safe-url'

const REMARK_PLUGINS = [remarkGfm]

/** A link's href, where it is absolute and on the allowlist; a relative one stays text. */
const linkHref = (url: string) => absoluteSafeHref(url) ?? ''

const components: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <>{children}</>
    ),
  img: ({ alt }) => (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <ImageIcon className="size-3.5 shrink-0" aria-hidden />
      {alt}
    </span>
  ),
  // The frame hugs the table; a wide one scrolls on its own rather than widening the page
  table: ({ children }) => (
    <div className="my-4 w-fit max-w-full overflow-x-auto rounded-md border">
      <table>{children}</table>
    </div>
  ),
}

/**
 * A Markdown resource drawn as the document it writes: headings, lists, tables
 * and links (GFM). Loaded on demand, so the parser is only fetched for a page
 * that shows one.
 *
 * Nothing the file says in HTML is drawn — `skipHtml` drops the tags and keeps
 * the text between them — and a link only gets an href where it is absolute
 * and on the scheme allowlist ({@link linkHref}). An image is shown as its
 * alternative text alone: the file's relative paths point nowhere from here.
 */
function MarkdownDocument({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        skipHtml
        urlTransform={linkHref}
        components={components}
      >
        {text}
      </Markdown>
    </div>
  )
}

// Memoized: a parse of up to 1 MB is not to be repeated by a parent's re-render
export default memo(MarkdownDocument)
