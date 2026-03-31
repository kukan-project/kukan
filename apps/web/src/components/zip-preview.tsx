'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Card,
  CardContent,
  Skeleton,
  Badge,
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
} from '@kukan/ui'
import { useTranslations } from 'next-intl'
import { clientFetch } from '@/lib/client-api'
import { ChevronDownIcon, ChevronRightIcon, FileIcon, FolderIcon } from 'lucide-react'
import type { ZipEntry, ZipManifest } from '@kukan/shared'

interface ZipPreviewProps {
  resourceId: string
}

/* ── Tree data structure ── */

interface TreeNode {
  name: string
  /** Full path used as key */
  path: string
  entry: ZipEntry | null
  children: TreeNode[]
  /** Lookup map used during tree construction, stripped after build */
  childMap?: Map<string, TreeNode>
}

/** Build a tree from flat ZIP entries */
function buildTree(entries: ZipEntry[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', entry: null, children: [], childMap: new Map() }

  for (const entry of entries) {
    const parts = entry.path.split('/').filter(Boolean)
    let current = root
    let pathSoFar = ''

    for (let i = 0; i < parts.length; i++) {
      pathSoFar += parts[i] + (i < parts.length - 1 || entry.isDirectory ? '/' : '')
      let child = current.childMap!.get(parts[i])
      if (!child) {
        child = { name: parts[i], path: pathSoFar, entry: null, children: [], childMap: new Map() }
        current.childMap!.set(parts[i], child)
        current.children.push(child)
      }
      current = child
    }
    current.entry = entry
  }

  // Sort: directories first, then alphabetical; clean up childMap
  const sortAndClean = (node: TreeNode) => {
    node.children.sort((a, b) => {
      const aDir = a.children.length > 0 || a.entry?.isDirectory ? 0 : 1
      const bDir = b.children.length > 0 || b.entry?.isDirectory ? 0 : 1
      if (aDir !== bDir) return aDir - bDir
      return a.name.localeCompare(b.name)
    })
    delete node.childMap
    for (const child of node.children) sortAndClean(child)
  }
  sortAndClean(root)

  return root.children
}

/** Collect all directory paths for initial expansion of first level */
function getFirstLevelPaths(nodes: TreeNode[]): Set<string> {
  const paths = new Set<string>()
  for (const node of nodes) {
    if (node.children.length > 0) paths.add(node.path)
  }
  return paths
}

/* ── Component ── */

export function ZipPreview({ resourceId }: ZipPreviewProps) {
  const t = useTranslations('resource')
  const [manifest, setManifest] = useState<ZipManifest | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        // Step 1: Get preview URL
        const urlRes = await clientFetch(
          `/api/v1/resources/${encodeURIComponent(resourceId)}/preview-url`
        )
        if (!urlRes.ok) throw new Error()
        const { url } = (await urlRes.json()) as { url: string | null }
        if (!url) throw new Error('No preview URL')

        // Step 2: Fetch manifest JSON from presigned URL
        const manifestRes = await fetch(url)
        if (!manifestRes.ok) throw new Error()
        const data = (await manifestRes.json()) as ZipManifest
        if (!cancelled) setManifest(data)
      } catch {
        if (!cancelled) setError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [resourceId])

  const tree = useMemo(() => (manifest ? buildTree(manifest.entries) : []), [manifest])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set<string>())

  // Expand first level when tree is ready
  useEffect(() => {
    if (tree.length > 0) {
      setExpanded(getFirstLevelPaths(tree))
    }
  }, [tree])

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  if (loading) {
    return (
      <Card>
        <CardContent className="space-y-3 p-4">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (error || !manifest) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t('previewNoData')}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Badge variant="default">{t('previewSourceFileList')}</Badge>
      </div>
      <div className="overflow-hidden rounded-lg border">
        <div className="max-h-[600px] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('zipFilePath')}</TableHead>
                <TableHead className="w-28 text-right">{t('zipFileSize')}</TableHead>
                <TableHead className="w-28 text-right">{t('zipCompressedSize')}</TableHead>
                <TableHead className="w-40 text-right">{t('zipLastModified')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TreeRows nodes={tree} depth={0} expanded={expanded} onToggle={toggle} />
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={4} className="text-xs">
                  {t('zipTotalFiles', { count: manifest.totalFiles })}
                  {' · '}
                  {t('zipTotalSize', { size: formatBytes(manifest.totalSize) })}
                  {manifest.truncated && (
                    <span className="ml-2 text-muted-foreground">{t('zipTruncated')}</span>
                  )}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      </div>
    </div>
  )
}

/* ── Tree row rendering ── */

function TreeRows({
  nodes,
  depth,
  expanded,
  onToggle,
}: {
  nodes: TreeNode[]
  depth: number
  expanded: Set<string>
  onToggle: (path: string) => void
}) {
  return (
    <>
      {nodes.map((node) => (
        <TreeNodeRow
          key={node.path}
          node={node}
          depth={depth}
          expanded={expanded}
          onToggle={onToggle}
        />
      ))}
    </>
  )
}

function TreeNodeRow({
  node,
  depth,
  expanded,
  onToggle,
}: {
  node: TreeNode
  depth: number
  expanded: Set<string>
  onToggle: (path: string) => void
}) {
  const isDir = node.children.length > 0 || !!node.entry?.isDirectory
  const isOpen = expanded.has(node.path)
  const { entry } = node

  return (
    <>
      <TableRow
        className={isDir ? 'cursor-pointer hover:bg-muted/50' : undefined}
        onClick={isDir ? () => onToggle(node.path) : undefined}
      >
        <TableCell className="font-mono text-xs">
          <span
            className="inline-flex items-center gap-1"
            style={{ paddingLeft: `${depth * 1.25}rem` }}
          >
            {isDir ? (
              <>
                {isOpen ? (
                  <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <FolderIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              </>
            ) : (
              <>
                <span className="inline-block w-3.5" />
                <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              </>
            )}
            {node.name}
          </span>
        </TableCell>
        <TableCell className="text-right text-xs tabular-nums">
          {isDir ? '—' : entry ? formatBytes(entry.size) : '—'}
        </TableCell>
        <TableCell className="text-right text-xs tabular-nums">
          {isDir ? '—' : entry ? formatBytes(entry.compressedSize) : '—'}
        </TableCell>
        <TableCell className="text-right text-xs tabular-nums">
          {entry ? formatDate(entry.lastModified) : '—'}
        </TableCell>
      </TableRow>
      {isDir && isOpen && (
        <TreeRows nodes={node.children} depth={depth + 1} expanded={expanded} onToggle={onToggle} />
      )}
    </>
  )
}

const LOG_1024 = Math.log(1024)

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / LOG_1024)
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/** Format a timezone-free ISO string (e.g. "2024-03-21T18:22:00") for display */
function formatDate(localIso: string): string {
  return localIso.replace('T', ' ')
}
