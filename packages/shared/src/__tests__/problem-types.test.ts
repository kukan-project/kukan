import { describe, it, expect } from 'vitest'
import { PROBLEM_TYPES, problemTypeOf, problemTypeUri } from '../problem-types'

describe('problem types', () => {
  it('reads back every type it writes', () => {
    for (const type of PROBLEM_TYPES) expect(problemTypeOf(problemTypeUri(type))).toBe(type)
  })

  it('names nothing for about:blank, a foreign URI, or a type it does not define', () => {
    expect(problemTypeOf('about:blank')).toBeUndefined()
    expect(problemTypeOf('https://example.com/problems/package-name-taken')).toBeUndefined()
    expect(problemTypeOf(problemTypeUri('package-name-taken') + '-x')).toBeUndefined()
    expect(problemTypeOf(undefined)).toBeUndefined()
  })
})
