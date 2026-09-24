'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslations } from 'next-intl'
import type { FieldValues, Resolver } from 'react-hook-form'
import { validationMessageKey } from '@kukan/shared'

/** Every `message` in a react-hook-form error tree, passed through `translate`. */
function translateErrors<E>(node: E, translate: (message: string) => string): E {
  if (Array.isArray(node)) return node.map((child) => translateErrors(child, translate)) as E
  if (!node || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    // `ref` is the DOM element the error points at, not part of the tree
    if (key === 'ref') out[key] = value
    else if (key === 'message' && typeof value === 'string') out[key] = translate(value)
    else out[key] = translateErrors(value, translate)
  }
  return out as E
}

/**
 * `zodResolver` with the shared schemas' own messages translated.
 *
 * The schemas are the API's, so their messages are English; a message that is
 * not one of the shared `VALIDATION_MESSAGES` — a key a web schema set itself — is
 * left for the form to render as before.
 */
export function useZodResolver<T extends FieldValues>(
  schema: Parameters<typeof zodResolver>[0]
): Resolver<T> {
  const t = useTranslations('validation')
  const translate = (message: string) => {
    const key = validationMessageKey(message)
    return key ? t(key) : message
  }
  const base = zodResolver(schema) as unknown as Resolver<T>
  return async (values, context, options) => {
    const result = await base(values, context, options)
    return { ...result, errors: translateErrors(result.errors, translate) } as Awaited<
      ReturnType<Resolver<T>>
    >
  }
}
