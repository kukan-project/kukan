'use client'

import { type ReactNode, useEffect, useState } from 'react'
import { Card, CardContent } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'
import { PreviewSkeleton, PreviewError } from './resource-preview'

interface JsonPreviewProps {
  resourceId: string
}

export function JsonPreview({ resourceId }: JsonPreviewProps) {
  const t = useTranslations('resource')
  const [nodes, setNodes] = useState<ReactNode[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<'generic' | 'too-large' | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await clientFetch(`/api/v1/resources/${encodeURIComponent(resourceId)}/json`)
        if (!res.ok) {
          if (!cancelled) setError(res.status === 413 ? 'too-large' : 'generic')
          return
        }
        const parsed = await res.json()
        if (!cancelled) {
          setNodes(highlightJson(JSON.stringify(parsed, null, 2)))
        }
      } catch {
        if (!cancelled) setError('generic')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [resourceId])

  if (loading) return <PreviewSkeleton />

  if (error === 'too-large') {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t('previewJsonTooLarge')}
        </CardContent>
      </Card>
    )
  }

  if (error || !nodes) return <PreviewError />

  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="max-h-[600px] overflow-auto bg-muted/20 p-4">
        <pre className="whitespace-pre text-xs leading-relaxed">{nodes}</pre>
      </div>
    </div>
  )
}

const JSON_TOKEN_RE =
  /("(?:[^"\\]|\\.)*")\s*:|("(?:[^"\\]|\\.)*")|(true|false|null)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g

export function highlightJson(json: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let key = 0

  for (const match of json.matchAll(JSON_TOKEN_RE)) {
    const index = match.index!
    if (index > lastIndex) {
      nodes.push(json.slice(lastIndex, index))
    }

    const [full, keyToken, str, bool, num] = match
    if (keyToken) {
      nodes.push(
        <span key={key++} className="text-sky-600 dark:text-sky-400">
          {keyToken}
        </span>
      )
      nodes.push(':')
    } else if (str) {
      nodes.push(
        <span key={key++} className="text-emerald-600 dark:text-emerald-400">
          {str}
        </span>
      )
    } else if (bool) {
      nodes.push(
        <span key={key++} className="text-violet-600 dark:text-violet-400">
          {bool}
        </span>
      )
    } else if (num) {
      nodes.push(
        <span key={key++} className="text-amber-600 dark:text-amber-400">
          {num}
        </span>
      )
    }

    lastIndex = index + full.length
  }

  if (lastIndex < json.length) {
    nodes.push(json.slice(lastIndex))
  }

  return nodes
}
