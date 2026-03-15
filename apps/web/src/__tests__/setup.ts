import '@testing-library/jest-dom/vitest'
import { createElement } from 'react'
import { vi } from 'vitest'
import messages from '../../messages/en.json'

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
  }) => createElement('a', { href, ...props }, children),
}))

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
  notFound: vi.fn(),
}))

// Mock next-intl
type Messages = Record<string, unknown>

function resolve(obj: Messages, key: string): string | undefined {
  const val = obj[key]
  if (typeof val === 'string') return val
  return undefined
}

vi.mock('next-intl', () => {
  function useTranslations(namespace: string) {
    const ns = ((messages as Messages)[namespace] as Messages) || {}
    return (key: string) => resolve(ns, key) ?? `${namespace}.${key}`
  }
  return { useTranslations }
})
