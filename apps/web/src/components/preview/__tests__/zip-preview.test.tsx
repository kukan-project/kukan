import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ZipManifest } from '@kukan/shared'
import { ZipPreview } from '../zip-preview'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

import { clientFetch } from '@/lib/client-api'

const mockClientFetch = vi.mocked(clientFetch)

function serve(manifest: Partial<ZipManifest>) {
  mockClientFetch.mockResolvedValue(
    Response.json({
      totalFiles: 1,
      totalSize: 2048,
      totalCompressed: 1024,
      truncated: false,
      entries: [
        {
          path: 'a.csv',
          size: 2048,
          compressedSize: 1024,
          lastModified: '2024-01-01T00:00:00',
          isDirectory: false,
        },
      ],
      ...manifest,
    })
  )
}

/** The listing's footer line, once the manifest has loaded */
async function footer(): Promise<string | null | undefined> {
  await screen.findByText('a.csv')
  return document.querySelector('tfoot td')?.textContent
}

beforeEach(() => {
  mockClientFetch.mockReset()
})

describe('ZipPreview footer', () => {
  it('gives the file count and total size of a complete listing', async () => {
    serve({})
    render(<ZipPreview resourceId="r1" />)
    expect(await footer()).toMatch(/^1 files · Total: 2(\.0)? KB$/)
  })

  it('keeps the file count and size of a listing cut short by an earlier worker', async () => {
    serve({ totalFiles: 12_345, truncated: true })
    render(<ZipPreview resourceId="r1" />)
    expect(await footer()).toMatch(/^12345 files · Total: 2(\.0)? KBShowing first 10,000 entries$/)
  })

  it('gives the archive’s own entry count, and no total size, when the listing was cut short', async () => {
    serve({ totalFiles: 10_000, totalEntries: 2_000_000, truncated: true })
    render(<ZipPreview resourceId="r1" />)
    expect(await footer()).toBe('2,000,000 entries, folders includedShowing first 10,000 entries')
  })
})
