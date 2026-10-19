import { describe, it, expect } from 'vitest'
import { datasetJsonLd, jsonLdScript } from '../dataset-jsonld'
import type { Package } from '@/components/dataset/dataset-detail-layout'

const pkg = {
  id: 'pkg-1',
  name: 'population',
  title: 'Population',
  notes: 'Annual population by ward.',
  licenseId: 'cc-by-4.0',
  private: false,
  created: '2025-01-01T00:00:00.000Z',
  updated: '2026-01-01T00:00:00.000Z',
  tags: [{ id: 't1', name: 'statistics' }],
  groups: [{ id: 'g1', name: 'society', title: 'Society' }],
  organization: { id: 'o1', name: 'city', title: 'City Hall' },
  resources: [
    { id: 'r1', name: 'Table', format: 'CSV', url: 'https://example.com/files/pop.csv' },
    { id: 'r2', name: null, format: null, url: null },
  ],
} as unknown as Package

describe('datasetJsonLd', () => {
  const ld = datasetJsonLd(pkg, 'https://data.example.jp')

  it('describes the dataset as schema.org Dataset, with absolute URLs', () => {
    expect(ld).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'Dataset',
      name: 'Population',
      description: 'Annual population by ward.',
      url: 'https://data.example.jp/dataset/population',
      identifier: 'pkg-1',
      keywords: ['statistics'],
      dateModified: '2026-01-01T00:00:00.000Z',
      creator: {
        '@type': 'Organization',
        name: 'City Hall',
        url: 'https://data.example.jp/organization/city',
      },
    })
    expect(ld.license).toMatch(/^https:\/\//)
  })

  it('offers each file through the download route, named as the page names it', () => {
    expect(ld.distribution).toEqual([
      {
        '@type': 'DataDownload',
        name: 'Table',
        encodingFormat: 'CSV',
        contentUrl: 'https://data.example.jp/dataset/population/resource/r1/download/pop.csv',
      },
      {
        '@type': 'DataDownload',
        name: 'r2',
        contentUrl: 'https://data.example.jp/dataset/population/resource/r2/download/r2',
      },
    ])
  })

  it('falls back to the title when a dataset has no description', () => {
    expect(datasetJsonLd({ ...pkg, notes: null }, 'https://x').description).toBe('Population')
  })
})

describe('jsonLdScript', () => {
  it('escapes < so a value cannot close the script element', () => {
    expect(jsonLdScript({ name: '</script><b>' })).toBe('{"name":"\\u003c/script>\\u003cb>"}')
  })
})
