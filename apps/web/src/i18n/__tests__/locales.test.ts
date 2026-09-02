import { describe, it, expect } from 'vitest'
import { resolveLocalizedText } from '../locales'

describe('resolveLocalizedText', () => {
  it('should return a plain string for any locale', () => {
    expect(resolveLocalizedText('KUKAN', 'ja')).toBe('KUKAN')
    expect(resolveLocalizedText('KUKAN', 'en')).toBe('KUKAN')
  })

  it('should pick the entry matching the locale', () => {
    const text = { ja: '利用規約', en: 'Terms of Use' }
    expect(resolveLocalizedText(text, 'ja')).toBe('利用規約')
    expect(resolveLocalizedText(text, 'en')).toBe('Terms of Use')
  })

  it('should fall back to the default locale when the entry is missing', () => {
    expect(resolveLocalizedText({ en: 'Terms of Use' }, 'ja')).toBe('Terms of Use')
  })

  it('should fall back to any defined entry when the default locale is missing', () => {
    expect(resolveLocalizedText({ ja: '利用規約' }, 'en')).toBe('利用規約')
  })

  it('should ignore unsupported locales and use the default', () => {
    expect(resolveLocalizedText({ ja: '利用規約', en: 'Terms of Use' }, 'fr')).toBe('Terms of Use')
  })

  it('should return an empty string for an empty map', () => {
    expect(resolveLocalizedText({}, 'ja')).toBe('')
  })
})
