import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DocumentTextBlock } from '@kukan/shared'
import { documentBlocks } from '@/pipeline/interpret/document/document-text'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'markdown-text-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function blocks(markdown: string): Promise<DocumentTextBlock[]> {
  const path = join(dir, 'a.md')
  await writeFile(path, markdown)
  const out: DocumentTextBlock[] = []
  for await (const block of documentBlocks(path, 'md')) out.push(block)
  return out
}

describe('Markdown', () => {
  it('reads a block from one heading to the next, under the path of headings over it', async () => {
    expect(
      await blocks('before\n\n# A\n\npara\n\n## B\n\ntext\n\n### C\n\ndeep\n\n# D\n\nend\n')
    ).toEqual([
      { loc: {}, text: 'before' },
      { loc: {}, headings: ['A'], text: '# A\n\npara' },
      { loc: {}, headings: ['A', 'B'], text: '## B\n\ntext' },
      { loc: {}, headings: ['A', 'B', 'C'], text: '### C\n\ndeep' },
      { loc: {}, headings: ['D'], text: '# D\n\nend' },
    ])
  })

  it('keeps the lines as written, marks and all', async () => {
    const text = '- **bold** item\n\n| 列 | 型 |\n|---|---|\n| id | int |\n\n> [link](https://x)'
    expect(await blocks(text + '\n')).toEqual([{ loc: {}, text }])
  })

  it('reads an underlined heading, and a rule after a blank line as no heading', async () => {
    expect(await blocks('Title\n===\n\nbody\n\n---\n\nSub\n---\nmore\n')).toEqual([
      { loc: {}, headings: ['Title'], text: 'Title\n===\n\nbody\n\n---' },
      { loc: {}, headings: ['Title', 'Sub'], text: 'Sub\n---\nmore' },
    ])
  })

  it('takes a # in a fenced code block or in front matter for no heading', async () => {
    const code = '```sh\n# not a heading\n```\n\n~~~\n```\n~~~'
    expect(await blocks(`# H\n\n${code}\n`)).toEqual([
      { loc: {}, headings: ['H'], text: `# H\n\n${code}` },
    ])
    expect(await blocks('---\ntitle: x\n# no\n---\n\n# H\n')).toEqual([
      { loc: {}, text: '---\ntitle: x\n# no\n---' },
      { loc: {}, headings: ['H'], text: '# H' },
    ])
  })

  it('titles a heading by its words, without the marks around them, as the line keeps them', async () => {
    const [block] = await blocks('## **Bold** [link](https://x) `code` <b>tag</b> _em_ ##\n')
    expect(block).toEqual({
      loc: {},
      headings: ['Bold link code tag em'],
      text: '## **Bold** [link](https://x) `code` <b>tag</b> _em_ ##',
    })
  })

  it('cuts a long run into blocks under the same headings before it is held whole', async () => {
    const line = 'あ'.repeat(1000)
    const out = await blocks('# H\n\n' + Array(50).fill(line).join('\n\n') + '\n')
    expect(out.length).toBeGreaterThan(1)
    expect(out.every((b) => b.headings?.[0] === 'H' && b.text.length <= 33_000)).toBe(true)
    expect(out.flatMap((b) => b.text.split('\n')).filter(Boolean)).toEqual([
      '# H',
      ...Array(50).fill(line),
    ])
  })

  it('keeps an underlined heading whose title is the last line before the cut', async () => {
    const line = 'x'.repeat(999)
    const out = await blocks(Array(32).fill(line).join('\n') + '\nTitle\n---\nmore\n')
    expect(out.at(-1)).toEqual({ loc: {}, headings: ['Title'], text: 'Title\n---\nmore' })
    expect(out.flatMap((b) => b.text.split('\n')).filter((l) => l === line)).toHaveLength(32)
  })

  it('takes a rule under a list item, a quote or a table row for no heading', async () => {
    expect(
      await blocks('- item\n---\n> quote\n---\n| a | b |\n|---|---|\n| 1 | 2 |\n---\n## H\n')
    ).toEqual([
      { loc: {}, text: '- item\n---\n> quote\n---\n| a | b |\n|---|---|\n| 1 | 2 |\n---' },
      { loc: {}, headings: ['H'], text: '## H' },
    ])
  })

  it('reads a pipe in an underlined heading as text, a table needing as many cells below it', async () => {
    expect(await blocks('Read | Query\n---\nbody\n\n`a|b`\n===\nmore\n')).toEqual([
      { loc: {}, headings: ['Read | Query'], text: 'Read | Query\n---\nbody' },
      { loc: {}, headings: ['a|b'], text: '`a|b`\n===\nmore' },
    ])
    // One cell over one: a table, whose header is no heading
    expect(await blocks('| a |\n---\n| 1 |\n')).toEqual([{ loc: {}, text: '| a |\n---\n| 1 |' }])
  })

  it('ends a table where a fence starts, so an underline after the code is a heading', async () => {
    expect(await blocks('| a |\n|---|\n| 1 |\n```\ncode\n```\nTitle\n---\nbody\n')).toEqual([
      { loc: {}, text: '| a |\n|---|\n| 1 |\n```\ncode\n```' },
      { loc: {}, headings: ['Title'], text: 'Title\n---\nbody' },
    ])
  })

  it('opens no fence on a line that starts with a code span', async () => {
    expect(await blocks('```sh``` is the fence marker\n\n# H\n')).toEqual([
      { loc: {}, text: '```sh``` is the fence marker' },
      { loc: {}, headings: ['H'], text: '# H' },
    ])
  })

  it('cuts a heading to one line of at most 200 characters, and drops a byte order mark', async () => {
    const [block] = await blocks(`\uFEFF# ${'x'.repeat(300)}  \t y\n\nbody\n`)
    expect(block.headings).toEqual(['x'.repeat(200)])
    expect(block.text.startsWith('# x')).toBe(true)
  })

  it('reads a heading of a long line of spaces and tabs in linear time', async () => {
    const started = Date.now()
    const [block] = await blocks('# a' + ' \t'.repeat(100_000) + 'b\n')
    expect(Date.now() - started).toBeLessThan(1000)
    // The title is read from the head of the line only
    expect(block.headings).toEqual(['a'])
  })

  it('reads a # with no space after it as no heading', async () => {
    expect(await blocks('#hashtag\n')).toEqual([{ loc: {}, text: '#hashtag' }])
  })

  it('reads an empty file as no blocks', async () => {
    expect(await blocks('')).toEqual([])
    expect(await blocks('\n\n')).toEqual([])
  })
})
