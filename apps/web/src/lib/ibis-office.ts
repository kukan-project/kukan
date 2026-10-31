import manifest from '../../vendor/ibis-office/manifest.json'

/**
 * Where the ibisOffice app is served (ADR-065): unpacked from the committed
 * archive by scripts/unpack-ibis-office.mjs, under a directory named by its
 * version, with KUKAN's boot page beside it.
 */
export const IBIS_OFFICE_ROOT = '/vendor/ibis-office/'
export const IBIS_OFFICE_DIR = `${IBIS_OFFICE_ROOT}${manifest.version}/`
/** The page the sandboxed frame loads */
export const IBIS_OFFICE_BOOT = `${IBIS_OFFICE_DIR}boot.html`
/** The app's WASM, which the parent fetches so that the HTTP cache keeps it */
export const IBIS_OFFICE_WASM = `${IBIS_OFFICE_DIR}pkg/ibis_office_app_bg.wasm`
/** Where its attribution links, as its NOTICE requires (AGPL-3.0 section 7(b)) */
export const IBIS_OFFICE_HOME = 'https://github.com/ibisjp/ibis-office'
