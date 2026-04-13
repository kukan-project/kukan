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

// Mock next/navigation — notFound() throws to mimic Next.js render interruption
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND')
  }),
}))

// Mock next-intl
type Messages = Record<string, unknown>

function resolve(obj: Messages, key: string): string | undefined {
  const val = obj[key]
  if (typeof val === 'string') return val
  return undefined
}

function makeTranslator(namespace?: string) {
  const ns = namespace ? ((messages as Messages)[namespace] as Messages) || {} : null
  const t = (key: string, params?: Record<string, unknown>) => {
    let msg: string | undefined
    if (ns) {
      // Namespaced: resolve key within namespace
      msg = resolve(ns, key)
    } else {
      // Root: resolve dot-notation like "dataset.title"
      const [first, ...rest] = key.split('.')
      const sub = (messages as Messages)[first] as Messages | undefined
      if (sub && rest.length > 0) msg = resolve(sub, rest.join('.'))
    }
    msg = msg ?? (namespace ? `${namespace}.${key}` : key)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        msg = msg.replace(`{${k}}`, String(v))
      }
    }
    return msg
  }
  t.has = (key: string) => {
    if (ns) return resolve(ns, key) !== undefined
    const [first, ...rest] = key.split('.')
    const sub = (messages as Messages)[first] as Messages | undefined
    return sub !== undefined && rest.length > 0 && resolve(sub, rest.join('.')) !== undefined
  }
  return t
}

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => makeTranslator(ns),
  useLocale: () => 'en',
}))

// Mock next-intl/server (for async server components)
vi.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => makeTranslator(ns),
}))

// Mock server-only (no-op in test environment)
vi.mock('server-only', () => ({}))
