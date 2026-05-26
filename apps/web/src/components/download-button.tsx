import { Download } from 'lucide-react'
import { Button } from '@kukan/ui'
import { formatBytes } from '@/lib/format-utils'

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void
  }
}

/** Extract filename from a URL path, or return as-is if already a filename */
function extractFilename(urlOrFilename: string): string {
  try {
    const url = new URL(urlOrFilename)
    const segments = url.pathname.split('/').filter(Boolean)
    return segments[segments.length - 1] || urlOrFilename
  } catch {
    return urlOrFilename
  }
}

interface DownloadButtonProps {
  datasetNameOrId: string
  resourceId: string
  filename: string
  format?: string
  label: string
  size?: number | null
}

export function DownloadButton({
  datasetNameOrId,
  resourceId,
  filename,
  format,
  label,
  size,
}: DownloadButtonProps) {
  const displayFilename = extractFilename(filename)
  const href = `/dataset/${encodeURIComponent(datasetNameOrId)}/resource/${encodeURIComponent(resourceId)}/download/${encodeURIComponent(displayFilename)}`

  const handleClick = () => {
    if (typeof window.gtag === 'function') {
      window.gtag('event', 'file_download', {
        file_name: displayFilename,
        link_url: href,
        dataset_name: datasetNameOrId,
        resource_id: resourceId,
        format,
      })
    }
  }

  return (
    <Button asChild>
      <a href={href} onClick={handleClick}>
        <Download className="h-4 w-4" />
        {label}
        {size != null && size > 0 && (
          <span className="text-xs opacity-75">({formatBytes(size)})</span>
        )}
      </a>
    </Button>
  )
}
