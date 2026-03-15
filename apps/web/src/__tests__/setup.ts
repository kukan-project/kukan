import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

// Mock next/link
vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode
    href: string
    [key: string]: unknown
  }) => {
    const { createElement } = require('react')
    return createElement('a', { href, ...props }, children)
  },
}))

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
  notFound: vi.fn(),
}))
