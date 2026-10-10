import { describe, it, expect } from 'vitest'
import type { DocumentTextBlock } from '@kukan/shared'
import { PASSAGE_MARK } from '@kukan/search-adapter'
import {
  FragmentFinder,
  WordFinder,
  cutPassages,
  passageScores,
  queryWords,
  unmark,
} from '../../../services/search/passage-text'

const { open: O, close: C } = PASSAGE_MARK

async function* blocksOf(blocks: DocumentTextBlock[], readUpTo = Infinity) {
  for (const [i, block] of blocks.entries()) {
    if (i >= readUpTo) throw new Error(`read past block ${readUpTo}`)
    yield block
  }
}

const report: DocumentTextBlock[] = [
  { loc: { page: 1 }, headings: ['はじめに'], text: '計画の目的を述べる。\n対象は区部である。' },
  { loc: { page: 2 }, text: '', unreadable: 'no-text' },
  {
    loc: { page: 3, label: 'iii' },
    headings: ['第1章', '汚泥処理'],
    text: '発生した汚泥は処理工場で処理する。\n焼却灰は資源化する。',
  },
  { loc: { page: 4 }, headings: ['第1章', '汚泥処理'], text: '処理量は年々増えている。' },
]

describe('unmark', () => {
  it('takes the marks out and says where the marked words are', () => {
    expect(unmark(`発生した${O}汚泥${C}は${O}処理${C}工場`)).toEqual({
      text: '発生した汚泥は処理工場',
      marks: [
        [4, 6],
        [7, 9],
      ],
    })
  })
})

describe('queryWords', () => {
  it('parts Japanese written without spaces at its hiragana', () => {
    expect(queryWords('汚泥の処理')).toEqual(['汚泥', '処理'])
    expect(queryWords('高齢者向けの施設はどこ？')).toEqual(['高齢者向', '施設'])
  })

  it('keeps words in Latin letters and digits whole, folded to lower case and narrow', () => {
    expect(queryWords('COVID-19 ワクチン接種')).toEqual(['covid-19', 'ワクチン接種'])
    expect(queryWords('Ａｂｃ')).toEqual(['abc'])
  })

  it('keeps a word whole when it leaves no run of two characters', () => {
    expect(queryWords('ごみの出し方')).toEqual(['ごみの出し方'])
  })

  it('takes no more words than it may', () => {
    expect(queryWords('一 二 三 四 五'.replace(/ /g, '語 '), 2)).toHaveLength(2)
  })
})

describe('cutPassages with the fragments an index cut', () => {
  it('places a fragment on the blocks it spans, widened to its lines', async () => {
    const fragment = `${O}汚泥${C}は処理工場で${O}処理${C}する。\n焼却灰は資源化する。\n${O}処理${C}量`
    const [passage, ...rest] = await cutPassages(
      blocksOf(report),
      new FragmentFinder([{ fragment, chunkIndex: 0 }]),
      200
    )
    expect(rest).toEqual([])
    // Widened back to the start of its line, and on to the end of the last
    expect(passage!.text).toBe(
      '発生した汚泥は処理工場で処理する。\n焼却灰は資源化する。\n処理量は年々増えている。'
    )
    expect(passage!.words).toEqual(['汚泥', '処理', '処理'])
    // The empty page is not a block of the text: it holds none of it
    expect(passage!.blocks.map((b) => [b.index, b.loc.page])).toEqual([
      [2, 3],
      [3, 4],
    ])
    expect(passage!.blocks[0]!.headings).toEqual(['第1章', '汚泥処理'])
  })

  it('does not widen past the limit', async () => {
    const long = 'あ'.repeat(50) + '汚泥' + 'い'.repeat(50)
    const [passage] = await cutPassages(
      blocksOf([{ loc: { page: 1 }, text: long }]),
      new FragmentFinder([{ fragment: `${O}汚泥${C}いい`, chunkIndex: 0 }]),
      10
    )
    expect(passage!.text).toBe('汚泥いい')
  })

  it('finds a fragment late in a long text, holding only a window of it', async () => {
    const blocks: DocumentTextBlock[] = Array.from({ length: 500 }, (_, i) => ({
      loc: { page: i + 1 },
      text: `${i + 1}ページ目の本文。`.repeat(20),
    }))
    blocks[420] = { loc: { page: 421 }, text: '目当ての段落はここにある。' }
    const [passage] = await cutPassages(
      blocksOf(blocks),
      new FragmentFinder([{ fragment: `目当ての${O}段落${C}`, chunkIndex: 0 }]),
      200
    )
    expect(passage!.blocks[0]!.loc.page).toBe(421)
    expect(passage!.text).toBe('目当ての段落はここにある。')
  })

  it('gives a fragment up once its chunk is read, not the rest of the document after it', async () => {
    // Two blocks of 300 KB: the second starts chunk 1, so chunk 0 is whole once it is in
    const blocks: DocumentTextBlock[] = Array.from({ length: 10 }, (_, i) => ({
      loc: { page: i + 1 },
      text: 'x'.repeat(300_000),
    }))
    const cut = await cutPassages(
      blocksOf(blocks, 2),
      new FragmentFinder([{ fragment: `${O}無い${C}段落`, chunkIndex: 0 }]),
      200
    )
    expect(cut).toEqual([])
  })

  it('finds a fragment in the chunk it is from, not the same words earlier', async () => {
    const filler = 'x'.repeat(300_000)
    const [passage] = await cutPassages(
      blocksOf([
        { loc: { page: 1 }, text: `目次\n第3章 汚泥の処理\n${filler}` },
        { loc: { page: 2 }, text: filler },
        { loc: { page: 3 }, text: '第3章 汚泥の処理' },
      ]),
      new FragmentFinder([{ fragment: `第3章 ${O}汚泥${C}の${O}処理${C}`, chunkIndex: 1 }]),
      200
    )
    expect(passage!.blocks.map((b) => b.loc.page)).toEqual([3])
  })

  it('finds a fragment after a line too long for a chunk, which the index cut short', async () => {
    const [passage] = await cutPassages(
      blocksOf([
        { loc: { page: 1 }, text: 'y'.repeat(2_000_000) },
        { loc: { page: 2 }, text: '後の段落' },
      ]),
      new FragmentFinder([{ fragment: `後の${O}段落${C}`, chunkIndex: 1 }]),
      200
    )
    expect(passage!.blocks.map((b) => b.loc.page)).toEqual([2])
  })
})

describe('cutPassages with the query words found in the text', () => {
  it('opens a passage at a word and takes in the words after it', async () => {
    const [passage, ...rest] = await cutPassages(
      blocksOf(report),
      new WordFinder(['汚泥', '処理'], 40),
      200
    )
    expect(rest).toEqual([])
    expect(passage!.words).toEqual(['汚泥', '処理', '処理', '処理'])
    expect(passage!.blocks[0]!.loc.page).toBe(3)
    expect(passage!.text.startsWith('発生した汚泥')).toBe(true)
  })

  it('finds words written in full-width letters and digits', async () => {
    const [passage] = await cutPassages(
      blocksOf([{ loc: { page: 1 }, text: '２０２４年度のＣＯＶＩＤ－１９対策' }]),
      new WordFinder(queryWords('2024年度 covid-19'), 40),
      200
    )
    expect(passage!.words).toEqual(['２０２４年度', 'ＣＯＶＩＤ－１９'])
  })

  it('finds words in Latin letters whatever their case', async () => {
    const [passage] = await cutPassages(
      blocksOf([{ loc: { page: 1 }, text: 'Covid-19 の対応' }]),
      new WordFinder(['covid-19'], 40),
      200
    )
    expect(passage!.words).toEqual(['Covid-19'])
  })

  it('records every word a passage holds, however often another fills its count', async () => {
    // As in production: 1,200-character passages, 64 of a word, 200 kept. The first page
    // repeats one word and holds the other once; every other page holds the first alone
    const blocks: DocumentTextBlock[] = [
      { loc: { page: 1 }, text: 'aa '.repeat(100) + 'target' },
      ...Array.from({ length: 201 }, (_, i) => ({ loc: { page: i + 2 }, text: 'aa '.repeat(100) })),
    ]
    const cut = await cutPassages(
      blocksOf(blocks),
      new WordFinder(['aa', 'target'], 1_200, 64),
      0,
      Infinity,
      200
    )
    expect(cut.some((p) => p.words.includes('target'))).toBe(true)
  })

  it('records no more of one word in a passage than it may', async () => {
    const [passage] = await cutPassages(
      blocksOf([{ loc: { page: 1 }, text: '汚泥'.repeat(100) }]),
      new WordFinder(['汚泥'], 1_000, 10),
      0
    )
    expect(passage!.words).toHaveLength(10)
  })

  it('reads no further than it may', async () => {
    const blocks: DocumentTextBlock[] = Array.from({ length: 10 }, (_, i) => ({
      loc: { page: i + 1 },
      text: i === 9 ? '汚泥' : 'x'.repeat(100),
    }))
    // The word is on the last page; the read stops before it, and asks for no more blocks
    const cut = await cutPassages(blocksOf(blocks, 3), new WordFinder(['汚泥'], 40), 0, 250)
    expect(cut).toEqual([])
  })

  it('keeps no more passages than it may, those holding most of the query wherever they are', async () => {
    // A word on every line fills passage after passage from the start; the one
    // that also holds the rarer word is at the end, and is the one to keep
    const text = 'aa '.repeat(15_000) + 'target' + 'z'.repeat(100)
    const cut = await cutPassages(
      blocksOf([{ loc: { page: 1 }, text }]),
      new WordFinder(['aa', 'target'], 40),
      0,
      Infinity,
      3
    )
    expect(cut).toHaveLength(3)
    expect(cut.some((p) => p.words.includes('target'))).toBe(true)
  })
})

describe('passageScores', () => {
  /** A passage of `words`, each marked where it stands, `gap` characters apart */
  function marked(words: string[], gap = 1) {
    let at = 0
    const marks: [number, number][] = words.map((w) => {
      const span: [number, number] = [at, at + w.length]
      at += w.length + gap
      return span
    })
    return { words, marks }
  }

  it('puts a passage holding both words above one repeating one of them', () => {
    const [both, repeated] = passageScores(
      [marked(['汚泥', '処理']), marked(Array(6).fill('処理')), marked(['処理'])],
      '汚泥の処理'
    )
    expect(both).toBeGreaterThan(repeated!)
  })

  it('counts a word the same whatever its width or case', () => {
    const [a, b] = passageScores([marked(['ＣＯＶＩＤ']), marked(['covid'])], 'covid')
    expect(a).toBe(b)
  })

  it('puts the compound the query asked for, its words side by side, above the words apart', () => {
    const [together, apart] = passageScores(
      [marked(['再生', '利用', '率'], 0), marked(['再生', '利用', '率'], 3)],
      '産業廃棄物の再生利用率'
    )
    expect(together).toBeGreaterThan(apart!)
  })

  it('weighs a compound by how many passages hold it, as a word', () => {
    const together = marked(['火災', '警報', '器'], 0)
    const apart = marked(['火災', '警報', '器'], 3)
    /** How far the first passage stands above the last */
    const lift = (passages: ReturnType<typeof marked>[]) => {
      const scores = passageScores(passages, '火災警報器')
      return scores[0]! - scores.at(-1)!
    }
    expect(lift([together, apart, apart, apart])).toBeGreaterThan(
      lift([together, together, together, apart])
    )
  })
})
