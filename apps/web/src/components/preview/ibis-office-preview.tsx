'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent } from '@kukan/ui'
import { COMPOUND_FILE_SIGNATURE, hasSignature, ZIP_SIGNATURE } from '@kukan/shared'
import { clientFetch } from '@/lib/client-api'
import { IBIS_OFFICE_BOOT, IBIS_OFFICE_HOME, IBIS_OFFICE_WASM } from '@/lib/ibis-office'

/**
 * The largest file drawn (ADR-065 decision 3): ibisOffice's memory grew about
 * fifteen-fold over a document's unpacked size, so this keeps it near the
 * 1 GiB ceiling the boot page puts on it.
 */
const IBIS_OFFICE_LIMIT_MB = 64
const IBIS_OFFICE_LIMIT = IBIS_OFFICE_LIMIT_MB * 1024 * 1024

/** How long the frame has in sight to boot, and then to draw the document it is given */
const FRAME_TIMEOUT_MS = 30_000
const FRAME_CHECK_MS = 1_000

type Failure = 'too-large' | 'unreadable'

/**
 * An Office file's original, drawn by ibisOffice in a sandboxed iframe
 * (ADR-065 decision 2). The frame's origin is opaque and its CSP lets it load
 * only the app; once it has booted, this page fetches the document and the
 * app's WASM (the frame's own fetches would bypass the HTTP cache) and posts
 * both to it once.
 *
 * It starts when scrolled to, so a dataset page opened for its description
 * costs nothing. Hidden — another resource selected, or the other tab — the
 * frame is removed and its memory returned, so one copy of ibisOffice runs at a
 * time. Shown again, it starts over, the WASM from the cache.
 */
export function IbisOfficePreview({
  resourceId,
  format,
  size,
}: {
  resourceId: string
  format: string
  size?: number | null
}) {
  const t = useTranslations('resource')
  const box = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const shown = useShown(box)
  const [failure, setFailure] = useState<Failure | null>(
    size && size > IBIS_OFFICE_LIMIT ? 'too-large' : null
  )
  const [drawn, setDrawn] = useState(false)

  useEffect(() => {
    if (!shown || failure) return
    setDrawn(false)
    const abort = new AbortController()
    let posted = false
    let timer: ReturnType<typeof setInterval> | undefined
    const fail = (why: Failure) => {
      if (!abort.signal.aborted) setFailure(why)
    }
    // A frame out of sight draws nothing (the browser stops its animation
    // frames), which says nothing about the document, so only time in sight counts
    const waitForFrame = () => {
      clearInterval(timer)
      let waited = 0
      timer = setInterval(() => {
        if (inSight(box.current)) waited += FRAME_CHECK_MS
        if (waited >= FRAME_TIMEOUT_MS) fail('unreadable')
      }, FRAME_CHECK_MS)
    }

    const onMessage = async (e: MessageEvent) => {
      const target = frame.current?.contentWindow
      if (!target || e.source !== target) return
      switch (e.data?.type) {
        case 'boot': {
          // Once: a frame navigated by code inside it says 'boot' again, and
          // would be handed the document as often as it asked
          if (posted) return
          posted = true
          clearInterval(timer)
          try {
            const [doc, wasm] = await Promise.all([
              fetchDocument(resourceId, format, abort.signal),
              fetchWasm(abort.signal),
            ])
            if (abort.signal.aborted) return
            target.postMessage({ type: 'open', name: doc.name, bytes: doc.bytes, wasm }, '*', [
              doc.bytes,
              wasm,
            ])
            waitForFrame()
          } catch (err) {
            fail(err instanceof TooLarge ? 'too-large' : 'unreadable')
          }
          return
        }
        case 'ready':
          clearInterval(timer)
          setDrawn(true)
          return
        case 'error':
          fail('unreadable')
      }
    }
    addEventListener('message', onMessage)
    // A frame the CSP blocks, or that cannot load the app, never says 'boot'
    waitForFrame()
    return () => {
      abort.abort()
      clearInterval(timer)
      removeEventListener('message', onMessage)
    }
  }, [shown, failure, resourceId, format])

  if (failure) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {failure === 'too-large'
            ? t('previewOfficeOriginalTooLarge', { mb: IBIS_OFFICE_LIMIT_MB })
            : t('previewOfficeOriginal')}
        </CardContent>
      </Card>
    )
  }

  return (
    <div ref={box} className="flex flex-col gap-1">
      <div className="relative h-[700px] overflow-hidden rounded-lg border">
        {!drawn && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background">
            <div className="flex flex-col items-center gap-3">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted-foreground/20 border-t-primary" />
              <p className="text-sm text-muted-foreground">{t('previewLoading')}</p>
            </div>
          </div>
        )}
        {shown && (
          // No allow-same-origin: the frame's origin is opaque. Nor
          // allow-popups, allow-forms or allow-top-navigation, each a way out
          <iframe
            ref={frame}
            src={IBIS_OFFICE_BOOT}
            sandbox="allow-scripts"
            title={t('preview')}
            className="block h-full w-full"
            style={{ border: 'none' }}
          />
        )}
      </div>
      <p className="text-right text-xs text-muted-foreground">
        Powered by{' '}
        <a href={IBIS_OFFICE_HOME} target="_blank" rel="noopener noreferrer" className="underline">
          ibisOffice
        </a>
      </p>
    </div>
  )
}

/**
 * Whether to run: from when the element is first scrolled to, until a `hidden`
 * ancestor takes its size away. Scrolling away keeps it running, to keep the
 * place in the document.
 */
function useShown(ref: RefObject<HTMLElement | null>): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const scrolledTo = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) setShown(true)
    })
    const hidden = new ResizeObserver(([entry]) => {
      if (!entry?.contentRect.width) setShown(false)
    })
    scrolledTo.observe(el)
    hidden.observe(el)
    return () => {
      scrolledTo.disconnect()
      hidden.disconnect()
    }
  }, [ref])
  return shown
}

function inSight(el: HTMLElement | null): boolean {
  if (!el || document.hidden) return false
  const { top, bottom } = el.getBoundingClientRect()
  return bottom > 0 && top < window.innerHeight
}

class TooLarge extends Error {}

/** The resource's file, read up to the limit, and the name ibisOffice is given for it. */
async function fetchDocument(
  resourceId: string,
  format: string,
  signal: AbortSignal
): Promise<{ name: string; bytes: ArrayBuffer }> {
  const res = await clientFetch(`/api/v1/resources/${encodeURIComponent(resourceId)}/preview`, {
    signal,
  })
  if (!res.ok || !res.body) throw new Error(`preview ${res.status}`)
  if (Number(res.headers.get('content-length')) > IBIS_OFFICE_LIMIT) throw new TooLarge()

  const chunks: Uint8Array<ArrayBuffer>[] = []
  let total = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > IBIS_OFFICE_LIMIT) {
      await reader.cancel()
      throw new TooLarge()
    }
    chunks.push(value)
  }
  const bytes = await new Blob(chunks).arrayBuffer()
  return { name: documentName(format, new Uint8Array(bytes)), bytes }
}

/**
 * The name follows the bytes, not the declared format: newer files are often
 * published under an older extension, and the other way about. A file that is
 * neither a ZIP nor a compound document is not passed on.
 */
function documentName(format: string, head: Uint8Array): string {
  const kind = format.toLowerCase().replace(/x$/, '')
  if (hasSignature(head, ZIP_SIGNATURE)) return `document.${kind}x`
  if (hasSignature(head, COMPOUND_FILE_SIGNATURE)) return `document.${kind}`
  throw new Error('neither a ZIP nor a compound document')
}

async function fetchWasm(signal: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(IBIS_OFFICE_WASM, { signal })
  if (!res.ok) throw new Error(`ibisOffice ${res.status}`)
  return res.arrayBuffer()
}
