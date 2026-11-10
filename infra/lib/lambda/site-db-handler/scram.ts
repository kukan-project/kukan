/**
 * A role's password as PostgreSQL stores it (SCRAM-SHA-256, RFC 5802 / 7677),
 * made here so the password itself never reaches the server: a failed
 * `CREATE ROLE … PASSWORD '…'` is written whole to the server's log.
 *
 * No SASLprep: the site passwords are generated from printable ASCII, which it
 * leaves as it is.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'

/** PostgreSQL's own (`scram_iterations`, default 4096). */
const ITERATIONS = 4096

export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16)): string {
  if (!/^[\x21-\x7e]+$/.test(password)) {
    throw new Error('A site password must be printable ASCII without spaces')
  }
  const salted = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256')
  const hmac = (key: Buffer, text: string) => createHmac('sha256', key).update(text).digest()
  const storedKey = createHash('sha256').update(hmac(salted, 'Client Key')).digest()
  const serverKey = hmac(salted, 'Server Key')
  return `SCRAM-SHA-256$${ITERATIONS}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
}
