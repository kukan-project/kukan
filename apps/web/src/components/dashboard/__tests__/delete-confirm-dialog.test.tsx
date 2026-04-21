import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DeleteConfirmDialog } from '../delete-confirm-dialog'

describe('DeleteConfirmDialog', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    title: 'Delete item?',
    description: 'This action cannot be undone.',
    onConfirm: vi.fn(),
  }

  it('should render title and description when open', () => {
    render(<DeleteConfirmDialog {...defaultProps} />)
    expect(screen.getByText('Delete item?')).toBeInTheDocument()
    expect(screen.getByText('This action cannot be undone.')).toBeInTheDocument()
  })

  it('should render Cancel and Delete buttons', () => {
    render(<DeleteConfirmDialog {...defaultProps} />)
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('should call onConfirm when delete button is clicked', () => {
    const onConfirm = vi.fn()
    render(<DeleteConfirmDialog {...defaultProps} onConfirm={onConfirm} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('should show deleting state', () => {
    render(<DeleteConfirmDialog {...defaultProps} isDeleting />)
    expect(screen.getByRole('button', { name: 'Deleting...' })).toBeDisabled()
  })

  it('should call onOpenChange with false when cancel is clicked', () => {
    const onOpenChange = vi.fn()
    render(<DeleteConfirmDialog {...defaultProps} onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
