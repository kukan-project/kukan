import { describe, it, expect } from 'vitest'
import { mcpInstructions } from '../../mcp/instructions'
import { languageOfTitles } from '../../services/catalog-language'

describe('languageOfTitles', () => {
  it('tells Japanese by the kana some titles hold, though many are kanji alone', () => {
    expect(
      languageOfTitles(['東京都下水道事業年報', '住宅火災・放火火災の実態', '教育人口等推計報告書'])
    ).toBe('Japanese')
  })

  it('tells Korean by hangul', () => {
    expect(languageOfTitles(['서울시 인구 통계', '교통사고 현황'])).toBe('Korean')
  })

  it('names none for kanji alone, which Japanese and Chinese write the same', () => {
    expect(languageOfTitles(['人口統計', '交通事故統計', '東京都下水道事業年報'])).toBeNull()
    expect(languageOfTitles(['北京市人口统计', '交通事故数据', '空气质量报告'])).toBeNull()
  })

  it('names no language that letters alone cannot tell, nor one with no titles', () => {
    expect(languageOfTitles(['Population statistics', 'Road accidents 2024'])).toBeNull()
    expect(languageOfTitles([])).toBeNull()
  })

  it('names none where the titles are too mixed to say', () => {
    expect(
      languageOfTitles(['Population statistics', 'Road accidents', 'Air quality', '人口の推移'])
    ).toBeNull()
  })
})

describe('mcpInstructions', () => {
  it("names the catalog's language where it is known, and says how to find it where not", () => {
    expect(mcpInstructions('Japanese')).toContain(
      'Search in Japanese, whatever the language of the question'
    )
    const unnamed = mcpInstructions(null)
    expect(unnamed).toContain('the language of the titles the searches return')
    expect(unnamed).not.toContain('Japanese')
  })
})
