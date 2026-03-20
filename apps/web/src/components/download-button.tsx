'use client'

import { useCallback, useState } from 'react'
import { Download } from 'lucide-react'
import { Button } from '@kukan/ui'
import { clientFetch } from '@/lib/client-api'

interface DownloadButtonProps {
  resourceId: string
  label: string
}

export function DownloadButton({ resourceId, label }: DownloadButtonProps) {
  const [loading, setLoading] = useState(false)

  const handleClick = useCallback(async () => {
    setLoading(true)
    try {
      const res = await clientFetch(
        `/api/v1/resources/${encodeURIComponent(resourceId)}/download-url`
      )
      if (!res.ok) {
        console.error('Failed to get download URL:', res.status)
        return
      }
      const { url } = (await res.json()) as { url: string }
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      console.error('Download failed:', err)
    } finally {
      setLoading(false)
    }
  }, [resourceId])

  return (
    <Button onClick={handleClick} disabled={loading}>
      <Download className="h-4 w-4" />
      {label}
    </Button>
  )
}
