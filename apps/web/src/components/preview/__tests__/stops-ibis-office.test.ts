import { describe, it, expect } from 'vitest'
import { stopsIbisOffice } from '../../../../vendor/ibis-office/boot/stops-ibis-office.js'

describe('stopsIbisOffice', () => {
  it('takes any error before ibisOffice has drawn', () => {
    expect(stopsIbisOffice(new Error('x'), false)).toBe(true)
  })

  it('takes a trap after it has drawn', () => {
    expect(stopsIbisOffice(new WebAssembly.RuntimeError('unreachable'), true)).toBe(true)
  })

  it('takes a string the CSP refused to evaluate after it has drawn', () => {
    expect(stopsIbisOffice(new EvalError('unsafe-eval'), true)).toBe(true)
  })

  it('leaves other errors after it has drawn', () => {
    expect(stopsIbisOffice(new DOMException('denied', 'NotAllowedError'), true)).toBe(false)
    expect(stopsIbisOffice(new TypeError('x'), true)).toBe(false)
  })

  it('leaves a report that carries no error', () => {
    expect(stopsIbisOffice(null, false)).toBe(false)
    expect(stopsIbisOffice(undefined, true)).toBe(false)
  })
})
