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
} as const
