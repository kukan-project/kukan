import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PasswordField } from '../password-field'

describe('PasswordField', () => {
  it('hides the value until the toggle is pressed', () => {
    render(<PasswordField label="New password" />)
    const input = screen.getByLabelText('New password')
    expect(input).toHaveAttribute('type', 'password')

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }))
    expect(input).toHaveAttribute('type', 'text')

    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }))
    expect(input).toHaveAttribute('type', 'password')
  })

  it('marks the input invalid and links the message when one is given', () => {
    render(<PasswordField label="New password" error="Too short" />)
    const input = screen.getByLabelText('New password')

    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Too short')).toHaveAttribute(
      'id',
      input.getAttribute('aria-describedby')
    )
  })

  it('keeps what it composes when the caller passes props of its own', () => {
    render(
      <PasswordField
        label="New password"
        error="Too short"
        className="w-64"
        id="pw"
        aria-describedby="requirements"
      />
    )
    const input = screen.getByLabelText('New password')

    // The caller's class is kept, and so is the room the toggle stands in
    expect(input.className).toContain('w-64')
    expect(input.className).toContain('pr-10')
    // `type` is not in the prop type at all, so masking cannot be turned off
    expect(input).toHaveAttribute('type', 'password')
    // Both descriptions are true at once, and the attribute takes a list
    expect(input).toHaveAttribute('aria-describedby', 'requirements pw-error')
  })

  it('leaves a description alone when there is no error to add to it', () => {
    render(<PasswordField label="New password" id="pw" aria-describedby="requirements" />)
    const input = screen.getByLabelText('New password')

    expect(input).toHaveAttribute('aria-describedby', 'requirements')
    expect(input).not.toHaveAttribute('aria-invalid', 'true')
  })

  it('leaves the toggle out of the tab order of the form value itself', () => {
    render(<PasswordField label="New password" />)
    // The toggle is a button, so it is reachable — what it must not do is submit
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveAttribute('type', 'button')
  })
})
