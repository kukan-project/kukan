/**
 * Put a ceiling on a WebAssembly module's memory (ADR-065 decision 3).
 * wasm32 declares no maximum, so the heap may grow as far as the browser lets
 * it; with one written into the memory section, an allocation past it fails
 * inside the module instead of taking the tab down. Returns new bytes; throws
 * where the ceiling cannot be put, so the module is not run without it.
 *
 * @param {Uint8Array} bytes the module's binary
 * @param {number} maxPages the ceiling, in 64 KiB pages
 * @returns {Uint8Array}
 */
export function capMemory(bytes, maxPages) {
  let at = 8
  while (at < bytes.length) {
    const id = bytes[at]
    const [size, body] = uleb(bytes, at + 1)
    if (id === 5) {
      let p = body
      const read = () => {
        const [value, next] = uleb(bytes, p)
        p = next
        return value
      }
      const count = read()
      const out = [...toUleb(count)]
      for (let i = 0; i < count; i++) {
        const flags = bytes[p++]
        if (flags & ~1) throw new Error(`unexpected memory flags ${flags}`)
        const min = read()
        const max = flags & 1 ? Math.min(read(), maxPages) : maxPages
        // A minimum above the ceiling would raise it; refuse the module instead
        if (min > max) throw new Error(`memory minimum ${min} pages exceeds the ceiling ${max}`)
        out.push(1, ...toUleb(min), ...toUleb(max))
      }
      const section = [5, ...toUleb(out.length), ...out]
      const capped = new Uint8Array(at + section.length + (bytes.length - (body + size)))
      capped.set(bytes.subarray(0, at), 0)
      capped.set(section, at)
      capped.set(bytes.subarray(body + size), at + section.length)
      return capped
    }
    at = body + size
  }
  throw new Error('no memory section')
}

/** @returns {[number, number]} the value and the offset after it */
function uleb(bytes, at) {
  let value = 0
  let shift = 0
  for (;;) {
    const b = bytes[at++]
    if (b === undefined) throw new Error('truncated module')
    value += (b & 0x7f) * 2 ** shift
    shift += 7
    if (b < 0x80) return [value, at]
  }
}

function toUleb(value) {
  const out = []
  do {
    let b = value % 128
    value = Math.floor(value / 128)
    if (value) b |= 0x80
    out.push(b)
  } while (value)
  return out
}
