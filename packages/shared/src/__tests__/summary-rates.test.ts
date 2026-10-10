import { describe, it, expect } from 'vitest'
import { requestUsd, roundUsd, tokenRate } from '../summary'

describe('tokenRate (ADR-053)', () => {
  it('charges a geography-limited profile the premium the base rate does not carry', () => {
    // Measured against the Price List API for ap-northeast-1: every Claude
    // model quotes the geo profile at exactly 1.1× its global one
    expect(tokenRate('global.anthropic.claude-sonnet-4-6')).toMatchObject({
      inputPerMillion: 3,
      outputPerMillion: 15,
    })
    const jp = tokenRate('jp.anthropic.claude-sonnet-4-6')!
    expect(jp.inputPerMillion).toBeCloseTo(3.3, 5)
    expect(jp.outputPerMillion).toBeCloseTo(16.5, 5)
  })

  it('prices the top tier both ways', () => {
    expect(tokenRate('global.anthropic.claude-opus-4-8')).toMatchObject({
      inputPerMillion: 5,
      outputPerMillion: 25,
    })
    expect(tokenRate('jp.anthropic.claude-opus-4-8')!.outputPerMillion).toBeCloseTo(27.5, 5)
  })

  it('prices Haiku 5.5 at its lower, under-100k-token rate', () => {
    const jp = tokenRate('jp.anthropic.claude-haiku-5-5')!
    expect(jp.inputPerMillion).toBeCloseTo(0.11, 5)
    expect(jp.outputPerMillion).toBeCloseTo(0.55, 5)
  })

  it('does not price Opus 5.5 as the Opus 5 its id contains', () => {
    expect(tokenRate('global.anthropic.claude-opus-5-5')).toMatchObject({
      inputPerMillion: 4,
      outputPerMillion: 20,
    })
    expect(tokenRate('global.anthropic.claude-opus-5')).toMatchObject({
      inputPerMillion: 5,
      outputPerMillion: 25,
    })
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
    expect(roundUsd(requestUsd(rate, 10_400_000, 780_000))).toBeCloseTo(47.19, 2)
  })

  it('charges Haiku 5.5 its long-prompt band per request', () => {
    const rate = tokenRate('jp.anthropic.claude-haiku-5-5')!
    // A 50-page original: 125k input is over the 100k line, so both counts
    // take the upper band (0.55 / 2.75 with the premium)
    expect(requestUsd(rate, 125_000, 300)).toBeCloseTo((125_000 * 0.55 + 300 * 2.75) / 1e6, 8)
    // At the line it is still the lower band
    expect(requestUsd(rate, 100_000, 300)).toBeCloseTo((100_000 * 0.11 + 300 * 0.55) / 1e6, 8)
  })

  it('leaves a model without a second band on its one rate however long the prompt', () => {
    const rate = tokenRate('jp.anthropic.claude-sonnet-4-6')!
    expect(requestUsd(rate, 125_000, 300)).toBeCloseTo((125_000 * 3.3 + 300 * 16.5) / 1e6, 8)
  })
})

describe('requestUsd with cached input', () => {
  it('charges cache reads a tenth and cache writes a quarter more of the input rate', () => {
    // Haiku 4.5 on jp.*: input 1.10, read 0.11, write 1.375 — the Price List API figures
    const rate = tokenRate('jp.anthropic.claude-haiku-4-5-20251001-v1:0')!
    const usd = requestUsd(rate, 1_000_000, 0, { read: 1_000_000, write: 1_000_000 })
    expect(usd).toBeCloseTo(1.1 + 0.11 + 1.375, 8)
  })

  it('charges cached input the full input rate for a model whose share is not recorded', () => {
    // Nova's own cache rates are not in the table: overstated rather than hidden
    const rate = tokenRate('jp.amazon.nova-2-lite-v1:0')!
    expect(requestUsd(rate, 0, 0, { read: 1_000_000 })).toBeCloseTo(0.36, 8)
  })

  it('counts cached input toward the long-prompt band', () => {
    const rate = tokenRate('jp.anthropic.claude-haiku-5-5')!
    // 10k fresh + 95k read is over the 100k line: both take the upper band
    expect(requestUsd(rate, 10_000, 0, { read: 95_000 })).toBeCloseTo(
      (10_000 * 0.55 + 95_000 * 0.055) / 1e6,
      8
    )
  })
})

describe('embedding rates', () => {
  it('prices the embedding models at their Region rate, without the premium', () => {
    expect(tokenRate('amazon.titan-embed-text-v2:0')).toEqual({
      inputPerMillion: 0.029,
      outputPerMillion: 0,
    })
    expect(tokenRate('cohere.embed-v4:0')).toEqual({ inputPerMillion: 0.12, outputPerMillion: 0 })
  })
})
