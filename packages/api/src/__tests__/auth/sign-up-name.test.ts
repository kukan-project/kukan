import { describe, it, expect } from 'vitest'
import { enforceSignUpName } from '../../auth/sign-up-name'

describe('enforceSignUpName', () => {
  it('accepts a slug name at sign-up', () => {
    expect(() => enforceSignUpName('/sign-up/email', { name: 'taro-yamada' })).not.toThrow()
  })

  it.each([
    ['spaces', 'Evil User'],
    ['capitals', 'Sysadmin'],
    ['over 100 characters', 'a'.repeat(101)],
    ['one character', 'a'],
    ['no name', undefined],
    ['a non-string', 42],
  ])('refuses %s with a 400', (_label, name) => {
    let thrown: unknown
    try {
      enforceSignUpName('/sign-up/email', { name })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toMatchObject({ statusCode: 400, body: { code: 'INVALID_USER_NAME' } })
  })

  it('leaves every other endpoint alone', () => {
    expect(() => enforceSignUpName('/sign-in/email', { name: 'Evil User' })).not.toThrow()
    expect(() => enforceSignUpName('/update-user', { name: 'Evil User' })).not.toThrow()
  })
})
