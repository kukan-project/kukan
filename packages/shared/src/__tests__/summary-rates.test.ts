import { describe, it, expect } from 'vitest'
import { tokenRate, tokensToUsd } from '../summary'

describe('tokenRate (ADR-053)', () => {
  it('charges a geography-limited profile the premium the base rate does not carry', () => {
    // Measured against the Price List API for ap-northeast-1: every Claude
    // model quotes the geo profile at exactly 1.1× its global one
    expect(tokenRate('global.anthropic.claude-sonnet-4-6')).toEqual({
      inputPerMillion: 3,
      outputPerMillion: 15,
    })
    const jp = tokenRate('jp.anthropic.claude-sonnet-4-6')!
    expect(jp.inputPerMillion).toBeCloseTo(3.3, 5)
    expect(jp.outputPerMillion).toBeCloseTo(16.5, 5)
  })

  it('prices the top tier both ways', () => {
    expect(tokenRate('global.anthropic.claude-opus-4-8')).toEqual({
      inputPerMillion: 5,
      outputPerMillion: 25,
    })
    expect(tokenRate('jp.anthropic.claude-opus-4-8')!.outputPerMillion).toBeCloseTo(27.5, 5)
  })

  it('takes no premium on a model priced per Region rather than per profile', () => {
    // Amazon's own models are quoted for the Region, so a prefix changes nothing
    expect(tokenRate('jp.amazon.nova-2-lite-v1:0')).toEqual({
      inputPerMillion: 0.36,
      outputPerMillion: 3.01,
    })
  })

  it('has no price for a model nobody measured', () => {
    // Better than a figure nobody checked, when the subject is money
    expect(tokenRate('some.model-nobody-granted')).toBeNull()
    expect(tokenRate(null)).toBeNull()
  })

  it('prices both token counts, to the cent', () => {
    const rate = { inputPerMillion: 3.3, outputPerMillion: 16.5 }
    // 10.4M input and 0.78M output — ADR-053's 2,600-resource catalogue
    expect(tokensToUsd(rate, 10_400_000, 780_000)).toBeCloseTo(47.19, 2)
  })
})
