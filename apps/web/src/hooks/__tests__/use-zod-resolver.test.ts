import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { z } from 'zod'
import { createOrganizationSchema, createResourceSchema } from '@kukan/shared'
import en from '../../../messages/en.json'
import { useZodResolver } from '../use-zod-resolver'

const options = { shouldUseNativeValidation: false, fields: {} }

async function errorsFor(schema: Parameters<typeof useZodResolver>[0], values: object) {
  const { result } = renderHook(() => useZodResolver(schema))
  return (await result.current(values, undefined, options)).errors
}

describe('useZodResolver', () => {
  it("translates a shared schema's own message", async () => {
    const errors = await errorsFor(createOrganizationSchema, { name: 'Not Valid' })
    expect(errors.name?.message).toBe(en.validation.nameFormat)
  })

  it('translates a message raised from a refinement on the whole object', async () => {
    const errors = await errorsFor(createResourceSchema, {
      packageId: '00000000-0000-4000-8000-000000000000',
      url: 'ftp://example.com/a.csv',
    })
    expect(errors.url?.message).toBe(en.validation.httpOnly)
  })

  it('leaves a message that is not a shared one as it is', async () => {
    const errors = await errorsFor(z.object({ name: z.string().min(1, 'passwordRequired') }), {
      name: '',
    })
    expect(errors.name?.message).toBe('passwordRequired')
  })
})
