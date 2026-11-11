import { describe, it, expect } from 'vitest'
import { failedReply } from '../../heavy/protocol'

describe('failedReply', () => {
  it.each([
    ['a string past its limit', new RangeError('Invalid string length')],
    ['a buffer it could not allocate', new RangeError('Array buffer allocation failed')],
    [
      'a decoded string past its limit',
      Object.assign(new Error('Cannot create a string longer than 0x1fffffe8 characters'), {
        code: 'ERR_STRING_TOO_LONG',
      }),
    ],
  ])('says the request was too large for %s', (_, err) => {
    expect(failedReply(err)).toEqual({ ok: false, message: err.message, tooLarge: true })
  })

  it.each([
    ['a read past the end of a buffer', new RangeError('The value of "offset" is out of range')],
    // A negative length from a broken header gives these too: damaged, not large
    ['an invalid array length', new RangeError('Invalid array length')],
    ['an invalid typed array length', new RangeError('Invalid typed array length: -1')],
    ['any other failure', new Error('module not found')],
  ])('passes %s on as it is', (_, err) => {
    expect(failedReply(err)).toEqual({ ok: false, message: err.message })
  })
})
