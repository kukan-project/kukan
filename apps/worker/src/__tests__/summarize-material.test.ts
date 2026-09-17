import { Readable } from 'node:stream'
import { describe, it, expect, vi } from 'vitest'
import { PDFDocument, PDFString } from 'pdf-lib'
import type { AIAdapter } from '@kukan/ai-adapter'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { createLogger } from '@kukan/shared'
import type { MaterialArtifacts } from '@kukan/api/services/suggest/materials'
import {
  planMaterial,
  type MaterialPlan,
  type SummaryDeps,
  type SummaryInput,
} from '../pipeline/steps/summarize'
import { SUMMARY_MAX_PDF_PAGES } from '@kukan/shared'

/** A real PDF, because the routing reads its page count */
async function pdfOf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([200, 200])
  return Buffer.from(await doc.save())
}

/**
 * A PDF that says it is protected. pdf-lib cannot encrypt, so the /Encrypt
 * entry is written into the trailer directly — which is all the reader
 * consults, and all the cut has to refuse on.
 */
async function encryptedPdfOf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.load(await pdfOf(pages), { ignoreEncryption: true })
  const { context } = doc
  context.trailerInfo.Encrypt = context.register(
    context.obj({
      Filter: 'Standard',
      V: 1,
      R: 2,
      O: PDFString.of('x'.repeat(32)),
      U: PDFString.of('y'.repeat(32)),
      P: -1,
    })
  )
  return Buffer.from(await doc.save())
}

function deps(opts: {
  bytes?: Buffer
  /** What the Index step extracted, served through downloadRange */
  textHead?: string
  documents?: boolean
}): SummaryDeps {
  const storage = {
    download: vi.fn(async () => Readable.from([opts.bytes ?? Buffer.from('x')])),
    downloadRange: vi.fn(async () => ({
      stream: Readable.from([Buffer.from(opts.textHead ?? '', 'utf-8')]),
    })),
  } as unknown as StorageAdapter
  const ai = {
    getCompletionInfo: () => ({ provider: 'bedrock', defaultModel: 'm', allowlist: ['m'] }),
    getDocumentInfo: () =>
      opts.documents === false
        ? null
        : {
            documentFormats: ['pdf', 'xlsx', 'docx'],
            imageFormats: ['jpeg', 'png'],
            maxImageBytes: 5 * 1024 * 1024,
          },
  } as unknown as AIAdapter
  return {
    db: {} as SummaryDeps['db'],
    storage,
    ai,
    log: createLogger({ name: 'test' }),
    model: 'jp.anthropic.claude-sonnet-4-6',
    locale: async () => 'ja',
  }
}

/** A ZIP container's first bytes — what every office format actually starts with */
const XLSX_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00])

function input(over: Partial<SummaryInput> = {}): SummaryInput {
  return {
    resourceId: '11111111-1111-1111-1111-111111111111',
    packageId: '22222222-2222-2222-2222-222222222222',
    version: 3,
    storageKey: 'resources/pkg/res/v1',
    format: 'PDF',
    size: 1024,
    ...over,
  }
}

const withTextHead: MaterialArtifacts = {
  pipelineStatus: 'complete',
  previewKey: null,
  pipelineMetadata: { textHeadKey: 'previews/text-head' },
  liveStorageKey: 'resources/pkg/res/v1',
}
/** Both steps of the last run wrote what they were meant to */
const USABLE = { interpreted: true, textHead: true }

const noArtifacts: MaterialArtifacts = {
  pipelineStatus: 'complete',
  previewKey: null,
  pipelineMetadata: {},
  liveStorageKey: 'resources/pkg/res/v1',
}

describe('choosing what to send (ADR-053 §3)', () => {
  describe('PDF', () => {
    it('uses the extracted text when the text layer is thick enough', async () => {
      // 2 pages, 600 characters — well past the 100-per-page floor
      const plan = await planMaterial(
        input(),
        withTextHead,
        USABLE,
        deps({ bytes: await pdfOf(2), textHead: 'あ'.repeat(600) })
      )

      expect(plan).toMatchObject({ kind: 'text-head' })
      expect(plan).not.toHaveProperty('attachment')
    })

    it('sends the original when the text layer is too thin to describe the file', async () => {
      // 5 pages, 50 characters — 10 a page
      const plan = await planMaterial(
        input(),
        withTextHead,
        USABLE,
        deps({ bytes: await pdfOf(5), textHead: 'あ'.repeat(50) })
      )

      expect(plan).toMatchObject({ kind: 'original' })
      expect(plan).toHaveProperty('attachment.format', 'pdf')
    })

    it('sends the original when nothing was extracted at all', async () => {
      const plan = await planMaterial(input(), noArtifacts, USABLE, deps({ bytes: await pdfOf(3) }))

      expect(plan).toMatchObject({ kind: 'original' })
    })

    it('takes the extracted text when the file will not open for counting', async () => {
      // pdf-lib refuses some real PDFs ("Expected instance of PDFDict"). That
      // says our parser could not open the file, which is poor evidence the
      // provider will make more of the whole of it — and the text is already
      // extracted, so it is the surer path as well as the cheaper one.
      const plan = await planMaterial(
        input(),
        withTextHead,
        USABLE,
        deps({ bytes: Buffer.from('%PDF-1.4\nnot really a pdf'), textHead: 'あ'.repeat(600) })
      )

      expect(plan).toMatchObject({ kind: 'text-head' })
    })

    it('refuses bytes that are not a PDF at all, and says which it is', async () => {
      // A publisher's dead link answered with its front page, stored as a
      // version: 44KB of「PDF」opening `<!doctype html>` (ADR-047). Nothing to
      // re-ask on a later run, so it stands rather than being quoted for again.
      const plan = await planMaterial(
        input(),
        noArtifacts,
        USABLE,
        deps({ bytes: Buffer.from('<!doctype html>\n<html lang="ja"><title>東京消防庁</title>') })
      )

      expect(plan).toEqual({ reason: 'format-mismatch' })
    })

    it('sends the original when it will not open and nothing was extracted', async () => {
      // The signature is there; only pdf-lib gave up, which is not a mismatch
      const plan = await planMaterial(
        input(),
        noArtifacts,
        USABLE,
        deps({ bytes: Buffer.from('%PDF-1.4\nnot really a pdf') })
      )

      expect(plan).toMatchObject({ kind: 'original' })
    })

    it('takes the text of a long document whose head filled the budget', async () => {
      // The head is read up to a byte cap, so dividing it by the page count of
      // a long document measures the cap: 16KB of Japanese over 467 pages
      // reads as 11 characters a page whatever the file holds. Treating that
      // as a thin layer sent the original for every PDF past about fifty
      // pages, and one such yearbook came back with the model reporting it
      // could extract nothing.
      const plan = await planMaterial(
        input(),
        withTextHead,
        USABLE,
        // Japanese, three bytes a character: past the 16KB cap
        deps({ bytes: await pdfOf(467), textHead: '下'.repeat(6000) })
      )

      expect(plan).toMatchObject({ kind: 'text-head' })
    })

    it('still sends the original where the whole of a thin layer was read', async () => {
      // Short of the cap the head is all there was, so the ratio means what it
      // says: 300 characters over 60 pages is five a page.
      const plan = await planMaterial(
        input(),
        withTextHead,
        USABLE,
        deps({ bytes: await pdfOf(60), textHead: 'あ'.repeat(300) })
      )

      expect(plan).toMatchObject({ kind: 'original' })
    })

    it('sends the front of a document past the page limit, and says so', async () => {
      // Tokens follow pages, so the limit is what one PDF can cost — and it is
      // the same ceiling whether the rest is cut off or the file is refused.
      // Refusing bought nothing and lost the abstract on exactly the files it
      // is worth most on.
      const plan = await planMaterial(
        input(),
        noArtifacts,
        USABLE,
        deps({ bytes: await pdfOf(60) })
      )

      expect(plan).toMatchObject({
        kind: 'original',
        coverage: { read: SUMMARY_MAX_PDF_PAGES, total: 60 },
      })
      // Cut, not merely declared cut: what goes is what the coverage claims
      const sent = await PDFDocument.load((plan as MaterialPlan).attachment!.bytes)
      expect(sent.getPageCount()).toBe(SUMMARY_MAX_PDF_PAGES)
    })

    it('will not cut a protected document, whose pages would come out blank', async () => {
      // `ignoreEncryption` parses the structure without decrypting it, so the
      // content streams cross into a document with no key: 50 blank pages out
      // of a yearbook holding 575,761 characters. Counting is safe; copying is
      // not, and the text layer is the path left.
      const plan = await planMaterial(
        input(),
        withTextHead,
        USABLE,
        deps({ bytes: await encryptedPdfOf(60), textHead: 'あ'.repeat(300) })
      )

      expect(plan).toMatchObject({ kind: 'text-head' })
    })

    it('leaves a document inside the limit whole, and claims nothing about pages', async () => {
      // "All of it" is what an absent coverage says, and saying it twice would
      // move every digest written before this.
      const plan = await planMaterial(input(), noArtifacts, USABLE, deps({ bytes: await pdfOf(3) }))

      expect(plan).toMatchObject({ kind: 'original' })
      expect((plan as MaterialPlan).coverage).toBeUndefined()
    })

    it('falls back to the extracted text past the byte limit, where the original cannot go', async () => {
      const plan = await planMaterial(
        input({ size: 40 * 1024 * 1024 }),
        withTextHead,
        USABLE,
        deps({ textHead: 'あ'.repeat(600) })
      )

      expect(plan).toMatchObject({ kind: 'text-head' })
    })

    it('gives up past the byte limit with nothing extracted', async () => {
      const plan = await planMaterial(
        input({ size: 40 * 1024 * 1024 }),
        noArtifacts,
        USABLE,
        deps({})
      )

      expect(plan).toEqual({ reason: 'too-large' })
    })

    it('keeps a thin text layer when the provider takes no originals', async () => {
      const plan = await planMaterial(
        input(),
        withTextHead,
        USABLE,
        deps({ bytes: await pdfOf(5), textHead: 'あ'.repeat(50), documents: false })
      )

      expect(plan).toMatchObject({ kind: 'text-head' })
    })
  })

  describe('Office', () => {
    it('sends the original within the byte limit', async () => {
      const plan = await planMaterial(
        input({ format: 'XLSX', size: 500 * 1024 }),
        noArtifacts,
        USABLE,
        deps({ bytes: XLSX_BYTES })
      )

      expect(plan).toMatchObject({ kind: 'original' })
      expect(plan).toHaveProperty('attachment.format', 'xlsx')
    })

    it('refuses bytes that are not the container the format is', async () => {
      // An office file is a ZIP; a publisher's error page is not (ADR-047)
      const plan = await planMaterial(
        input({ format: 'XLSX', size: 500 * 1024 }),
        noArtifacts,
        USABLE,
        deps({ bytes: Buffer.from('<!doctype html>') })
      )

      expect(plan).toEqual({ reason: 'format-mismatch' })
    })

    it('refuses past it — the tokens inside cannot be measured from here', async () => {
      const plan = await planMaterial(
        input({ format: 'XLSX', size: 2 * 1024 * 1024 }),
        noArtifacts,
        USABLE,
        deps({})
      )

      expect(plan).toEqual({ reason: 'too-large' })
    })

    it('treats an unknown size as an unbounded one', async () => {
      const plan = await planMaterial(
        input({ format: 'XLSX', size: null }),
        noArtifacts,
        USABLE,
        deps({})
      )

      expect(plan).toEqual({ reason: 'too-large' })
    })

    it('reads the extracted text for a format no provider takes as a document', async () => {
      // No provider lists PPT, so its original can never go — but Index has
      // already written text for it, and that is material (ADR-053 §3.6)
      const plan = await planMaterial(
        input({ format: 'PPTX', size: 100 * 1024 }),
        withTextHead,
        USABLE,
        deps({ textHead: 'あ'.repeat(400) })
      )

      expect(plan).toMatchObject({ kind: 'text-head', coverage: { read: 400 } })
    })

    it('refuses it only when there is no extracted text either', async () => {
      const plan = await planMaterial(
        input({ format: 'PPTX', size: 100 * 1024 }),
        noArtifacts,
        USABLE,
        deps({})
      )

      expect(plan).toEqual({ reason: 'unsupported-format' })
    })

    it('still sends the original for a format the provider does take', async () => {
      // Office originals are not swapped for extracted text: that comparison
      // has not been made (ADR-053 §3.6)
      const plan = await planMaterial(
        input({ format: 'XLSX', size: 500 * 1024 }),
        withTextHead,
        USABLE,
        deps({ bytes: XLSX_BYTES, textHead: 'あ'.repeat(400) })
      )

      expect(plan).toMatchObject({ kind: 'original' })
    })
  })

  describe('images', () => {
    it('sends one that is already within the API limit unchanged', async () => {
      const bytes = Buffer.from('jpeg-bytes')
      const plan = await planMaterial(
        input({ format: 'JPEG', size: 1024 }),
        noArtifacts,
        USABLE,
        deps({ bytes })
      )

      expect(plan).toMatchObject({ kind: 'image' })
      expect(plan).toHaveProperty('attachment.bytes', bytes)
    })

    it('is not offered where the provider takes no images', async () => {
      const plan = await planMaterial(
        input({ format: 'PNG', size: 1024 }),
        noArtifacts,
        USABLE,
        deps({ documents: false })
      )

      expect(plan).toEqual({ reason: 'unsupported-format' })
    })
  })

  it('says so when there is no material at all', async () => {
    const plan = await planMaterial(
      input({ format: 'RDF', size: 1024 }),
      { ...noArtifacts, pipelineStatus: 'complete' },
      USABLE,
      deps({})
    )

    expect(plan).toEqual({ reason: 'no-material' })
  })
})

describe('each kind is gated on the step that wrote what it reads', () => {
  it('refuses an ODT whose Index step failed', async () => {
    // The extracted text of an ODT comes from Index, not Interpret. Asking
    // Interpret about it let a run whose Index failed describe the file with
    // the text of the version before it — the artifact is still on the row.
    const plan = await planMaterial(
      input({ format: 'ODT' }),
      withTextHead,
      { interpreted: true, textHead: false },
      deps({ textHead: 'これは前の版から抽出されたテキストで、十分な長さがあります。'.repeat(4) })
    )

    expect(plan).toEqual({ reason: 'no-material' })
  })

  it('reads a text file even when the interpretation failed', async () => {
    // A text file is read from the object, which is settled (ADR-046). The
    // interpretation writes nothing it needs, so its failure costs nothing.
    const plan = await planMaterial(
      input({ format: 'TXT' }),
      { ...noArtifacts, liveStorageKey: 'resources/pkg/res/v1' },
      { interpreted: false, textHead: false },
      deps({ textHead: 'これは本体から読んだ十分な長さの日本語テキストです。'.repeat(4) })
    )

    expect(plan).toMatchObject({ kind: 'text' })
  })

  it('still refuses a table whose interpretation failed', async () => {
    const plan = await planMaterial(
      input({ format: 'CSV' }),
      { ...noArtifacts, previewKey: 'previews/p.parquet' },
      { interpreted: false, textHead: true },
      deps({})
    )

    expect(plan).toEqual({ reason: 'no-material' })
  })
})
