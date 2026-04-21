import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/components/dashboard/group/group-form', () => ({
  GroupForm: () => <div data-testid="group-form">GroupForm</div>,
}))

import NewGroupPage from '../page'

describe('NewGroupPage', () => {
  it('should render page title', async () => {
    const jsx = await NewGroupPage()
    render(jsx)
    expect(screen.getByText('Create Category')).toBeInTheDocument()
  })

  it('should render GroupForm', async () => {
    const jsx = await NewGroupPage()
    render(jsx)
    expect(screen.getByTestId('group-form')).toBeInTheDocument()
  })

  it('should render basic info card header', async () => {
    const jsx = await NewGroupPage()
    render(jsx)
    expect(screen.getByText('Basic Information')).toBeInTheDocument()
  })
})
