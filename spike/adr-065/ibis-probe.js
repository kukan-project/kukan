// Runs in ibisOffice's page before main.js (ibis-server.mjs puts it there) and
// keeps what the page does in window.__ibis, for run-ibis.mjs and ibis.html:
//
//   marks     ms from navigation: wasmFetched, instantiated, ready (main.js
//             removed its status overlay, i.e. run() returned), firstFrame
//             (first WebGPU texture after ready), drawn (last frame before 300 ms of quiet)
//   frames    frames drawn (WebGPU, or the WebGL2 fallback: see backend), and the gaps between them (for scrolling)
//   longTasks main-thread tasks over 50 ms, total and longest
//   wasmMb    the WASM linear memory now; heapMb the JS heap (Chrome only)
//   external  requests that left this origin
//   errors    uncaught errors, rejections and console.error lines
//
// Nothing here changes how the app runs.
;(() => {
  const now = () => Math.round(performance.now())
  const state = {
    marks: {},
    frames: 0,
    frameGaps: [],
    longTasks: { count: 0, totalMs: 0, maxMs: 0 },
    errors: [],
    external: [],
    adapter: null,
  }
  const mark = (k) => {
    if (!(k in state.marks)) state.marks[k] = now()
  }
  let memory = null

  const keep = (r) => {
    const instance = r.instance ?? r
    memory = instance?.exports?.memory ?? memory
    mark('instantiated')
    return r
  }
  for (const name of ['instantiate', 'instantiateStreaming']) {
    const original = WebAssembly[name]
    WebAssembly[name] = function (...args) {
      mark('wasmFetched')
      return original.apply(this, args).then(keep)
    }
  }

  // Count frames the app presents: one per WebGPU texture taken, or, on the
  // WebGL2 fallback, the first draw call of each animation frame.
  let lastFrame = 0
  let settleTimer = 0
  state.backend = null
  const frame = (backend) => {
    const t = performance.now()
    state.backend ??= backend
    state.frames++
    if (lastFrame) state.frameGaps.push(Math.round(t - lastFrame))
    if (state.frameGaps.length > 2000) state.frameGaps.shift()
    lastFrame = t
    if ('ready' in state.marks) {
      mark('firstFrame')
      // Drawn: the first frame followed by 300 ms of quiet. A caret keeps
      // blinking afterwards, so "no more frames" never comes.
      clearTimeout(settleTimer)
      const at = Math.round(t)
      settleTimer = setTimeout(() => {
        if (!('drawn' in state.marks)) state.marks.drawn = at
      }, 300)
    }
  }
  if (typeof GPUCanvasContext !== 'undefined') {
    const get = GPUCanvasContext.prototype.getCurrentTexture
    GPUCanvasContext.prototype.getCurrentTexture = function (...a) {
      frame('webgpu')
      return get.apply(this, a)
    }
  }
  if (typeof WebGL2RenderingContext !== 'undefined') {
    let open = false
    for (const name of [
      'drawArrays',
      'drawElements',
      'drawArraysInstanced',
      'drawElementsInstanced',
    ]) {
      const draw = WebGL2RenderingContext.prototype[name]
      WebGL2RenderingContext.prototype[name] = function (...a) {
        if (!open) {
          open = true
          frame('webgl2')
          requestAnimationFrame(() => {
            open = false
          })
        }
        return draw.apply(this, a)
      }
    }
  }
  if (navigator.gpu) {
    const req = navigator.gpu.requestAdapter.bind(navigator.gpu)
    navigator.gpu.requestAdapter = async (...a) => {
      const adapter = await req(...a)
      const i = adapter?.info ?? {}
      state.adapter = adapter
        ? {
            vendor: i.vendor,
            architecture: i.architecture,
            description: i.description,
            fallback: adapter.isFallbackAdapter,
          }
        : null
      return adapter
    }
  }

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        state.longTasks.count++
        state.longTasks.totalMs += Math.round(e.duration)
        state.longTasks.maxMs = Math.max(state.longTasks.maxMs, Math.round(e.duration))
      }
    }).observe({ type: 'longtask', buffered: true })
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!e.name.startsWith(location.origin)) state.external.push(e.name)
      }
    }).observe({ type: 'resource', buffered: true })
  } catch {}

  const push = (kind, v) =>
    state.errors.length < 50 && state.errors.push(`${kind}: ${String(v).slice(0, 300)}`)
  addEventListener('error', (e) => push('error', e.message))
  addEventListener('unhandledrejection', (e) => push('rejection', e.reason?.message ?? e.reason))
  addEventListener('securitypolicyviolation', (e) =>
    push('csp', `${e.violatedDirective} ${e.blockedURI}`)
  )
  const ce = console.error
  console.error = (...a) => {
    push('console', a.map(String).join(' '))
    ce.apply(console, a)
  }

  document.addEventListener('DOMContentLoaded', () => {
    const status = document.getElementById('status')
    if (!status) return
    new MutationObserver(() => {
      if (!status.isConnected) mark('ready')
      else if (/(できません|not support|Could not|起動できません)/.test(status.textContent)) {
        mark('failed')
        state.failure = status.textContent.trim()
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
  })

  window.__ibis = {
    get state() {
      const res = performance.getEntriesByType('resource')
      const wasm = res.find((e) => e.name.endsWith('.wasm'))
      const doc = res.find((e) => e.name.includes('/files/'))
      return {
        ...state,
        wasmMb: memory ? Math.round(memory.buffer.byteLength / 1048576) : null,
        heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
        wasmTransferKb: wasm ? Math.round(wasm.transferSize / 1024) : null,
        wasmFromCache: wasm ? wasm.transferSize === 0 : null,
        wasmDownloadMs: wasm ? Math.round(wasm.responseEnd - wasm.startTime) : null,
        docDownloadMs: doc ? Math.round(doc.responseEnd - doc.startTime) : null,
        frameGaps: undefined,
      }
    },
    // Frame gaps since `from` frames ago, for a scroll test.
    gaps(from) {
      return state.frameGaps.slice(-from)
    },
    // For a boot page that calls run() itself (no status overlay to watch).
    mark,
    resetGaps() {
      state.frameGaps.length = 0
      lastFrame = 0
    },
  }
})()
