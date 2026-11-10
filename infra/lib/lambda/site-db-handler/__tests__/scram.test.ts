import { describe, it, expect } from 'vitest'
import { scramSha256Verifier } from '../scram.js'

describe('scramSha256Verifier', () => {
  it('makes what PostgreSQL 16 stores for the same password and salt', () => {
    // From `CREATE ROLE … PASSWORD 'pencil-48chars_ABCdef012'` with scram-sha-256
    const fromPostgres =
      'SCRAM-SHA-256$4096:eRlsxX/n0rjMBxkS/d29iQ==$cotMI1ZO/8CEJ1EBX7NYLV9Uyl5Xmt4dXRI+dBbG2tk=:U1HxdFh357ewA32uEpXLD/7pfh0JCpm+oee7FNHHN/A='
    const salt = Buffer.from('eRlsxX/n0rjMBxkS/d29iQ==', 'base64')
    expect(scramSha256Verifier('pencil-48chars_ABCdef012', salt)).toBe(fromPostgres)
  })

  it('refuses a password SASLprep would change, rather than store another verifier', () => {
    expect(() => scramSha256Verifier('ｐａｓｓ')).toThrow(/printable ASCII/)
    expect(() => scramSha256Verifier('pass word')).toThrow(/printable ASCII/)
  })

  it('salts each one afresh', () => {
    expect(scramSha256Verifier('p')).not.toBe(scramSha256Verifier('p'))
  })
})
