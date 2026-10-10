import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { PasswordStrengthMeter } from '../password-strength-meter'

let siteMinScore: number | null = 3
vi.mock('@/hooks/use-site-settings', () => ({
  useSiteSettings: () => ({ passwordMinScore: siteMinScore, loading: false }),
}))

describe('PasswordStrengthMeter', () => {
  it('renders nothing until something is typed', () => {
    const { container } = render(<PasswordStrengthMeter password="" />)
    expect(container.innerHTML).toBe('')
  })

  it('reports a guessable password as very weak', async () => {
    render(<PasswordStrengthMeter password="passwordpassword" />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('very weak'))
  })

  it('reports a long passphrase as strong', async () => {
    render(<PasswordStrengthMeter password="harbor-lantern-quiet-42" />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('strong'))
  })

  it('keeps a password derived from the account below the accepted band', async () => {
    render(
      <PasswordStrengthMeter
        password="taro-yamada-2026-2026"
        account={{ name: 'taro-yamada', email: 'taro-yamada@example.com' }}
      />
    )
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/very weak|weak|fair/))
  })

  it('judges by the floor the deployment enforces, not the built-in default', async () => {
    // Same password, stricter server: the meter must not fall silent about a
    // password sign-up is going to refuse
    siteMinScore = 4
    const { unmount } = render(<PasswordStrengthMeter password="summer2026summer1" />)
    await waitFor(() => expect(screen.getByText(/Add another word/)).toBeInTheDocument())
    unmount()

    siteMinScore = 3
    render(<PasswordStrengthMeter password="summer2026summer1" />)
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument())
    expect(screen.queryByText(/Add another word/)).not.toBeInTheDocument()
  })

  it('says nothing while the deployment floor is unknown', async () => {
    siteMinScore = null
    const { container } = render(<PasswordStrengthMeter password="summer2026summer1" />)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(container.innerHTML).toBe('')
    siteMinScore = 3
  })

  it('asks for more characters when below the length floor', async () => {
    render(<PasswordStrengthMeter password="x7$Qm2" />)
    await waitFor(() => expect(screen.getByText('Use at least 15 characters')).toBeInTheDocument())
  })
})
