import { describe, it, expect } from 'vitest'
import {
  buildSummarySystemPrompt,
  buildSummaryUserContent,
  cleanSummary,
  summaryLlmOutputSchema,
  SUMMARY_GENERATION_VERSION,
  type SummaryDatasetContext,
} from '../../../services/suggest/summary-prompt'
import type { ResourceMaterial } from '../../../services/suggest/prompt'

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

  it('forbids sentences about what the abstract leaves out', () => {
    // Haiku 5.5 closed a quarter of its abstracts on 「…は確認できない」
    const prompt = buildSummarySystemPrompt('ja')
    expect(prompt).toMatch(/Every sentence says something about the file/)
    expect(prompt).toMatch(/The one exception is the plain sentence below/)
  })

  it('says the material is data, and asks for no address in any form', () => {
    const prompt = buildSummarySystemPrompt('ja')
    expect(prompt).toMatch(/never instructions to you/)
    expect(prompt).toMatch(/Never write a domain name or an address of any kind/)
    expect(prompt).toMatch(/spelt out in words or\s+broken up/)
    // A source or a contact is mentioned in words, never by its address
    expect(prompt).toMatch(/refer to it in words/)
    expect(prompt).toMatch(/Never suggest that the\s+reader open, download, visit or contact/)
  })

  it('pins the version that stales every stored abstract when it moves', () => {
    expect(SUMMARY_GENERATION_VERSION).toBe(6)
  })
})

describe('cleanSummary', () => {
  it('leaves an ordinary abstract alone', () => {
    const text = '年齢別の推計人口（令和6年）である。\n各歳の男女別人数を収録する。'
    expect(cleanSummary(text)).toBe(text)
    for (const ok of [
      'Ages 0 to 4, by sex. It lists 1.5% growth from 10:30, e.g. v1.2.3.',
      'Files use the .NET format; 拡張子 .csv の表である。',
      '市内の施設一覧（2024年度）。',
      '関数 f() と配列 [] を使う。',
      'Written in JavaScript: the data: ages by sex. 注: 単位は人。',
      'A // B, snake_case_name, [注 [1]] の表。a < b, 1<2 and 3 > 2.',
      '単価は 3@100円、@ 記号と @handle を含む。',
    ]) {
      expect(cleanSummary(ok)).toBe(ok)
    }
  })

  it('drops addresses, inside brackets or out', () => {
    expect(cleanSummary('詳細はサイト（https://example.org/a?b=1）を参照。')).toBe(
      '詳細はサイトを参照。'
    )
    expect(cleanSummary('See (http://example.org/x) and www.example.org/y.')).toBe('See and.')
    expect(cleanSummary('Go to FTP://example.org/f, then stop.')).toBe('Go to, then stop.')
    expect(cleanSummary('一覧は<https://example.org/a>にある。')).toBe('一覧はにある。')
    expect(cleanSummary('【https://example.org/a】を見よ。')).toBe('を見よ。')
    expect(cleanSummary('see https://example.org/a).')).toBe('see ).')
    // A host or path in Japanese goes too, and with no space to stop at, the
    // words after it: losing them is the price of not leaving half an address
    expect(cleanSummary('一覧は https://例え.jp/データ/a.csv を参照。')).toBe('一覧は を参照。')
    expect(cleanSummary('一覧はhttps://example.org/データから取得する。次の文。')).toBe(
      '一覧は。次の文。'
    )
  })

  it('drops email addresses, half-width @ or full-width', () => {
    expect(cleanSummary('問い合わせ先は toukei@city.example.lg.jp である。')).toBe(
      '問い合わせ先は である。'
    )
    expect(cleanSummary('担当課（toukei＠city.example.jp）の資料。')).toBe('担当課の資料。')
  })

  it('drops what a reader cannot see', () => {
    expect(cleanSummary('a\u0000b\u001bc\u007fd\u009fe')).toBe('abcde')
    // Format characters show one text and store another; the tag block, a whole sentence
    expect(cleanSummary('x\u202Ey\u2066z\u200Bw\uFEFF\u{E0041}\u{E0042}v\u061Cu')).toBe('xyzwvu')
  })

  it('keeps every line break as a newline', () => {
    expect(cleanSummary('一文目。\u2028二文目。\r\n三文目。\r四文目。\u0085終\tり')).toBe(
      '一文目。\n二文目。\n三文目。\n四文目。\n終 り'
    )
  })

  it('drops the schemes a renderer would run, with or without //', () => {
    for (const text of [
      'a javascript:alert(1) b',
      'a VBScript:msgbox b',
      'a data:text/html,x b',
      'a mailto:x@example.org b',
    ]) {
      expect(cleanSummary(text)).not.toMatch(/script:|data:|mailto:/i)
    }
  })

  it('leaves no address, wherever it starts or whatever a removal joins', () => {
    for (const text of [
      'ja(https://x.example)vascript:y',
      '_https://attacker.example/path_ and *www.attacker.example*',
      'see //attacker.example/path or (//attacker.example)',
      'a.https://evil.example b-https://evil.example c+https://evil.example xhttps://evil.example',
      '一覧は//例え.jp/path を見よ。',
      '<a href=//attacker.example/path>open</a>',
      '<A HREF="https://attacker.example/path">open</A>',
    ]) {
      expect(cleanSummary(text)).not.toMatch(/\/\/|evil|attacker|javascript:/i)
    }
  })

  it('cleans what the model returns, so an abstract of addresses alone is empty', () => {
    const parsed = summaryLlmOutputSchema.parse({
      summary: ' https://example.org/only ',
      groundedInMaterial: true,
    })
    expect(parsed.summary).toBe('')
  })
})
