import { Download } from 'lucide-react'
import { Button } from '@kukan/ui'
import { formatBytes } from '@/lib/format-utils'
import { extractFilename, resourceDownloadPath } from '@/lib/paths'

interface DownloadButtonProps {
  datasetNameOrId: string
  resourceId: string
  filename: string
  format?: string | null
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
  const href = resourceDownloadPath(datasetNameOrId, resourceId, filename)

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
