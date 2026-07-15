/**
 * KUKAN Metadata Suggest Service (ADR-040)
 *
 * Builds throwaway prompt material from the DB, storage originals and
 * persisted pipeline artifacts (never the search index — its content leg is
 * a no-op on the PostgreSQL fallback),
 * runs one LLM call that returns all fields at once, validates the JSON, and
 * post-processes it so the response honours the tag and resource contracts.
 * Suggestions are never persisted; adopting one is a normal package update.
 */

import type { Readable } from 'node:stream'
import { inArray } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resourcePipeline } from '@kukan/db'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { AIAdapter } from '@kukan/ai-adapter'
import {
  ServiceUnavailableError,
  ValidationError,
  getStorageKey,
  isCsvFormat,
  isTextFormat,
  isDocumentFormat,
  isZipFormat,
  createLogger,
  type Logger,
  type SuggestMetadataResponse,
  type MetadataSuggestion,
  type SuggestedTag,
  type ZipManifest,
} from '@kukan/shared'
import {
  detectEncoding,
  bufferToUtf8,
  stripTrailingReplacementChar,
} from '@kukan/shared/encoding-node'
import { QueryService } from './query-service'
import { TagService } from './tag-service'
import { parseResourceSchema } from './pipeline-service'
import {
  buildSystemPrompt,
  buildUserContent,
  buildLlmOutputJsonSchema,
  suggestLlmOutputSchema,
  type SuggestLlmOutput,
  type ResourceMaterial,
  type SuggestMaterials,
} from './suggest/prompt'
import type { AuthUser } from '../auth/permissions'
import {
  SUGGEST_TEXT_HEAD_BYTES,
  SUGGEST_ZIP_MANIFEST_ENTRIES,
  SUGGEST_ZIP_MANIFEST_MAX_BYTES,
  SUGGEST_SAMPLE_ROWS,
  SUGGEST_SAMPLE_CELL_CHARS,
  SUGGEST_MAX_RESOURCES,
  SUGGEST_MAX_PROMPT_BYTES,
  SUGGEST_TAG_CANDIDATES,
  SUGGEST_MAX_TOKENS,
  SUGGEST_TIMEOUT_MS,
} from '../config'

const MAX_NEW_TAGS = 2
const MAX_TAGS = 5
/** Length clamps — the LLM schema cannot carry constraints (strict subset) */
const MAX_TITLE_LENGTH = 200
const MAX_NOTES_LENGTH = 4000
const MAX_DESCRIPTION_LENGTH = 1000
/** Matches the tag.name column (varchar 200) */
const MAX_TAG_LENGTH = 200
/** Description clamp applied when metadata alone exceeds the prompt budget */
const TRIMMED_DESCRIPTION_CHARS = 100
/** Material clamps for free-text DB columns (text type, unbounded) — together
 *  they make the post-ladder prompt provably smaller than the byte budget */
const MAX_MATERIAL_NAME_CHARS = 200
const MAX_MATERIAL_URL_CHARS = 500
const MAX_MATERIAL_TAGS = 30

/** Structural subset of PackageService.getDetailByNameOrId()'s return value */
export interface SuggestPackageDetail {
  id: string
  title: string | null
  notes: string | null
  url: string | null
  resources: Array<{
    id: string
    name: string | null
    description: string | null
    format: string | null
    mimetype: string | null
    size: number | null
    pipelineStatus: string | null
  }>
  tags: Array<{ name: string }>
  organization: { title: string | null } | null
}

export interface SuggestOptions {
  locale: 'ja' | 'en'
  model: string
  provider: string
}

export class MetadataSuggestService {
  private readonly log: Logger

  constructor(
    private readonly db: Database,
    private readonly storage: StorageAdapter,
    private readonly ai: AIAdapter,
    logger?: Logger
  ) {
    this.log = logger ?? createLogger({ name: 'api' })
  }

  async suggest(
    pkg: SuggestPackageDetail,
    user: AuthUser,
    opts: SuggestOptions
  ): Promise<SuggestMetadataResponse> {
    const startedAt = Date.now()
    const { described, others } = await this.collectMaterials(pkg, user)
    const tagCandidates = (
      await new TagService(this.db).list({
        limit: SUGGEST_TAG_CANDIDATES,
        orderBy: 'packageCount',
      })
    ).items.map((t) => t.name)

    const materials: SuggestMaterials = {
      pkg: {
        title: pkg.title?.slice(0, MAX_TITLE_LENGTH) ?? null,
        notes: pkg.notes?.slice(0, MAX_NOTES_LENGTH) ?? null,
        url: pkg.url?.slice(0, MAX_MATERIAL_URL_CHARS) ?? null,
        tags: pkg.tags.slice(0, MAX_MATERIAL_TAGS).map((t) => t.name.slice(0, MAX_TAG_LENGTH)),
        organization: pkg.organization?.title?.slice(0, MAX_TITLE_LENGTH) ?? null,
      },
      described,
      others,
      tagCandidates,
    }
    // May drop trailing described resources to fit the budget — read the count
    // and the mapping list from materials.described afterwards
    const content = this.fitToBudget(materials)

    const output = await this.generate(content, materials.described.length, opts)
    const suggestion = this.postProcess(output, materials.described, tagCandidates)

    // used = described resources whose content actually loaded (matches
    // buildUserContent's truthy checks — an empty textHead is unused)
    const hasContent = (r: ResourceMaterial) =>
      r.schema !== null ||
      (r.sampleRows?.length ?? 0) > 0 ||
      Boolean(r.textHead) ||
      (r.fileList?.length ?? 0) > 0
    const usedResources = materials.described.filter(hasContent).map((r) => r.id)
    const used = new Set(usedResources)
    const skippedResources = pkg.resources.map((r) => r.id).filter((id) => !used.has(id))

    this.log.info(
      {
        component: 'suggest',
        packageId: pkg.id,
        model: opts.model,
        usedResources: usedResources.length,
        skippedResources: skippedResources.length,
        elapsedMs: Date.now() - startedAt,
      },
      'metadata suggestion'
    )

    return {
      suggestion,
      generatedBy: { provider: opts.provider, model: opts.model },
      usedResources,
      skippedResources,
    }
  }

  /**
   * Split the package's resources into `described` (the first
   * SUGGEST_MAX_RESOURCES, each given a name + description slot) and `others`
   * (resources beyond the cap, kept as lightweight name/format context for the
   * title/notes only). Every described resource gets a slot regardless of
   * format so the LLM can name it; content-eligible ones (pipeline complete +
   * CSV/TSV, text, document with a text-head artifact, or ZIP with a manifest)
   * additionally carry a column schema + sample rows, head text, or a file
   * listing and are ordered first so their material always keeps a slot.
   */
  private async collectMaterials(
    pkg: SuggestPackageDetail,
    user: AuthUser
  ): Promise<{
    described: ResourceMaterial[]
    others: { name: string | null; format: string | null }[]
  }> {
    const pipelineRows = pkg.resources.length
      ? await this.db
          .select({
            resourceId: resourcePipeline.resourceId,
            status: resourcePipeline.status,
            previewKey: resourcePipeline.previewKey,
            metadata: resourcePipeline.metadata,
          })
          .from(resourcePipeline)
          .where(
            inArray(
              resourcePipeline.resourceId,
              pkg.resources.map((r) => r.id)
            )
          )
      : []
    const pipelines = new Map(pipelineRows.map((row) => [row.resourceId, row]))

    // Documents require the Index step's text-head artifact (ADR-040 addendum)
    // and ZIPs their Extract-step manifest; requiring the pipeline record also
    // guards against a key left over from a previous format
    const contentKind = (r: SuggestPackageDetail['resources'][number]) => {
      const pipeline = pipelines.get(r.id)
      if (pipeline?.status !== 'complete') return null
      if (isCsvFormat(r.format, r.mimetype)) return 'tabular'
      if (isTextFormat(r.format)) return 'text'
      if (isDocumentFormat(r.format) && textHeadKeyOf(pipeline.metadata)) return 'document'
      if (isZipFormat(r.format) && pipeline.previewKey) return 'zip'
      return null
    }
    const isEligible = (r: SuggestPackageDetail['resources'][number]) => contentKind(r) !== null

    // Pick which resources get a slot by eligibility (content-eligible first so
    // their extracted material keeps a slot when a package exceeds the cap),
    // then restore the package's natural order so the response matches the
    // resource list the caller shows. Resources beyond the cap still appear as
    // name/format context.
    const describedIds = new Set(
      [...pkg.resources]
        .sort((a, b) => Number(isEligible(b)) - Number(isEligible(a)))
        .slice(0, SUGGEST_MAX_RESOURCES)
        .map((r) => r.id)
    )
    const slotted = pkg.resources.filter((r) => describedIds.has(r.id))

    const described: ResourceMaterial[] = []
    for (const resource of slotted) {
      const material: ResourceMaterial = {
        id: resource.id,
        name: resource.name?.slice(0, MAX_MATERIAL_NAME_CHARS) ?? null,
        description: resource.description?.slice(0, MAX_DESCRIPTION_LENGTH) ?? null,
        format: resource.format?.slice(0, MAX_MATERIAL_NAME_CHARS) ?? null,
        size: resource.size,
        schema: null,
        sampleRows: null,
        textHead: null,
        fileList: null,
        fileCount: null,
      }

      const kind = contentKind(resource)
      if (kind) {
        const pipeline = pipelines.get(resource.id)!
        try {
          if (kind === 'tabular') {
            material.schema = parseResourceSchema(pipeline.metadata)
            material.sampleRows = await this.readSampleRows(resource.id, user)
          } else if (kind === 'text') {
            material.textHead = await this.readTextHead(pkg.id, resource.id, {
              format: resource.format ?? '',
              metadata: pipeline.metadata,
            })
          } else if (kind === 'document') {
            material.textHead = await this.readArtifactTextHead(textHeadKeyOf(pipeline.metadata)!)
          } else {
            const manifest = await this.readZipFileList(pipeline.previewKey!)
            material.fileList = manifest.fileList
            material.fileCount = manifest.fileCount
          }
        } catch (error) {
          // Material is best-effort: keep the resource's metadata in the prompt
          this.log.warn(
            { component: 'suggest', resourceId: resource.id, err: error },
            'failed to read suggestion material'
          )
        }
      }
      described.push(material)
    }

    // Beyond the cap: name/format context for the title/notes only
    const others = pkg.resources
      .filter((r) => !describedIds.has(r.id))
      .map((r) => ({
        name: r.name?.slice(0, MAX_MATERIAL_NAME_CHARS) ?? null,
        format: r.format?.slice(0, MAX_MATERIAL_NAME_CHARS) ?? null,
      }))

    return { described, others }
  }

  /**
   * Serialize the prompt material, shrinking it until it fits
   * SUGGEST_MAX_PROMPT_BYTES. In order of increasing damage: trim described
   * content (largest piece first — textHead halved then dropped, sample rows,
   * file list, schema), drop lightweight `others` context, then shorten and finally drop
   * trailing described resources. With the column/count caps in place this
   * rarely does more than the first step (text-heavy datasets).
   */
  private fitToBudget(materials: SuggestMaterials): string {
    const over = () => Buffer.byteLength(buildUserContent(materials)) > SUGGEST_MAX_PROMPT_BYTES
    const contentLength = (r: ResourceMaterial) =>
      (r.textHead?.length ?? 0) +
      (r.sampleRows?.length ? JSON.stringify(r.sampleRows).length : 0) +
      (r.fileList?.length ? JSON.stringify(r.fileList).length : 0) +
      (r.schema ? JSON.stringify(r.schema.columns).length : 0)

    let trimmed = false

    // 1. Trim described content, largest piece first
    while (over()) {
      const victim = materials.described
        .filter((r) => contentLength(r) > 0)
        .sort((a, b) => contentLength(b) - contentLength(a))[0]
      if (!victim) break
      if (victim.textHead && victim.textHead.length > 1024) {
        victim.textHead = victim.textHead.slice(0, Math.floor(victim.textHead.length / 2))
      } else if (victim.textHead) {
        victim.textHead = null
      } else if (victim.sampleRows?.length) {
        victim.sampleRows = null
      } else if (victim.fileList?.length) {
        victim.fileList = null
        victim.fileCount = null
      } else {
        victim.schema = null
      }
      trimmed = true
    }

    // 2. Drop the least valuable context (metadata-only `others`) from the tail
    while (over() && materials.others.length) {
      materials.others.pop()
      trimmed = true
    }

    // 3. Shorten described descriptions, then drop trailing described resources
    if (over()) {
      for (const r of materials.described) {
        r.description = r.description?.slice(0, TRIMMED_DESCRIPTION_CHARS) ?? null
      }
      const total = materials.described.length
      while (over() && materials.described.length > 1) materials.described.pop()
      if (materials.described.length < total) {
        this.log.warn(
          { component: 'suggest', droppedResources: total - materials.described.length },
          'described resources dropped to fit prompt budget'
        )
      }
      trimmed = true
    }

    const content = buildUserContent(materials)
    // Unreachable with the material clamps in place — fail loud over silently
    // shipping an oversized prompt if a clamp is ever missed
    if (Buffer.byteLength(content) > SUGGEST_MAX_PROMPT_BYTES) {
      throw new ValidationError('Suggestion material could not be reduced to fit the prompt budget')
    }
    if (trimmed) {
      this.log.info(
        { component: 'suggest', promptBytes: Buffer.byteLength(content) },
        'prompt material trimmed to fit budget'
      )
    }
    return content
  }

  /** First rows of the preview Parquet via the sandboxed query path (ADR-032) */
  private async readSampleRows(resourceId: string, user: AuthUser) {
    const result = await new QueryService(this.db, this.storage, this.log).query(
      resourceId,
      `SELECT * FROM data LIMIT ${SUGGEST_SAMPLE_ROWS}`,
      user
    )
    // LIMIT bounds rows, not cell size — clamp huge text cells
    return result.rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          typeof value === 'string' && value.length > SUGGEST_SAMPLE_CELL_CHARS
            ? `${value.slice(0, SUGGEST_SAMPLE_CELL_CHARS)}…`
            : value,
        ])
      )
    )
  }

  /** Head of the storage original, decoded and stripped of a cut multi-byte char */
  private async readTextHead(
    packageId: string,
    resourceId: string,
    source: { format: string; metadata: unknown }
  ) {
    const { stream } = await this.storage.downloadRange(
      getStorageKey(packageId, resourceId),
      0,
      SUGGEST_TEXT_HEAD_BYTES - 1
    )
    const buffer = await readAll(stream)
    // Prefer the encoding the Extract step detected on the full file; only
    // re-detect when the pipeline row predates encoding persistence
    const persisted = (source.metadata as { encoding?: unknown } | null)?.encoding
    const encoding =
      typeof persisted === 'string' && persisted
        ? persisted
        : detectEncoding(source.format.toLowerCase(), buffer)
    return stripTrailingReplacementChar(bufferToUtf8(buffer, encoding))
  }

  /** Head of the Index step's text-head artifact (document formats) — the
   *  worker wrote it as UTF-8, so no encoding detection (ADR-040 addendum) */
  private async readArtifactTextHead(textHeadKey: string) {
    const { stream } = await this.storage.downloadRange(textHeadKey, 0, SUGGEST_TEXT_HEAD_BYTES - 1)
    const buffer = await readAll(stream)
    return stripTrailingReplacementChar(buffer.toString('utf-8'))
  }

  /** File paths from the Extract step's ZIP manifest, capped by entry count.
   *  The read is byte-capped: entry paths are attacker-controlled, so the
   *  manifest can be made arbitrarily large despite the worker's entry cap */
  private async readZipFileList(previewKey: string) {
    const buffer = await readAll(
      await this.storage.download(previewKey),
      SUGGEST_ZIP_MANIFEST_MAX_BYTES
    )
    const manifest = JSON.parse(buffer.toString('utf-8')) as ZipManifest
    const fileList = (manifest.entries ?? [])
      .filter((entry) => !entry.isDirectory)
      .slice(0, SUGGEST_ZIP_MANIFEST_ENTRIES)
      .map((entry) => entry.path.slice(0, MAX_MATERIAL_NAME_CHARS))
    return { fileList, fileCount: manifest.totalFiles ?? fileList.length }
  }

  /**
   * One LLM call returning every field (ADR-040). The provider's native JSON
   * mechanism enforces the shape; parsing still gets one retry because local
   * models occasionally emit invalid JSON despite it.
   */
  private async generate(
    content: string,
    describedCount: number,
    opts: SuggestOptions
  ): Promise<SuggestLlmOutput> {
    const system = buildSystemPrompt(opts.locale)
    // Per-index required keys force one description per described resource
    const schema = buildLlmOutputJsonSchema(describedCount)

    for (let attempt = 0; attempt < 2; attempt++) {
      let raw: string
      try {
        raw = await this.ai.complete(content, {
          system,
          model: opts.model,
          maxTokens: SUGGEST_MAX_TOKENS,
          timeoutMs: SUGGEST_TIMEOUT_MS,
          jsonSchema: { name: 'suggest_metadata', schema },
        })
      } catch (error) {
        // Provider failures (model missing, timeout) won't improve on retry
        throw new ServiceUnavailableError(
          `AI suggestion failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }

      try {
        const parsed = suggestLlmOutputSchema.safeParse(JSON.parse(raw))
        if (parsed.success) return parsed.data
      } catch {
        // fall through to retry
      }
      this.log.warn(
        { component: 'suggest', model: opts.model, attempt },
        'LLM returned invalid JSON'
      )
    }
    throw new ServiceUnavailableError('AI suggestion returned invalid JSON')
  }

  /** Enforce the contracts the LLM schema cannot: tag counts, index→id
   *  mapping, length clamps. */
  private postProcess(
    output: SuggestLlmOutput,
    described: ResourceMaterial[],
    tagCandidates: string[]
  ): MetadataSuggestion {
    const candidates = new Set(tagCandidates)
    const seenTags = new Set<string>()
    const tags: SuggestedTag[] = []
    let newTags = 0
    for (const raw of output.tags) {
      if (tags.length >= MAX_TAGS) break
      const name = raw.trim().slice(0, MAX_TAG_LENGTH)
      if (!name || seenTags.has(name)) continue
      const isNew = !candidates.has(name)
      if (isNew && newTags >= MAX_NEW_TAGS) continue
      seenTags.add(name)
      if (isNew) newTags++
      tags.push({ name, isNew })
    }

    // Map each index key back to the real resource id; drop out-of-range keys
    // and entries with neither a name nor a description
    const seenIds = new Set<string>()
    const resources: MetadataSuggestion['resources'] = []
    for (const [key, suggestion] of Object.entries(output.resourceSuggestions)) {
      const index = Number(key)
      const resource = Number.isInteger(index) ? described[index] : undefined
      if (!resource || seenIds.has(resource.id)) continue
      const name = suggestion.name.trim().slice(0, MAX_MATERIAL_NAME_CHARS)
      const description = suggestion.description.trim().slice(0, MAX_DESCRIPTION_LENGTH)
      if (!name && !description) continue
      seenIds.add(resource.id)
      resources.push({ id: resource.id, name, description })
    }

    return {
      title: output.title.trim().slice(0, MAX_TITLE_LENGTH),
      notes: output.notes.trim().slice(0, MAX_NOTES_LENGTH),
      tags,
      resources,
    }
  }
}

/** `metadata.textHeadKey` persisted by the Index step (document formats, ADR-040) */
function textHeadKeyOf(metadata: unknown): string | null {
  const key = (metadata as { textHeadKey?: unknown } | null | undefined)?.textHeadKey
  return typeof key === 'string' && key ? key : null
}

async function readAll(stream: Readable, maxBytes = Infinity): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > maxBytes) {
      throw new Error(`Stream exceeds ${maxBytes} bytes`)
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}
