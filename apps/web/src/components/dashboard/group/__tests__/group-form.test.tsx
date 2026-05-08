import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { GroupForm } from '../group-form'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

vi.mock('@kukan/shared', async () => {
  const { z } = await import('zod')
  return {
    createGroupSchema: z.object({
      name: z
        .string()
        .min(2, 'Name must be at least 2 characters')
        .regex(/^[a-z0-9_-]+$/, 'Invalid characters'),
      title: z.string().optional(),
      description: z.string().optional(),
      imageUrl: z.string().url('Invalid URL').optional().or(z.literal('')),
    }),
  }
})

describe('GroupForm', () => {
  it('should render name field', () => {
    render(<GroupForm />)
    expect(screen.getByLabelText('URL Identifier (required)')).toBeInTheDocument()
  })

  it('should render title field', () => {
    render(<GroupForm />)
    expect(screen.getByLabelText('Title')).toBeInTheDocument()
  })

  it('should render description field', () => {
    render(<GroupForm />)
    expect(screen.getByLabelText('Description')).toBeInTheDocument()
  })

  it('should render image URL field', () => {
    render(<GroupForm />)
    expect(screen.getByLabelText('Image URL')).toBeInTheDocument()
  })

  it('should render submit button', () => {
    render(<GroupForm />)
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument()
  })

  it('should show validation error when name is empty on submit', async () => {
    render(<GroupForm />)
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => {
      // Zod min(2) error shows when name is empty
      expect(screen.getByText(/must be at least 2 characters/i)).toBeInTheDocument()
    })
  })

  it('should render name help text', () => {
    render(<GroupForm />)
    expect(screen.getByText(/Used in URLs\. Alphanumeric characters/)).toBeInTheDocument()
  })

  it('should show Update button in edit mode', () => {
    render(<GroupForm mode="edit" nameOrId="test-group" defaultValues={{ name: 'test-group' }} />)
    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument()
  })

  it('should disable name field in edit mode', () => {
    render(<GroupForm mode="edit" nameOrId="test-group" defaultValues={{ name: 'test-group' }} />)
    expect(screen.getByLabelText('URL Identifier (required)')).toBeDisabled()
  })

  it('should populate default values in edit mode', () => {
    render(
      <GroupForm
        mode="edit"
        nameOrId="test-group"
        defaultValues={{ name: 'test-group', title: 'Test Category', description: 'A desc' }}
      />
    )
    expect(screen.getByLabelText('Title')).toHaveValue('Test Category')
    expect(screen.getByLabelText('Description')).toHaveValue('A desc')
  })
})
