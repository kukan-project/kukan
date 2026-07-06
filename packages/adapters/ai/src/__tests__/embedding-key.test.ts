import { describe, it, expect } from 'vitest'
import { embeddingKey } from '../adapter'

describe('embeddingKey', () => {
  it('pins the stored key format (model@dimensions)', () => {
    expect(embeddingKey({ model: 'bge-m3', dimensions: 1024 })).toBe('bge-m3@1024')
  })
})
