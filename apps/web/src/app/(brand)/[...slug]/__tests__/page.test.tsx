import { describe, it, expect, vi, beforeEach } from 'vitest'
import { notFound } from 'next/navigation'
import BrandPage, { generateMetadata } from '../page'

const props = (slug: string[]) => ({ params: Promise.resolve({ slug }) })

describe('BrandPage', () => {
  beforeEach(() => {
    vi.mocked(notFound).mockClear()
  })

  it('renders a registered page', async () => {
    await expect(BrandPage(props(['terms']))).resolves.toBeTruthy()
    expect(notFound).not.toHaveBeenCalled()
  })

  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'])(
    'answers not found for %s, a name every object inherits',
    async (name) => {
      await expect(BrandPage(props([name]))).rejects.toThrow('NEXT_NOT_FOUND')
      expect(notFound).toHaveBeenCalled()
      await expect(generateMetadata(props([name]))).resolves.toEqual({})
    }
  )
})
