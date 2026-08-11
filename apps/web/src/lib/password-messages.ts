import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from '@kukan/shared'

/**
 * The length rules speak through the shared `password` namespace, so a field
 * and the strength meter beside it word the same rule the same way.
 *
 * Keys rather than text: `passwordLengthSchema` is built at module scope, where
 * there is no translator, so the form carries the key through the zod message
 * and resolves it where the error is rendered.
 */
export const PASSWORD_LENGTH_KEYS = { tooShort: 'tooShort', tooLong: 'tooLong' } as const

/** The bound a length message names is the one that raised it. */
export function passwordLengthArgs(messageKey: string | undefined) {
  return {
    length: messageKey === PASSWORD_LENGTH_KEYS.tooLong ? PASSWORD_MAX_LENGTH : PASSWORD_MIN_LENGTH,
  }
}
