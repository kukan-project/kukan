import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { COMPOUND_FILE_SIGNATURE } from '@kukan/shared'
import { readCompoundFile } from '../../../../../pipeline/interpret/document/legacy/compound-file'
import { compoundFile } from '../../../../test-helpers/legacy-office'

/**
 * The legacy Office formats and Ichitaro all read their streams through
 * `readCompoundFile`, from files anyone can upload. Whatever the bytes, it
 * must settle: read the file, or refuse it with its own error. Any other
 * throw (a RangeError from a read past a buffer, a TypeError) is a bug.
 */
const REFUSAL = /^(Not a compound file|Compound file )/

/** Every stream of the file, each read whole, as the formats' readers do. */
function readThrough(bytes: Buffer): void {
  const file = readCompoundFile(bytes)
  for (const path of file.paths()) file.stream(path)
}

function expectSettles(bytes: Buffer): void {
  try {
    readThrough(bytes)
  } catch (err) {
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(REFUSAL)
  }
}

/** Regular sectors, the mini stream, and storages two deep: the paths a reader walks. */
const STREAMS = {
  WordDocument: Buffer.alloc(6000, 0x41),
  Small: Buffer.alloc(300, 0x42),
  'Storage/Inner': Buffer.alloc(5000, 0x43),
  'Storage/Deeper/Leaf': Buffer.alloc(100, 0x44),
}
const VALID = compoundFile(STREAMS)

/** The values a sector number or a count is checked against. */
const EDGES = [0, 1, 2, 0x7fffffff, 0xfffffffa, 0xfffffffb, 0xfffffffd, 0xfffffffe, 0xffffffff]

const RUNS = { numRuns: 300 }

describe('readCompoundFile, on any bytes', () => {
  it('reads the file the mutations start from', () => {
    const file = readCompoundFile(VALID)
    expect(file.paths().sort()).toEqual(Object.keys(STREAMS).sort())
    for (const [path, data] of Object.entries(STREAMS)) expect(file.stream(path)).toEqual(data)
  })

  it('settles on random bytes behind a valid signature and sector size', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 512, maxLength: 8192 }), (raw) => {
        const bytes = Buffer.from(raw)
        bytes.write(COMPOUND_FILE_SIGNATURE, 0, 'latin1')
        bytes.writeUInt16LE(9, 0x1e)
        bytes.writeUInt16LE(6, 0x20)
        expectSettles(bytes)
      }),
      RUNS
    )
  })

  it('settles on a valid file with any of its bytes changed', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            // Half in the header, where every structure starts; the rest is mostly stream data
            at: fc.oneof(fc.nat({ max: 511 }), fc.nat({ max: VALID.length - 1 })),
            value: fc.nat({ max: 255 }),
          }),
          { minLength: 1, maxLength: 16 }
        ),
        (changes) => {
          const bytes = Buffer.from(VALID)
          for (const { at, value } of changes) bytes[at] = value
          expectSettles(bytes)
        }
      ),
      RUNS
    )
  })

  it('settles on a valid file with its 32-bit fields set to edge values, and cut short', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            field: fc.nat({ max: VALID.length / 4 - 1 }),
            value: fc.oneof(fc.constantFrom(...EDGES), fc.nat({ max: 0xffffffff })),
          }),
          { minLength: 1, maxLength: 8 }
        ),
        fc.option(fc.nat({ max: VALID.length }), { nil: undefined }),
        (changes, cut) => {
          const bytes = Buffer.from(VALID)
          for (const { field, value } of changes) bytes.writeUInt32LE(value, field * 4)
          expectSettles(cut === undefined ? bytes : bytes.subarray(0, cut))
        }
      ),
      RUNS
    )
  })
})
