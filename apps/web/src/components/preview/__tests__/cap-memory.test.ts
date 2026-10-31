import { describe, it, expect } from 'vitest'
import { capMemory } from '../../../../vendor/ibis-office/boot/cap-memory.js'

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
// (export "m" (memory 0)), after the memory section
const EXPORT = [0x07, 0x05, 0x01, 0x01, 0x6d, 0x02, 0x00]

/** A module whose one memory is declared with these limits, exported as `m`. */
function moduleWith(min: number, max?: number): Uint8Array {
  const limits = max === undefined ? [0x00, min] : [0x01, min, max]
  return new Uint8Array([...HEADER, 0x05, limits.length + 1, 0x01, ...limits, ...EXPORT])
}

function memoryOf(bytes: Uint8Array): WebAssembly.Memory {
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes as BufferSource))
  return instance.exports.m as WebAssembly.Memory
}

describe('capMemory (ADR-065 decision 3)', () => {
  it('stops a memory with no declared maximum from growing past the ceiling', () => {
    // Without it, the module may grow as far as the browser lets it
    expect(() => memoryOf(moduleWith(1)).grow(3)).not.toThrow()

    const memory = memoryOf(capMemory(moduleWith(1), 2))
    memory.grow(1)
    expect(() => memory.grow(1)).toThrow(RangeError)
  })

  it('keeps a declared maximum below the ceiling, and lowers one above it', () => {
    expect(() => memoryOf(capMemory(moduleWith(1, 2), 8)).grow(2)).toThrow(RangeError)
    expect(() => memoryOf(capMemory(moduleWith(1, 8), 2)).grow(2)).toThrow(RangeError)
  })

  it('refuses a module whose minimum is above the ceiling, rather than raising it', () => {
    expect(() => capMemory(moduleWith(4), 2)).toThrow(/exceeds the ceiling/)
  })

  it('refuses a module it cannot put the ceiling on', () => {
    expect(() => capMemory(new Uint8Array([...HEADER, ...EXPORT]), 2)).toThrow(/no memory section/)
  })
})
