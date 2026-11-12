'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Upload, X } from 'lucide-react'
import {
  Button,
  Field,
  FieldControl,
  FieldLabel,
  Input,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
} from '@kukan/ui'
import { detectFormat } from '@kukan/shared'
import { dropZoneClass } from './drop-files-zone'

/**
 * Where a resource's bytes come from: a link, or a file to upload. Shared by
 * the add dialog and a resource's Basic tab, so the two cannot drift apart.
 *
 * A format detected from the link or the file name is handed to
 * `onFormatDetected`; the caller decides whether it replaces what is typed.
 */
export function ResourceSourceTabs({
  idPrefix,
  urlType,
  url,
  file,
  existingUpload,
  onTypeChange,
  onUrlChange,
  onFileChange,
  onFormatDetected,
}: {
  idPrefix: string
  /** 'upload', or null for a link */
  urlType: string | null
  url: string
  /** The file picked to upload, not yet sent */
  file: File | null
  /**
   * The file an upload resource already holds. Shown with a button to replace
   * it rather than an empty drop zone, which would read as having no file.
   */
  existingUpload?: string | null
  onTypeChange: (urlType: 'upload' | null) => void
  onUrlChange: (url: string) => void
  onFileChange: (file: File | null) => void
  onFormatDetected: (format: string) => void
}) {
  const t = useTranslations('resource')
  const tc = useTranslations('common')
  const [replacing, setReplacing] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  function pick(picked: File) {
    onFileChange(picked)
    const detected = detectFormat(picked.name)
    if (detected) onFormatDetected(detected)
  }

  return (
    <Tabs
      value={urlType === 'upload' ? 'upload' : 'url'}
      onValueChange={(tab) => {
        onTypeChange(tab === 'upload' ? 'upload' : null)
        onFileChange(null)
        setReplacing(false)
      }}
    >
      <TabsList variant="line">
        <TabsTrigger value="url">{t('sourceUrl')}</TabsTrigger>
        <TabsTrigger value="upload">{t('sourceUpload')}</TabsTrigger>
      </TabsList>
      <TabsContent value="url">
        <Field id={`${idPrefix}-url`}>
          <FieldLabel>URL</FieldLabel>
          <FieldControl>
            <Input
              value={url}
              onChange={(e) => {
                onUrlChange(e.target.value)
                const detected = detectFormat(e.target.value)
                if (detected) onFormatDetected(detected)
              }}
              placeholder="https://example.com/data.csv"
            />
          </FieldControl>
        </Field>
      </TabsContent>
      <TabsContent value="upload">
        {existingUpload && !replacing && !file ? (
          <div className="flex items-center gap-2 py-2">
            <Upload className="size-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">{existingUpload}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => setReplacing(true)}>
              {t('replaceFile')}
            </Button>
          </div>
        ) : (
          <div
            className={cn(dropZoneClass(dragOver || !!file), 'gap-3 p-6')}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              const dropped = e.dataTransfer.files[0]
              if (dropped) pick(dropped)
            }}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="size-6 text-muted-foreground" />
            {file ? (
              <span className="flex items-center gap-1 text-sm text-muted-foreground">
                {file.name}
                <button
                  type="button"
                  className="rounded p-0.5 hover:bg-muted"
                  aria-label={tc('cancel')}
                  onClick={(e) => {
                    e.stopPropagation()
                    onFileChange(null)
                    setReplacing(false)
                  }}
                >
                  <X className="size-3.5" />
                </button>
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">{t('dropFileHere')}</span>
            )}
            <input
              ref={inputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const picked = e.target.files?.[0]
                if (picked) pick(picked)
              }}
            />
          </div>
        )}
      </TabsContent>
    </Tabs>
  )
}
