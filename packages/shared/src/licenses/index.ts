import ckanLicenses from './ckan.json' with { type: 'json' }
import customLicenses from './custom-licenses.json' with { type: 'json' }

export interface License {
  id: string
  title: string
  url?: string
  status?: string
  domain_content?: boolean
  domain_data?: boolean
  domain_software?: boolean
  maintainer?: string
  family?: string
  is_generic?: boolean
  od_conformance?: string
  osd_conformance?: string
}

/** Open as CKAN judges it: approved by the Open Definition or the Open Source Definition. */
export function isOpenLicense(license: License): boolean {
  return license.od_conformance === 'approved' || license.osd_conformance === 'approved'
}

/** Custom licenses (e.g., Government of Japan Standard Terms of Use) */
export const CUSTOM_LICENSES: License[] = customLicenses

/** CKAN-compatible standard licenses from Open Definition */
export const CKAN_LICENSES: License[] = ckanLicenses

/** All available licenses: custom first, then CKAN standard */
export const LICENSES: License[] = [...CUSTOM_LICENSES, ...CKAN_LICENSES]

/** Look up a license by ID (case-insensitive) */
export function findLicense(id: string): License | undefined {
  const lower = id.toLowerCase()
  return LICENSES.find((l) => l.id.toLowerCase() === lower)
}

/** Translator-like interface (compatible with next-intl's t function) */
interface TranslatorLike {
  (key: string): string
  has: (key: string) => boolean
}

/**
 * Resolve a license ID to a human-readable label.
 * Lookup order: i18n translation → findLicense().title → raw ID.
 * Dots in IDs are replaced with underscores for i18n key lookup.
 */
export function resolveLicenseLabel(id: string, t: TranslatorLike): string {
  const key = id.replaceAll('.', '_')
  if (t.has(key)) return t(key)
  return findLicense(id)?.title ?? id
}
