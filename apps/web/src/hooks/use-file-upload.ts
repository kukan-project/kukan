import { useState, useRef, useCallback, useEffect } from 'react'
import { clientFetch } from '@/lib/client-api'
import { detectFormat, detectContentType } from '@kukan/shared'
import { MAX_UPLOAD_SIZE, MAX_UPLOAD_SIZE_MB } from '@kukan/shared'

export type UploadStatus = 'idle' | 'requesting' | 'uploading' | 'completing' | 'done' | 'error'

interface UseFileUploadOptions {
  resourceId: string
  /**
   * Fires once the server accepted the upload. May fire after unmount when
   * the completion round-trip was already in flight — guard owner-side
   * effects (timers, refetches) with the owner's own lifecycle.
   */
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
  const disposedRef = useRef(false)

  // Stop the upload when the owning component unmounts — e.g. dismissing a
  // drop-upload card must not leave a detached transfer that completes and
  // enqueues the pipeline. Aborting the XHR only covers the PUT phase, so
  // the flag is re-checked after every await in upload().
  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      xhrRef.current?.abort()
    }
  }, [])

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
          throw new Error(`File exceeds ${MAX_UPLOAD_SIZE_MB}MB limit`)
        }

        const format = detectFormat(file.name)
        const contentType = detectContentType(file.name)

        // Step 1: Get presigned upload URL
        const urlRes = await clientFetch(`/api/v1/resources/${resourceId}/upload-url`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: file.name,
            contentType,
            format,
          }),
        })

        if (!urlRes.ok) {
          const body = await urlRes.json().catch(() => ({}))
          throw new Error(body.detail || 'Failed to get upload URL')
        }

        const { upload_url } = await urlRes.json()
        if (disposedRef.current) return

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

        if (disposedRef.current) return

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

        if (disposedRef.current) {
          // Disposed while the completion round-trip was in flight: the
          // pipeline is enqueued server-side, so the owner must still be
          // notified to refresh — skip only the local state updates
          onComplete?.()
          return
        }

        setStatus('done')
        setProgress(100)
        onComplete?.()
      } catch (err) {
        if (disposedRef.current) return
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
