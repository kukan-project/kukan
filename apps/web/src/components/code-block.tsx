'use client'

/**
 * A copyable block of code or a URL, shared by the panels that hand one over.
 *
 * Lifted out of the Data API dialog when the OData feed got a panel of its
 * own: both hand the reader something to paste, and a second copy of the copy
 * button is a second place for it to drift.
 */

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Check, Copy } from 'lucide-react'
import { Button, cn } from '@kukan/ui'
import { highlight, useHighlighter, type HighlightLang } from '@/hooks/use-shiki'

export function CopyButton({ text }: { text: string }) {
  const t = useTranslations('resource')
  const [copied, setCopied] = useState(false)

  async function copy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const label = copied ? t('dataApiCopied') : t('dataApiCopy')
  return (
    <Button
      variant="ghost"
      size="icon"
      className="absolute top-1 right-1 h-7 w-7"
      onClick={copy}
      title={label}
      aria-label={label}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
  )
}

/** Shared text metrics for plain, highlighted, and mirrored code blocks. */
export const CODE_BLOCK_CLASS = 'p-3 pr-10 font-mono text-xs'

export function CodeBlock({ code, lang }: { code: string; lang?: HighlightLang }) {
  const highlighter = useHighlighter(lang !== undefined)
  return (
    <div className="relative rounded-md border bg-muted">
      {highlighter && lang ? (
        // Shiki escapes the code it wraps; nothing user-controlled reaches
        // this HTML unescaped.
        <div
          className={cn(CODE_BLOCK_CLASS, 'overflow-x-auto')}
          dangerouslySetInnerHTML={{ __html: highlight(highlighter, code, lang) }}
        />
      ) : (
        <pre className={cn(CODE_BLOCK_CLASS, 'overflow-x-auto')}>{code}</pre>
      )}
      <CopyButton text={code} />
    </div>
  )
}
