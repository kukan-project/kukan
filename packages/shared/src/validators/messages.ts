/**
 * The messages the shared schemas attach to their own refinements.
 *
 * English, because the API returns them as they are. The web runs the same
 * schemas in the browser and translates by looking a message up here.
 */
export const VALIDATION_MESSAGES = {
  nameFormat:
    'Name must contain only lowercase letters, numbers, hyphens, underscores, and periods',
  invalidUrl: 'Invalid URL',
  httpOnly: 'Only http and https URLs are allowed',
  privateAddress: 'URL points to a private or reserved address',
  keyColumnEmpty: 'A key column name cannot be empty',
  keyColumnRepeated: 'Key columns must not repeat',
  reservedKey: 'This key is reserved',
} as const

const KEY_BY_MESSAGE = new Map(
  Object.entries(VALIDATION_MESSAGES).map(([key, message]) => [
    message as string,
    key as keyof typeof VALIDATION_MESSAGES,
  ])
)

/** The key a message was attached under, when it is one of {@link VALIDATION_MESSAGES}. */
export function validationMessageKey(
  message: string
): keyof typeof VALIDATION_MESSAGES | undefined {
  return KEY_BY_MESSAGE.get(message)
}
