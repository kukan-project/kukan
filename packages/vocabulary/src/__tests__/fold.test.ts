import { describe, it, expect } from 'vitest'
import { checkDigit, fold, hasValidCheckDigit } from '../fold'

describe('checkDigit', () => {
  it('gives the last digit of codes built by mod 11 over weights 6 to 2', () => {
    expect(checkDigit('mod11-weights-6-2', '13000')).toBe('1')
    expect(checkDigit('mod11-weights-6-2', '01100')).toBe('2')
    expect(hasValidCheckDigit('mod11-weights-6-2', '401307')).toBe(true)
    expect(hasValidCheckDigit('mod11-weights-6-2', '401308')).toBe(false)
  })

  it('refuses a body that is not five digits', () => {
    expect(checkDigit('mod11-weights-6-2', '1300')).toBeNull()
    expect(checkDigit('mod11-weights-6-2', 'A3000')).toBeNull()
  })
})

describe('fold', () => {
  it('reads full-width digits as digits', () => {
    expect(fold(['nfkc'], ' ０１１００２ ')).toBe('011002')
  })

  it('folds only by the foldings a scheme picks', () => {
    expect(fold(['nfkc', 'strip-spaces', 'small-kana-ke'], ' 竜ヶ崎市 ')).toBe('竜ケ崎市')
    expect(fold(['nfkc', 'strip-spaces'], '札幌市　中央区')).toBe('札幌市中央区')
    // A scheme of names with spaces keeps them
    expect(fold(['lowercase'], 'North  Harbor')).toBe('north  harbor')
    expect(fold(['uppercase'], 'kt101')).toBe('KT101')
  })
})
