import { useState, useRef, useCallback } from 'react'
import { clientFetch } from '@/lib/client-api'
import { detectFormat, detectContentType } from '@kukan/shared'
import { MAX_UPLOAD_SIZE } from '@/config'

export type UploadStatus = 'idle' | 'requesting' | 'uploading' | 'completing' | 'done' | 'error'

interface UseFileUploadOptions {
  resourceId: string
  onComplete?: () => void
}

interface UseFileUploadResult {
  status: UploadStatus
  progress: number
  error: string | null
  upload: (file: File) => void
  cancel: () => void
  reset: () => void
}

/**
 * Handles 3-step presigned URL upload flow:
 * 1. POST /upload-url → get presigned URL
 * 2. PUT presigned URL (XMLHttpRequest for progress)
 * 3. POST /upload-complete → enqueue pipeline
 */
export function useFileUpload({
  resourceId,
  onComplete,
}: UseFileUploadOptions): UseFileUploadResult {
  const [status, setStatus] = useState<UploadStatus>('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const xhrRef = useRef<XMLHttpRequest | null>(null)

  const cancel = useCallback(() => {
    if (xhrRef.current) {
      xhrRef.current.abort()
      xhrRef.current = null
    }
    setStatus('idle')
    setProgress(0)
    setError(null)
  }, [])

  const reset = useCallback(() => {
    setStatus('idle')
    setProgress(0)
    setError(null)
  }, [])

  const upload = useCallback(
    async (file: File) => {
      try {
        setStatus('requesting')
        setProgress(0)
        setError(null)

        if (file.size > MAX_UPLOAD_SIZE) {
          throw new Error(`File exceeds ${MAX_UPLOAD_SIZE / 1024 / 1024}MB limit`)
        }

        const format = detectFormat(file.name)
        const contentType = detectContentType(file.name)

        // Step 1: Get presigned upload URL
        const urlRes = await clientFetch(`/api/v1/resources/${resourceId}/upload-url`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: file.name,
            content_type: contentType,
            format,
          }),
        })

        if (!urlRes.ok) {
          const body = await urlRes.json().catch(() => ({}))
          throw new Error(body.detail || 'Failed to get upload URL')
        }

        const { upload_url } = await urlRes.json()

        // Step 2: PUT file to presigned URL with progress tracking
        setStatus('uploading')
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          xhrRef.current = xhr

          xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
              setProgress(Math.round((e.loaded / e.total) * 100))
            }
          })

          xhr.addEventListener('load', () => {
            xhrRef.current = null
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve()
            } else {
              reject(new Error(`Upload failed with status ${xhr.status}`))
            }
          })

          xhr.addEventListener('error', () => {
            xhrRef.current = null
            reject(new Error('Upload failed'))
          })

          xhr.addEventListener('abort', () => {
            xhrRef.current = null
            reject(new Error('Upload cancelled'))
          })

          xhr.open('PUT', upload_url)
          xhr.setRequestHeader('Content-Type', contentType)
          xhr.send(file)
        })

        // Step 3: Notify upload complete
        setStatus('completing')
        const completeRes = await clientFetch(`/api/v1/resources/${resourceId}/upload-complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ size: file.size }),
        })

        if (!completeRes.ok) {
          throw new Error('Failed to complete upload')
        }

        setStatus('done')
        setProgress(100)
        onComplete?.()
      } catch (err) {
        if (err instanceof Error && err.message === 'Upload cancelled') {
          return
        }
        setStatus('error')
        setError(err instanceof Error ? err.message : 'Upload failed')
      }
    },
    [resourceId, onComplete]
  )

  return { status, progress, error, upload, cancel, reset }
}
