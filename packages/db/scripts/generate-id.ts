import { randomBytes } from 'node:crypto'

/** Generate a random alphanumeric ID (same format as Better Auth's generateId) */
export function generateId(size = 32): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  // Bytes at or above the last whole multiple of the alphabet are skipped, so
  // the modulo does not favour the first few characters
  const limit = 256 - (256 % chars.length)
  let result = ''
  while (result.length < size) {
    for (const byte of randomBytes(size)) {
      if (byte < limit && result.length < size) result += chars[byte % chars.length]
    }
  }
  return result
}
