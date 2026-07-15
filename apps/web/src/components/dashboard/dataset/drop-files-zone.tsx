'use client'

import { Upload } from 'lucide-react'
import { cn } from '@kukan/ui'
import { useFileDrop } from '@/hooks/use-file-drop'

/** Shared dashed drop-target frame; highlighted while a file drag is over it */
export function dropZoneClass(active: boolean) {
  return cn(
    'flex cursor-pointer flex-col items-center rounded-lg border-2 border-dashed transition-colors',
    active ? 'border-primary bg-primary/5' : 'border-muted-foreground/25'
  )
}

interface DropFilesZoneProps {
  /** Receives the dropped or picked files (never called with an empty list) */
  onFiles: (files: File[]) => void
  hint: string
  disabled?: boolean
  /** Overrides the drag highlight, for owners tracking drags over a larger region */
  active?: boolean
}

/**
 * Standalone drop/click file target: label + hidden input (keyboard
 * reachable), highlight while a file drag is over it. Drops are claimed
 * even when disabled so the browser never navigates to the file.
 */
export function DropFilesZone({
  onFiles,
  hint,
  disabled,
  active: activeOverride,
}: DropFilesZoneProps) {
  const { active, handlers } = useFileDrop({ onFiles, disabled })

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (files.length > 0) onFiles(files)
    e.target.value = ''
  }

  return (
    <label
      className={cn(
        dropZoneClass(activeOverride ?? active),
        'gap-2 p-4 focus-within:border-primary',
        disabled && 'cursor-default opacity-50'
      )}
      {...handlers}
    >
      <Upload className="size-5 text-muted-foreground" />
      <span className="text-sm text-muted-foreground">{hint}</span>
      <input
        type="file"
        multiple
        className="sr-only"
        disabled={disabled}
        onChange={handleInputChange}
      />
    </label>
  )
}
