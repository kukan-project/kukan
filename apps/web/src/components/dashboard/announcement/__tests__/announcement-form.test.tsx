import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AnnouncementForm } from '../announcement-form'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

vi.mock('@kukan/shared', async () => {
  const { z } = await import('zod')
  const announcementCategories = ['info', 'maintenance', 'release', 'important'] as const
  return {
    createAnnouncementSchema: z.object({
      title: z.string().min(1, 'Title is required').max(500),
      category: z.enum(announcementCategories).default('info'),
      link: z.union([z.url(), z.literal('')]).nullish(),
      publishedAt: z.coerce.date().nullish(),
    }),
    announcementCategories,
  }
})

describe('AnnouncementForm', () => {
  it('should render title field', () => {
    render(<AnnouncementForm />)
    expect(screen.getByLabelText('Title')).toBeInTheDocument()
  })

  it('should render category select', () => {
    render(<AnnouncementForm />)
    expect(screen.getByText('Category')).toBeInTheDocument()
  })

  it('should render link field', () => {
    render(<AnnouncementForm />)
    expect(screen.getByLabelText('Link (optional)')).toBeInTheDocument()
  })

  it('should render publish date field with help text', () => {
    render(<AnnouncementForm />)
    expect(screen.getByText(/Publish Date/)).toBeInTheDocument()
    expect(screen.getByText(/Leave empty to save as draft/)).toBeInTheDocument()
  })

  it('should render Create button in create mode', () => {
    render(<AnnouncementForm />)
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument()
  })

  it('should render Update button in edit mode', () => {
    render(
      <AnnouncementForm mode="edit" id="a1" defaultValues={{ title: 'Test', category: 'info' }} />
    )
    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument()
  })

  it('should show validation error when title is empty on submit', async () => {
    render(<AnnouncementForm />)
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => {
      expect(screen.getByText(/Title is required/i)).toBeInTheDocument()
    })
  })

  it('should populate default values in edit mode', () => {
    render(
      <AnnouncementForm
        mode="edit"
        id="a1"
        defaultValues={{ title: 'Existing Title', category: 'maintenance' }}
      />
    )
    expect(screen.getByLabelText('Title')).toHaveValue('Existing Title')
  })

  it('should show timezone after mount', async () => {
    render(<AnnouncementForm />)
    await waitFor(() => {
      expect(screen.getByText(/Publish Date/)).toHaveTextContent(/\(/)
    })
  })
})
