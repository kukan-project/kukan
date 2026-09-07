import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LinkHealthWarning } from '../link-health-warning'

const message = 'The last link check could not reach this URL.'

describe('LinkHealthWarning', () => {
  it('opens the explanation on a tap — a touch screen has no hover to rely on', () => {
    render(<LinkHealthWarning message={message} />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: message }))
    expect(screen.getByRole('dialog')).toHaveTextContent(message)
  })
})
