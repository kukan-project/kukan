import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ResourceFormFields } from '../resource-form-fields'

describe('ResourceFormFields', () => {
  const defaultProps = {
    idPrefix: 'test',
    name: '',
    onNameChange: vi.fn(),
    format: '',
    onFormatChange: vi.fn(),
    description: '',
    onDescriptionChange: vi.fn(),
    children: <div data-testid="source-section">Source</div>,
  }

  it('should render name, description, and format labels', () => {
    render(<ResourceFormFields {...defaultProps} />)
    expect(screen.getByLabelText('Name')).toBeInTheDocument()
    expect(screen.getByLabelText('Description')).toBeInTheDocument()
    expect(screen.getByLabelText('Format')).toBeInTheDocument()
  })

  it('should render children between name and description', () => {
    render(<ResourceFormFields {...defaultProps} />)
    expect(screen.getByTestId('source-section')).toBeInTheDocument()
  })

  it('should call onNameChange when name input changes', () => {
    const onNameChange = vi.fn()
    render(<ResourceFormFields {...defaultProps} onNameChange={onNameChange} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My Resource' } })
    expect(onNameChange).toHaveBeenCalledWith('My Resource')
  })

  it('should call onDescriptionChange when description changes', () => {
    const onDescriptionChange = vi.fn()
    render(<ResourceFormFields {...defaultProps} onDescriptionChange={onDescriptionChange} />)
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'A description' } })
    expect(onDescriptionChange).toHaveBeenCalledWith('A description')
  })

  it('should call onFormatChange when format input changes', () => {
    const onFormatChange = vi.fn()
    render(<ResourceFormFields {...defaultProps} onFormatChange={onFormatChange} />)
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'CSV' } })
    expect(onFormatChange).toHaveBeenCalledWith('CSV')
  })

  it('should show placeholder texts from translations', () => {
    render(<ResourceFormFields {...defaultProps} />)
    expect(screen.getByPlaceholderText('Resource name')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Resource description')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Auto-detected from URL or file')).toBeInTheDocument()
  })
})
