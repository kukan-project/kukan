import { describe, it, expect } from 'vitest'
import {
  buildSummarySystemPrompt,
  buildSummaryUserContent,
  SUMMARY_GENERATION_VERSION,
  type SummaryDatasetContext,
} from '../../services/suggest/summary-prompt'
import type { ResourceMaterial } from '../../services/suggest/prompt'

const material: ResourceMaterial = {
  id: '11111111-1111-1111-1111-111111111111',
  name: '年齢別人口',
  description: null,
  format: 'CSV',
  size: 4096,
  schema: null,
  sampleRows: null,
  textHead: '令和6年の年齢別推計人口',
  fileList: null,
  fileCount: null,
}

const context: SummaryDatasetContext = {
  title: '年齢別推計人口',
  organization: '統計課',
  tags: ['人口', '統計'],
  notes: '毎年公開している推計人口です。',
}

describe('summary prompt (ADR-053)', () => {
  it('asks for a sentence count and says why — characters were not obeyed', () => {
    const prompt = buildSummarySystemPrompt('ja')
    expect(prompt).toMatch(/Write 3 to 4 sentences/)
    expect(prompt).toMatch(/search vector/)
  })

  it('forbids the claims sample rows invite', () => {
    const prompt = buildSummarySystemPrompt('ja')
    expect(prompt).toMatch(/never state a/)
    expect(prompt).toMatch(/period covered, a record count/)
  })

  it('carries the grounding rules the suggestion prompts use', () => {
    expect(buildSummarySystemPrompt('en')).toMatch(/Ground every proper noun/)
  })

  it('asks each language for its own everyday gloss', () => {
    expect(buildSummarySystemPrompt('ja')).toMatch(/お年寄り/)
    expect(buildSummarySystemPrompt('en')).not.toMatch(/お年寄り/)
    expect(buildSummarySystemPrompt('en')).toMatch(/everyday word/)
  })

  it('writes in the requested language', () => {
    expect(buildSummarySystemPrompt('ja')).toMatch(/abstract in Japanese/)
    expect(buildSummarySystemPrompt('en')).toMatch(/abstract in English/)
  })

  it('keeps the dataset apart from the file it describes', () => {
    const parsed = JSON.parse(buildSummaryUserContent(material, context))

    expect(parsed.datasetContext).toEqual(context)
    expect(parsed.resource).toMatchObject({ name: '年齢別人口', format: 'CSV' })
    // The dataset's own words must not arrive as if they came out of the file
    expect(parsed.resource.notes).toBeUndefined()
    expect(parsed.resource.title).toBeUndefined()
  })

  it('forbids writing about the material rather than the file', () => {
    // Given five rows it wrote that a column "was null in the sample rows" —
    // grounded, and meaningless to a reader who was never told there were
    // sample rows
    const prompt = buildSummarySystemPrompt('ja')
    expect(prompt).toMatch(/never about the material you were given/)
    expect(prompt).toMatch(/do not report a column as empty/)
  })

  it('pins the version that stales every stored abstract when it moves', () => {
    expect(SUMMARY_GENERATION_VERSION).toBe(3)
  })
})
