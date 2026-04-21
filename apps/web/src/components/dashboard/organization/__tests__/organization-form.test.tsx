import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { OrganizationForm } from '../organization-form'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

vi.mock('@kukan/shared', async () => {
  const { z } = await import('zod')
  return {
    createOrganizationSchema: z.object({
      name: z
        .string()
        .min(2, 'Name must be at least 2 characters')
        .regex(/^[a-z0-9_-]+$/, 'Invalid characters'),
      title: z.string().optional(),
      description: z.string().optional(),
      image_url: z.string().url('Invalid URL').optional().or(z.literal('')),
    }),
  }
})

describe('OrganizationForm', () => {
  it('should render name field', () => {
    render(<OrganizationForm />)
    expect(screen.getByLabelText('URL Identifier (required)')).toBeInTheDocument()
  })

  it('should render title field', () => {
    render(<OrganizationForm />)
    expect(screen.getByLabelText('Title')).toBeInTheDocument()
  })

  it('should render description field', () => {
    render(<OrganizationForm />)
    expect(screen.getByLabelText('Description')).toBeInTheDocument()
  })

  it('should render image URL field', () => {
    render(<OrganizationForm />)
    expect(screen.getByLabelText('Image URL')).toBeInTheDocument()
  })

  it('should render submit button', () => {
    render(<OrganizationForm />)
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument()
  })

  it('should show validation error when name is empty on submit', async () => {
    render(<OrganizationForm />)
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => {
      expect(screen.getByText(/must be at least 2 characters/i)).toBeInTheDocument()
    })
  })

  it('should render name help text', () => {
    render(<OrganizationForm />)
    expect(screen.getByText(/Used in URLs\. Alphanumeric characters/)).toBeInTheDocument()
  })
})
