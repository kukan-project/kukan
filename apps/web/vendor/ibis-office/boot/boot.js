/* global window, location, addEventListener, WebAssembly, requestAnimationFrame, URL */
/**
 * Boots ibisOffice in a sandboxed iframe (ADR-065 decision 2). The frame's
 * origin is opaque — no cookies, no storage, no reach into the parent — and
 * this page's CSP lets it load nothing but itself and the app. The parent
 * posts the document's bytes and the app's WASM once; nothing else is fetched
 * here but the app's own files.
 */
import { capMemory } from './cap-memory.js'

// A ceiling on ibisOffice's memory, in 64 KiB pages: 1 GiB
const MEMORY_MAX_PAGES = 16384

// WebRTC is the one way out the CSP does not cover, so it goes before ibisOffice
// runs. ibisOffice is imported dynamically below: a static import would be
// evaluated before this.
for (const name of [
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
  'RTCDataChannel',
  'RTCSessionDescription',
  'RTCIceCandidate',
  'RTCRtpSender',
  'RTCRtpReceiver',
  'RTCRtpTransceiver',
  'RTCDtlsTransport',
  'RTCIceTransport',
  'RTCSctpTransport',
  'RTCCertificate',
])
  delete globalThis[name]

// The hooks ibisOffice calls: upstream's page posts a download's bytes to its
// parent and opens a file picker. Here there is nothing to download (the
// resource page has its own button) and nothing to pick.
globalThis.ibisOfficeEmbedAction = () => {}
globalThis.ibisOfficePickFile = () => Promise.resolve(null)

const tell = (type) => window.parent.postMessage({ type }, '*')

let opened = false
let drawn = false
addEventListener('message', async (e) => {
  // Only a message the parent posted, once: a script here could dispatch a
  // synthetic one with its source set to the parent
  if (window.parent === window || !e.isTrusted || e.source !== window.parent) return
  if (e.data?.type !== 'open' || opened) return
  opened = true
  try {
    const module = await WebAssembly.compile(
      capMemory(new Uint8Array(e.data.wasm), MEMORY_MAX_PAGES)
    )
    const { default: init, run, set_embed_options } = await import('./pkg/ibis_office_app.js')
    await init({ module_or_path: module })
    // Read-only, no menu bar or toolbar, no close or download buttons
    set_embed_options(false, false, true, false, false)
    // Icons load from <base>/assets/icons/, which must be absolute
    run(
      new URL('.', location.href).href.replace(/\/$/, ''),
      e.data.name,
      new Uint8Array(e.data.bytes)
    )
    // After the frame that follows the first one drawn
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        drawn = true
        tell('ready')
      })
    )
  } catch {
    tell('error')
  }
})
// Out of memory under the ceiling, or a panic, traps: ibisOffice has stopped, and
// the parent points to the extracted text. Once it has drawn, anything else is
// not the end of it: copying rejects here, as the frame may not use the clipboard.
// A ResizeObserver loop's report carries no error at all.
const stopped = (err) => {
  if (err != null && (!drawn || err instanceof WebAssembly.RuntimeError)) tell('error')
}
addEventListener('error', (e) => stopped(e.error))
addEventListener('unhandledrejection', (e) => stopped(e.reason))

tell('boot')
