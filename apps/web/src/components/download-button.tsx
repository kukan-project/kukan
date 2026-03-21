import { Download } from 'lucide-react'
import { Button } from '@kukan/ui'

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
  label: string
}

export function DownloadButton({
  datasetNameOrId,
  resourceId,
  filename,
  label,
}: DownloadButtonProps) {
  const displayFilename = extractFilename(filename)
  const href = `/dataset/${encodeURIComponent(datasetNameOrId)}/resource/${encodeURIComponent(resourceId)}/download/${encodeURIComponent(displayFilename)}`
  return (
    <Button asChild>
      <a href={href}>
        <Download className="h-4 w-4" />
        {label}
      </a>
    </Button>
  )
}
