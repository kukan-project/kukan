/**
 * Whether a compound file (MS-CFB) claims no more than it holds (ADR-051 decision
 * 7): its streams' sizes together may not pass its own, which a file written
 * straight cannot. A first check, before the ceiling on the viewer's memory.
 */

const HEADER_DIFAT_ENTRIES = 109
const DIRECTORY_ENTRY_BYTES = 128
const STREAM = 2
/** The sector numbers above this end a chain or mark one free */
const MAX_REGULAR_SECTOR = 0xfffffffa

/** False for a file over its budget, and for one too broken to tell. */
export function compoundWithinBudget(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u16 = (at: number) => view.getUint16(at, true)
  const u32 = (at: number) => view.getUint32(at, true)
  try {
    const shift = u16(0x1e)
    if (shift !== 9 && shift !== 12) return false
    const sectorSize = 1 << shift
    const sectorCount = Math.ceil((bytes.length - sectorSize) / sectorSize)
    const at = (sector: number) => (sector + 1) * sectorSize
    const entriesPerSector = sectorSize / 4

    // The FAT's own sectors: the header's, then the DIFAT chain's
    const fatCount = u32(0x2c)
    if (fatCount > sectorCount) return false
    const fat: number[] = []
    const addFat = (n: number) => {
      if (n <= MAX_REGULAR_SECTOR && fat.length < fatCount) fat.push(n)
    }
    for (let i = 0; i < HEADER_DIFAT_ENTRIES; i++) addFat(u32(0x4c + i * 4))
    let difat = u32(0x44)
    for (let seen = 0; difat <= MAX_REGULAR_SECTOR && fat.length < fatCount; seen++) {
      if (seen >= sectorCount) return false
      for (let i = 0; i < entriesPerSector - 1; i++) addFat(u32(at(difat) + i * 4))
      difat = u32(at(difat) + sectorSize - 4)
    }
    const next = (sector: number) => {
      const fatSector = fat[Math.floor(sector / entriesPerSector)]
      if (fatSector === undefined) throw new Error('not in the FAT')
      return u32(at(fatSector) + (sector % entriesPerSector) * 4)
    }

    // Every entry of the directory, reachable from the root or not: EZPZ's walk
    // is its own, and this asks only what the file could claim
    let total = 0
    const seen = new Set<number>()
    for (let sector = u32(0x30); sector <= MAX_REGULAR_SECTOR; sector = next(sector)) {
      if (sector >= sectorCount || seen.has(sector)) return false
      seen.add(sector)
      for (let offset = 0; offset < sectorSize; offset += DIRECTORY_ENTRY_BYTES) {
        const entry = at(sector) + offset
        if (bytes[entry + 0x42] !== STREAM) continue
        // Its high half: 0 in a file of 512-byte sectors, and past any file drawn in the rest
        if (shift === 12 && u32(entry + 0x7c) !== 0) return false
        total += u32(entry + 0x78)
        if (total > bytes.length) return false
      }
    }
    return true
  } catch {
    // A read past the file, or a chain that leaves the FAT
    return false
  }
}
