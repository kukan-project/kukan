import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { dropFiles } from '@/__tests__/drag-drop'
import { DropFilesZone } from '../drop-files-zone'

describe('DropFilesZone', () => {
  it('should render the hint', () => {
    render(<DropFilesZone hint="Drop here" onFiles={() => {}} />)
    expect(screen.getByText('Drop here')).toBeInTheDocument()
  })

  it('should call onFiles with dropped files', () => {
    const onFiles = vi.fn()
    const { container } = render(<DropFilesZone hint="Drop here" onFiles={onFiles} />)

    dropFiles(container.firstElementChild!, [new File(['a'], 'a.csv', { type: 'text/csv' })])

    expect(onFiles).toHaveBeenCalledTimes(1)
    expect(onFiles.mock.calls[0][0].map((f: File) => f.name)).toEqual(['a.csv'])
  })

  it('should call onFiles with files picked via the input', () => {
    const onFiles = vi.fn()
    const { container } = render(<DropFilesZone hint="Drop here" onFiles={onFiles} />)

    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(['a'], 'picked.csv', { type: 'text/csv' })] },
    })

    expect(onFiles.mock.calls[0][0].map((f: File) => f.name)).toEqual(['picked.csv'])
  })

  it('should ignore drops while disabled but still suppress navigation', () => {
    const onFiles = vi.fn()
    const { container } = render(<DropFilesZone hint="Drop here" disabled onFiles={onFiles} />)

    const notPrevented = dropFiles(container.firstElementChild!, [
      new File(['a'], 'a.csv', { type: 'text/csv' }),
    ])

    expect(onFiles).not.toHaveBeenCalled()
    // Default must be prevented, or the browser would navigate to the file
    expect(notPrevented).toBe(false)
  })
})
