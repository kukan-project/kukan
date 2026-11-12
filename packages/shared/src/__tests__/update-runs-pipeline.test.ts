import { describe, it, expect } from 'vitest'
import { updateRunsPipeline } from '../update-runs-pipeline'

const linked = { url: 'https://example.com/data.csv', urlType: null, format: 'CSV' }
const uploaded = { url: 'data.csv', urlType: 'upload', format: 'CSV' }

describe('updateRunsPipeline', () => {
  it('does not run for a save that leaves the source and format alone', () => {
    // The name, description and extras are not part of how the bytes are read
    expect(updateRunsPipeline(linked, { ...linked })).toBe(false)
    expect(updateRunsPipeline(uploaded, { ...uploaded })).toBe(false)
  })

  it('runs when a linked resource points somewhere else', () => {
    expect(updateRunsPipeline(linked, { ...linked, url: 'https://example.com/v2.csv' })).toBe(true)
  })

  it('runs when the format changes, compared as the API stores it', () => {
    expect(updateRunsPipeline(linked, { ...linked, format: 'TSV' })).toBe(true)
    expect(updateRunsPipeline(uploaded, { ...uploaded, format: 'tsv' })).toBe(true)
    // Case alone is not a change: the API normalizes it on the way in
    expect(updateRunsPipeline(linked, { ...linked, format: 'csv' })).toBe(false)
  })

  it('waits for the file when a linked resource switches to an upload', () => {
    // The file arrives after the save; its promotion queues the run
    expect(updateRunsPipeline(linked, { url: 'data.csv', urlType: 'upload', format: 'TSV' })).toBe(
      false
    )
  })

  it('runs when an upload switches to a link', () => {
    expect(updateRunsPipeline(uploaded, { ...linked })).toBe(true)
  })

  it('reads a missing type as a link, the same as null', () => {
    expect(updateRunsPipeline({ ...linked, urlType: undefined }, linked)).toBe(false)
  })

  it('does not run a resource left with no source', () => {
    expect(updateRunsPipeline(linked, { url: null, urlType: null, format: 'TSV' })).toBe(false)
  })
})
