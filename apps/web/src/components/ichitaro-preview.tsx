'use client'

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useTranslations } from 'next-intl'
import { cn, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kukan/ui'
import { clientFetch } from '@/lib/client-api'
import { PreviewSkeleton } from './resource-preview'
import { paintPage, PX_PER_PT, type JtdPage } from './ichitaro-paint'
import { IchitaroViewer } from './ichitaro-viewer'

interface OpenDocument {
  viewer: IchitaroViewer
  /** Each sheet's name, empty where the file names it not. */
  names: string[]
}

/**
 * An Ichitaro document drawn in the browser, a sheet at a time, with a list of
 * its sheets beside it where it has several. EZPZ File JTD (WebAssembly, in a
 * worker) lays each sheet out into pages on Ichitaro's character grid, as its
 * editor does, and the pages are painted on canvases: nothing of the file
 * reaches the page as markup. When it cannot be drawn — or takes too long to
 * lay out — `fallback` is shown instead.
 */
export function IchitaroPreview({
  resourceId,
  fallback,
}: {
  resourceId: string
  fallback: ReactNode
}) {
  const t = useTranslations('resource')
  const [doc, setDoc] = useState<OpenDocument | 'loading' | 'failed'>('loading')
  const [selected, setSelected] = useState(0)
  const [shown, setShown] = useState<{ sheet: number; pages: JtdPage[] }>()

  useEffect(() => {
    let cancelled = false
    let opened: IchitaroViewer | undefined
    async function open() {
      try {
        const res = await clientFetch(`/api/v1/resources/${encodeURIComponent(resourceId)}/preview`)
        if (!res.ok) throw new Error(`preview ${res.status}`)
        const { viewer, names } = await IchitaroViewer.open(await res.arrayBuffer())
        if (cancelled) {
          viewer.close()
          return
        }
        opened = viewer
        if (names.length === 0) throw new Error('no sheets')
        setDoc({ viewer, names })
      } catch {
        if (!cancelled) setDoc('failed')
      }
    }
    open()
    return () => {
      cancelled = true
      opened?.close()
    }
  }, [resourceId])

  useEffect(() => {
    if (typeof doc === 'string') return
    let cancelled = false
    doc.viewer.pages(selected).then(
      (pages) => {
        if (!cancelled) setShown({ sheet: selected, pages })
      },
      () => {
        if (!cancelled) setDoc('failed')
      }
    )
    return () => {
      cancelled = true
    }
  }, [doc, selected])

  if (doc === 'loading') return <PreviewSkeleton />
  if (doc === 'failed') return fallback

  const labels = doc.names.map((name, i) => name || t('previewSheet', { number: i + 1 }))
  const several = labels.length > 1

  return (
    <div className="flex flex-col gap-1">
      <div className="overflow-hidden rounded-lg border">
        {several && (
          <div className="border-b p-1 md:hidden">
            <Select value={String(selected)} onValueChange={(v) => setSelected(Number(v))}>
              <SelectTrigger aria-label={t('previewSheets')} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {labels.map((label, i) => (
                  <SelectItem key={i} value={String(i)}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="flex">
          {several && (
            <nav
              aria-label={t('previewSheets')}
              className="hidden w-36 shrink-0 border-r bg-background md:block"
            >
              <ul className="flex h-[700px] flex-col gap-1 overflow-y-auto p-1">
                {labels.map((label, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      aria-current={i === selected ? 'page' : undefined}
                      onClick={() => setSelected(i)}
                      className={cn(
                        'w-full truncate rounded-md px-2 py-1 text-left text-sm',
                        i === selected
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:bg-muted'
                      )}
                    >
                      {label}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          <div className="relative min-w-0 flex-1">
            {shown?.sheet === selected ? (
              <SheetPages key={selected} pages={shown.pages} sheetLabel={labels[selected]!} />
            ) : (
              <div className="h-[700px] bg-muted p-4">
                <PreviewSkeleton />
              </div>
            )}
            <p className="absolute top-1 right-7 rounded bg-background/80 px-1.5 text-xs text-muted-foreground">
              Powered by{' '}
              <a
                href="https://github.com/ezpzfile/ezpzfile-jtd"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                EZPZ File
              </a>
            </p>
          </div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('previewIchitaroDrawn')}</p>
    </div>
  )
}

/** A sheet's pages one under another, as wide as the frame lets them be up to their own size. */
function SheetPages({ pages, sheetLabel }: { pages: JtdPage[]; sheetLabel: string }) {
  const t = useTranslations('resource')
  const scroller = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    // In steps, so dragging the window does not repaint the pages at every pixel
    const observer = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth / 16) * 16))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={scroller} className="h-[700px] overflow-y-auto bg-muted px-4 py-6">
      {width > 0 &&
        pages.map((page, i) => (
          <PageCanvas
            key={i}
            page={page}
            scale={Math.min(PX_PER_PT, (width - 32) / page.w)}
            root={scroller}
            label={`${sheetLabel} ${t('previewIchitaroPage', { number: i + 1 })}`}
          />
        ))}
    </div>
  )
}

/**
 * A page, painted only while it is near the view: a document of many pages
 * would otherwise hold a full-size bitmap of each.
 */
function PageCanvas({
  page,
  scale,
  root,
  label,
}: {
  page: JtdPage
  scale: number
  root: RefObject<HTMLDivElement | null>
  label: string
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const observer = new IntersectionObserver(([entry]) => setNear(!!entry?.isIntersecting), {
      root: root.current,
      rootMargin: '100% 0px',
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [root])

  useEffect(() => {
    const c = canvas.current
    if (!c) return
    if (!near) {
      c.width = 0
      c.height = 0
      return
    }
    const dpr = window.devicePixelRatio || 1
    c.width = Math.round(page.w * scale * dpr)
    c.height = Math.round(page.h * scale * dpr)
    const g = c.getContext('2d')
    if (!g) return
    g.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0)
    paintPage(g, page)
  }, [near, page, scale])

  return (
    <canvas
      ref={canvas}
      role="img"
      aria-label={label}
      style={{ width: Math.round(page.w * scale), height: Math.round(page.h * scale) }}
      className="mx-auto mb-4 block bg-white shadow-sm last:mb-0"
    />
  )
}
