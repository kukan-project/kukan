import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/components/dashboard/announcement/announcement-form', () => ({
  AnnouncementForm: () => <div data-testid="announcement-form">AnnouncementForm</div>,
}))

import NewAnnouncementPage from '../page'

describe('NewAnnouncementPage', () => {
  it('should render page title', async () => {
    const jsx = await NewAnnouncementPage()
    render(jsx)
    expect(screen.getByText('Create Announcement')).toBeInTheDocument()
  })

  it('should render AnnouncementForm', async () => {
    const jsx = await NewAnnouncementPage()
    render(jsx)
    expect(screen.getByTestId('announcement-form')).toBeInTheDocument()
  })

  it('should render basic info card header', async () => {
    const jsx = await NewAnnouncementPage()
    render(jsx)
    expect(screen.getByText('Basic Information')).toBeInTheDocument()
  })
})
