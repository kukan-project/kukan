import { describe, it, expect } from 'vitest'
import { compoundWithinBudget } from '../compound-budget'

const SECTOR = 512
const FREE = 0xffffffff
const END = 0xfffffffe
const FAT_SECTOR = 0xfffffffd

/**
 * A compound file of sectors 0 the FAT, 1 the directory, and `padding` more,
 * whose directory holds a root and streams of these sizes.
 */
function compound({
  streams,
  padding = 0,
  directoryNext = END,
  shift = 9,
  fatCount = 1,
}: {
  streams: number[]
  padding?: number
  directoryNext?: number
  shift?: number
  fatCount?: number
}): Uint8Array {
  const bytes = new Uint8Array(SECTOR * (3 + padding))
  const view = new DataView(bytes.buffer)
  view.setUint16(0x1e, shift, true)
  view.setUint32(0x2c, fatCount, true)
  view.setUint32(0x30, 1, true)
  view.setUint32(0x44, END, true)
  view.setUint32(0x4c, 0, true)
  for (let i = 1; i < 109; i++) view.setUint32(0x4c + i * 4, FREE, true)
  view.setUint32(SECTOR, FAT_SECTOR, true)
  view.setUint32(SECTOR + 4, directoryNext, true)
  const directory = SECTOR * 2
  bytes[directory + 0x42] = 5
  streams.slice(0, 3).forEach((size, i) => {
    const entry = directory + (i + 1) * 128
    bytes[entry + 0x42] = 2
    view.setUint32(entry + 0x78, size, true)
  })
  return bytes
}

describe('compoundWithinBudget', () => {
  it('passes streams that fit in the file', () => {
    expect(compoundWithinBudget(compound({ streams: [100, 200], padding: 2 }))).toBe(true)
  })

  it('refuses streams claiming more than the file, as sheets sharing a chain do', () => {
    const file = compound({ streams: [SECTOR, SECTOR, SECTOR], padding: 0 })
    expect(file.length).toBe(SECTOR * 3)
    expect(compoundWithinBudget(file)).toBe(true)
    expect(compoundWithinBudget(compound({ streams: [SECTOR * 2, SECTOR * 2] }))).toBe(false)
  })

  it('refuses a directory chain that loops', () => {
    expect(compoundWithinBudget(compound({ streams: [1], directoryNext: 1, padding: 1 }))).toBe(
      false
    )
  })

  it('refuses a chain that leaves the FAT', () => {
    expect(compoundWithinBudget(compound({ streams: [1], directoryNext: 9999 }))).toBe(false)
  })

  it('refuses sectors of a size the format does not have', () => {
    expect(compoundWithinBudget(compound({ streams: [1], shift: 7 }))).toBe(false)
  })

  it('refuses more FAT sectors than the file has', () => {
    expect(compoundWithinBudget(compound({ streams: [1], fatCount: 99 }))).toBe(false)
  })

  it('refuses a file cut short', () => {
    expect(compoundWithinBudget(compound({ streams: [1] }).subarray(0, 100))).toBe(false)
  })

  it('refuses a stream whose size has a high half, in a file of 4096-byte sectors', () => {
    const sector = 4096
    const bytes = new Uint8Array(sector * 3)
    const view = new DataView(bytes.buffer)
    view.setUint16(0x1e, 12, true)
    view.setUint32(0x2c, 1, true)
    view.setUint32(0x30, 1, true)
    view.setUint32(0x44, END, true)
    for (let i = 1; i < 109; i++) view.setUint32(0x4c + i * 4, FREE, true)
    view.setUint32(sector + 4, END, true)
    bytes[sector * 2 + 0x42] = 2
    view.setUint32(sector * 2 + 0x78, 100, true)
    expect(compoundWithinBudget(bytes)).toBe(true)

    view.setUint32(sector * 2 + 0x7c, 1, true)
    expect(compoundWithinBudget(bytes)).toBe(false)
  })
})
