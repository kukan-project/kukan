import { describe, it, expect } from 'vitest'
import {
  LICENSES,
  CUSTOM_LICENSES,
  CKAN_LICENSES,
  findLicense,
  resolveLicenseLabel,
} from '../licenses'

describe('LICENSES', () => {
  it('should contain custom licenses followed by CKAN licenses', () => {
    expect(LICENSES.length).toBe(CUSTOM_LICENSES.length + CKAN_LICENSES.length)
    // Custom licenses come first
    for (let i = 0; i < CUSTOM_LICENSES.length; i++) {
      expect(LICENSES[i]).toBe(CUSTOM_LICENSES[i])
    }
  })

  it('should have unique IDs', () => {
    const ids = LICENSES.map((l) => l.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('should have non-empty id and title for all licenses', () => {
    for (const license of LICENSES) {
      expect(license.id).toBeTruthy()
      expect(license.title).toBeTruthy()
    }
  })
})

describe('findLicense', () => {
  it('should find a license by exact ID', () => {
    const license = findLicense('CC-BY-4.0')
    expect(license).toBeDefined()
    expect(license!.id).toBe('CC-BY-4.0')
  })

  it('should be case-insensitive', () => {
    const license = findLicense('cc-by-4.0')
    expect(license).toBeDefined()
    expect(license!.id).toBe('CC-BY-4.0')
  })

  it('should find custom licenses', () => {
    const license = findLicense('GJSTU-2.0')
    expect(license).toBeDefined()
    expect(license!.id).toBe('GJSTU-2.0')
  })

  it('should return undefined for unknown ID', () => {
    expect(findLicense('nonexistent-license')).toBeUndefined()
  })
})

describe('resolveLicenseLabel', () => {
  const mockTranslator = Object.assign((key: string) => `translated:${key}`, {
    has: (key: string) => key === 'CC-BY-4_0' || key === 'GJSTU-2_0',
  })

  it('should return i18n translation when available', () => {
    expect(resolveLicenseLabel('CC-BY-4.0', mockTranslator)).toBe('translated:CC-BY-4_0')
  })

  it('should replace dots with underscores for i18n key lookup', () => {
    expect(resolveLicenseLabel('GJSTU-2.0', mockTranslator)).toBe('translated:GJSTU-2_0')
  })

  it('should fall back to findLicense title when no translation', () => {
    const label = resolveLicenseLabel('ODbL-1.0', mockTranslator)
    const license = findLicense('ODbL-1.0')
    expect(label).toBe(license!.title)
  })

  it('should fall back to raw ID when no translation and no license found', () => {
    expect(resolveLicenseLabel('unknown-license', mockTranslator)).toBe('unknown-license')
  })
})
