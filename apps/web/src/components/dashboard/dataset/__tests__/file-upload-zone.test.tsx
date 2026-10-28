import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { UploadStatus } from '@/hooks/use-file-upload'
import { dropFiles } from '@/__tests__/drag-drop'
import { FileUploadZone } from '../file-upload-zone'

const upload = vi.fn()
const cancel = vi.fn()
let hook: { status: UploadStatus; progress: number; error: string | null }

vi.mock('@/hooks/use-file-upload', () => ({
  useFileUpload: () => ({ ...hook, upload, cancel, reset: vi.fn() }),
}))

vi.mock('../pipeline-status-badge', () => ({
  PipelineStatusBadge: ({
    resourceId,
    initialStatus,
  }: {
    resourceId: string
    initialStatus: string
  }) => (
    <span data-testid="pipeline-status">
      {resourceId}:{initialStatus}
    </span>
  ),
}))

const csv = () => new File(['a'], 'a.csv', { type: 'text/csv' })

beforeEach(() => {
  upload.mockReset()
  cancel.mockReset()
  hook = { status: 'idle', progress: 0, error: null }
})

describe('FileUploadZone', () => {
  it('starts uploading a file it was handed', () => {
    const file = csv()
    render(<FileUploadZone resourceId="r1" initialFile={file} />)
    expect(upload).toHaveBeenCalledWith(file)
  })

  it('does not restart an upload already under way for the handed file', () => {
    hook.status = 'uploading'
    render(<FileUploadZone resourceId="r1" initialFile={csv()} />)
    expect(upload).not.toHaveBeenCalled()
  })

  it('uploads a dropped file, and highlights the zone only while dragged over', () => {
    const { container } = render(<FileUploadZone resourceId="r1" />)
    const zone = container.firstElementChild!

    fireEvent.dragOver(zone)
    expect(zone).toHaveClass('border-primary')
    fireEvent.dragLeave(zone)
    expect(zone).not.toHaveClass('border-primary')

    const file = csv()
    dropFiles(zone, [file])
    expect(upload).toHaveBeenCalledWith(file)
  })

  it('ignores a drop that carries no file', () => {
    const { container } = render(<FileUploadZone resourceId="r1" />)
    dropFiles(container.firstElementChild!, [])
    expect(upload).not.toHaveBeenCalled()
  })

  it('opens the file picker on a click, and uploads the file picked', () => {
    const { container } = render(<FileUploadZone resourceId="r1" />)
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    const click = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByText('Drag and drop a file here, or click to select'))
    expect(click).toHaveBeenCalled()

    const file = csv()
    fireEvent.change(input, {
      target: { files: [file] },
    })
    expect(upload).toHaveBeenCalledWith(file)
  })

  it('offers to cancel only while the bytes are being sent', () => {
    hook = { status: 'uploading', progress: 40, error: null }
    const { rerender } = render(<FileUploadZone resourceId="r1" />)
    expect(screen.getByText('Uploading...')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(cancel).toHaveBeenCalled()

    hook = { status: 'completing', progress: 100, error: null }
    rerender(<FileUploadZone resourceId="r1" />)
    expect(screen.getByText('Uploading...')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
  })

  it('shows the upload’s error, or a generic one, and lets another file be picked', () => {
    hook = { status: 'error', progress: 0, error: 'File too large' }
    const { container, rerender } = render(<FileUploadZone resourceId="r1" />)
    expect(screen.getByText('File too large')).toBeInTheDocument()

    hook = { status: 'error', progress: 0, error: null }
    rerender(<FileUploadZone resourceId="r1" />)
    expect(screen.getByText('Upload failed')).toBeInTheDocument()

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    const click = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByRole('button', { name: 'Select File' }))
    expect(click).toHaveBeenCalled()
  })

  it('hands over to the pipeline status once the upload is done', () => {
    hook = { status: 'done', progress: 100, error: null }
    render(<FileUploadZone resourceId="r1" />)
    expect(screen.getByText('Upload complete')).toBeInTheDocument()
    expect(screen.getByTestId('pipeline-status')).toHaveTextContent('r1:queued')
  })
})
