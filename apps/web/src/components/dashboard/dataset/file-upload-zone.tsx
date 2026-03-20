'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { Button, Progress } from '@kukan/ui'
import { Upload, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useFileUpload } from '@/hooks/use-file-upload'
import { PipelineStatusBadge } from './pipeline-status-badge'

interface FileUploadZoneProps {
  resourceId: string
  initialFile?: File
  onComplete?: () => void
}

export function FileUploadZone({ resourceId, initialFile, onComplete }: FileUploadZoneProps) {
  const t = useTranslations('resource')
  const { status, progress, error, upload, cancel } = useFileUpload({
    resourceId,
    onComplete,
  })
  // Auto-start upload when initialFile is provided
  useEffect(() => {
    if (initialFile && status === 'idle') {
      upload(initialFile)
    }
  }, [initialFile])

  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFile = useCallback(
    (file: File) => {
      upload(file)
    },
    [upload]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const file = e.dataTransfer.files[0]
      if (file) handleFile(file)
    },
    [handleFile]
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
  }, [])

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) handleFile(file)
    },
    [handleFile]
  )

  // Upload complete → show pipeline status
  if (status === 'done') {
    return (
      <div className="flex items-center gap-3 rounded-lg border p-4">
        <span className="text-sm text-muted-foreground">{t('uploadComplete')}</span>
        <PipelineStatusBadge resourceId={resourceId} initialStatus="queued" />
      </div>
    )
  }

  // Uploading in progress
  if (status === 'requesting' || status === 'uploading' || status === 'completing') {
    return (
      <div className="flex flex-col gap-3 rounded-lg border p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm">{t('uploading')}</span>
          {status === 'uploading' && (
            <Button variant="ghost" size="sm" onClick={cancel}>
              <X className="mr-1 size-3" />
              {t('cancelUpload')}
            </Button>
          )}
        </div>
        <Progress value={progress} className="h-2" />
      </div>
    )
  }

  // Error state
  if (status === 'error') {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-destructive/50 p-4">
        <span className="text-sm text-destructive">{error || t('uploadFailed')}</span>
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => inputRef.current?.click()}
        >
          {t('selectFile')}
        </Button>
        <input ref={inputRef} type="file" className="hidden" onChange={handleInputChange} />
      </div>
    )
  }

  // Idle → drop zone
  return (
    <div
      className={`flex cursor-pointer flex-col items-center gap-3 rounded-lg border-2 border-dashed p-8 transition-colors ${
        dragOver ? 'border-primary bg-primary/5' : 'border-muted-foreground/25'
      }`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onClick={() => inputRef.current?.click()}
    >
      <Upload className="size-8 text-muted-foreground" />
      <span className="text-sm text-muted-foreground">{t('dropFileHere')}</span>
      <input ref={inputRef} type="file" className="hidden" onChange={handleInputChange} />
    </div>
  )
}
