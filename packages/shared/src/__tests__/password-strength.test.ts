import { describe, it, expect } from 'vitest'
import {
  evaluatePassword,
  passwordUserInputs,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_SCORE,
} from '../password-strength'

describe('evaluatePassword', () => {
  it('rejects a common password', async () => {
    const result = await evaluatePassword('passwordpassword')
    expect(result.acceptable).toBe(false)
    expect(result.score).toBeLessThan(PASSWORD_MIN_SCORE)
  })

  it('rejects a password shorter than the floor even when it scores well', async () => {
    const short = 'x7$Qm2'
    expect(short.length).toBeLessThan(PASSWORD_MIN_LENGTH)
    await expect(evaluatePassword(short)).resolves.toMatchObject({ acceptable: false })
  })

  it('refuses a passphrase past the length the endpoints accept', async () => {
    // Otherwise the meter reads "strong" and the submit fails on a length the
    // user was never told about
    const overLong = 'harbor-lantern-quiet-'.repeat(10)
    expect(overLong.length).toBeGreaterThan(PASSWORD_MAX_LENGTH)
    const result = await evaluatePassword(overLong)
    expect(result.score).toBe(4)
    expect(result.acceptable).toBe(false)
  })

  it('counts characters as a person does, not as UTF-16 units', async () => {
    // Eight emoji read as sixteen by String.length — over the floor, while the
    // password is eight characters
    const emoji = '😀'.repeat(8)
    expect(emoji.length).toBeGreaterThanOrEqual(PASSWORD_MIN_LENGTH)
    await expect(evaluatePassword(emoji)).resolves.toMatchObject({ acceptable: false })
  })

  it('scores the form the password is hashed in, not the one that was typed', async () => {
    // Full-width digits and letters normalize to the ASCII they mimic, so this
    // is stored as the hash of `password123`
    const fullWidth = 'ｐａｓｓｗｏｒｄ１２３'
    const result = await evaluatePassword(fullWidth)
    expect(result.score).toBeLessThan(PASSWORD_MIN_SCORE)
    expect(result.acceptable).toBe(false)
  })

  it('compares against account details in that same form', async () => {
    const result = await evaluatePassword('ｔａｒｏ－ｙａｍａｄａ２０２６', {
      userInputs: passwordUserInputs({ name: 'taro-yamada', email: 'taro-yamada@example.com' }),
    })
    expect(result.acceptable).toBe(false)
  })

  it('accepts a long passphrase', async () => {
    const result = await evaluatePassword('harbor-lantern-quiet-42')
    expect(result.acceptable).toBe(true)
    expect(result.score).toBeGreaterThanOrEqual(PASSWORD_MIN_SCORE)
  })

  it('rejects a password derived from the account it belongs to', async () => {
    const account = { email: 'taro-yamada@example.com', name: 'taro-yamada' }
    const derived = 'taro-yamada2026'
    const withoutContext = await evaluatePassword(derived)
    const withContext = await evaluatePassword(derived, {
      userInputs: passwordUserInputs(account),
    })

    expect(withContext.acceptable).toBe(false)
    expect(withContext.score).toBeLessThan(withoutContext.score)
  })

  it('rejects a password built from the display name', async () => {
    // The display name is the string a person is most likely to build a
    // password out of — it is on the screen beside the field
    const account = { name: 'u-8842', displayName: 'harbor-lantern-quiet' }
    const derived = 'harbor-lantern-quiet-42'
    const withoutContext = await evaluatePassword(derived)
    const withContext = await evaluatePassword(derived, {
      userInputs: passwordUserInputs(account),
    })

    expect(withoutContext.acceptable).toBe(true)
    expect(withContext.acceptable).toBe(false)
  })

  it('scores Japanese dictionary words whatever the feedback locale', async () => {
    const en = await evaluatePassword('sakuranohana', { locale: 'en' })
    const ja = await evaluatePassword('sakuranohana', { locale: 'ja' })
    expect(en.score).toBe(ja.score)
  })

  it('returns feedback in the requested locale', async () => {
    const ja = await evaluatePassword('password', { locale: 'ja' })
    const en = await evaluatePassword('password', { locale: 'en' })
    expect(ja.warning).toBeTruthy()
    expect(ja.warning).not.toBe(en.warning)
  })
})

describe('passwordUserInputs', () => {
  it('lists the email local part separately from the address', () => {
    expect(passwordUserInputs({ email: 'taro@example.com', name: 'taro-yamada' })).toEqual([
      'taro-yamada',
      'taro@example.com',
      'taro',
    ])
  })

  it('includes the display name', () => {
    expect(passwordUserInputs({ name: 'taro', displayName: '山田 太郎' })).toEqual([
      'taro',
      '山田 太郎',
    ])
  })

  it('drops missing fields', () => {
    expect(passwordUserInputs({})).toEqual([])
  })
})
