/**
 * KUKAN Metadata Suggest Service (ADR-040)
 *
 * Builds throwaway prompt material from the DB, storage originals and
 * persisted pipeline artifacts (never the search index — its content leg is
 * a no-op on the PostgreSQL fallback), then generates in two phases
 * (parallel-generation addendum): one completion per resource run with
 * bounded concurrency, and one dataset completion that integrates the
 * generated descriptions into title / notes / tags / groups (and a URL slug
 * for drafts). Suggestions are never persisted; adopting one is a normal
 * package update.
 */

import type { Readable } from 'node:stream'
import { inArray } from 'drizzle-orm'
import type { z } from 'zod'
import type { Database } from '@kukan/db'
import { packageTable, resource, resourcePipeline } from '@kukan/db'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { AIAdapter } from '@kukan/ai-adapter'
import {
  ServiceUnavailableError,
  ValidationError,
  isCsvFormat,
  isTextFormat,
  isDocumentFormat,
  isZipFormat,
  createLogger,
  PACKAGE_NAME_MAX_LENGTH,
  isValidPackageName,
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
import { GroupService } from './group-service'
import { parseResourceSchema } from './pipeline-service'
import {
  buildResourceSystemPrompt,
  buildResourceUserContent,
  buildDatasetSystemPrompt,
  buildDatasetUserContent,
  buildDatasetOutputJsonSchema,
  resourceLlmOutputSchema,
  datasetLlmOutputSchema,
  RESOURCE_OUTPUT_JSON_SCHEMA,
  type ResourceMaterial,
  type DatasetMaterials,
} from './suggest/prompt'
import type { AuthUser } from '../auth/permissions'
import {
  SUGGEST_TEXT_HEAD_BYTES,
  SUGGEST_ZIP_MANIFEST_ENTRIES,
  SUGGEST_ZIP_MANIFEST_MAX_BYTES,
  SUGGEST_SAMPLE_ROWS,
  SUGGEST_SAMPLE_CELL_CHARS,
  SUGGEST_MAX_RESOURCES,
  SUGGEST_RESOURCE_PROMPT_BYTES,
  SUGGEST_DATASET_PROMPT_BYTES,
  SUGGEST_TAG_CANDIDATES,
  SUGGEST_GROUP_CANDIDATES,
  SUGGEST_RESOURCE_MAX_TOKENS,
  SUGGEST_DATASET_MAX_TOKENS,
  SUGGEST_TIMEOUT_MS,
  SUGGEST_TOTAL_DEADLINE_MS,
  SUGGEST_PHASE2_RESERVE_MS,
  SUGGEST_MIN_CALL_MS,
  SUGGEST_THROTTLE_BACKOFF_MS,
  suggestConcurrency,
} from '../config'

const MAX_NEW_TAGS = 2
const MAX_TAGS = 5
const MAX_GROUPS = 3
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

/** Numeric suffixes tried when the generated slug collides */
const NAME_SUFFIX_ATTEMPTS = 8

/** Structural subset of PackageService.getDetailByNameOrId()'s return value */
export interface SuggestPackageDetail {
  id: string
  /** URL-slug suggestions are generated for drafts only (ADR-040 addendum) */
  state: string | null
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
  groups: Array<{ name: string }>
  organization: { title: string | null } | null
}

export interface SuggestOptions {
  locale: 'ja' | 'en'
  model: string
  provider: string
}

interface CompleteJsonArgs<T> {
  system: string
  jsonSchema: { name: string; schema: Record<string, unknown> }
  outputSchema: z.ZodType<T>
  maxTokens: number
  /** Wall-clock bound covering every attempt (throttle and JSON retries) */
  deadlineAt: number
  opts: SuggestOptions
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
    const deadlineAt = startedAt + SUGGEST_TOTAL_DEADLINE_MS
    const { described, others } = await this.collectMaterials(pkg, user)
    const [tagCandidates, groupCandidates] = await Promise.all([
      new TagService(this.db)
        .list({ limit: SUGGEST_TAG_CANDIDATES, orderBy: 'packageCount' })
        .then((r) => r.items.map((t) => t.name)),
      this.fetchGroupCandidates(),
    ])

    // Phase 1: one completion per resource, bounded per-provider concurrency.
    // A failed or all-blank resource degrades to name/format context instead
    // of failing the whole suggestion (ADR-040 parallel-generation addendum).
    const resourceSystem = buildResourceSystemPrompt(opts.locale)
    const phase1 = await mapWithConcurrency(
      described,
      suggestConcurrency(opts.provider),
      async (material) => ({
        material,
        output: await this.generateResource(material, resourceSystem, opts, deadlineAt),
      })
    )
    const succeeded = phase1.filter(
      (r): r is { material: ResourceMaterial; output: { name: string; description: string } } =>
        r.output !== null
    )
    if (described.length > 0 && succeeded.length === 0) {
      throw new ServiceUnavailableError('AI suggestion failed for every resource')
    }

    const resourceSuggestions = succeeded.map(({ material, output }) => ({
      id: material.id,
      name: output.name,
      description: output.description,
      format: material.format,
    }))

    // Phase 2: integrate the generated descriptions into the dataset fields.
    // Resources without a Phase 1 result join the lightweight context.
    const failed = phase1.filter((r) => r.output === null).map((r) => r.material)
    const materials: DatasetMaterials = {
      pkg: {
        title: pkg.title?.slice(0, MAX_TITLE_LENGTH) ?? null,
        notes: pkg.notes?.slice(0, MAX_NOTES_LENGTH) ?? null,
        url: pkg.url?.slice(0, MAX_MATERIAL_URL_CHARS) ?? null,
        tags: pkg.tags.slice(0, MAX_MATERIAL_TAGS).map((t) => t.name.slice(0, MAX_TAG_LENGTH)),
        // Current memberships — without them the LLM cannot respect existing
        // categories, and an adopted suggestion replaces the whole set
        groups: pkg.groups.map((g) => g.name.slice(0, MAX_MATERIAL_NAME_CHARS)),
        organization: pkg.organization?.title?.slice(0, MAX_TITLE_LENGTH) ?? null,
      },
      resources: resourceSuggestions.map(({ name, description, format }) => ({
        name,
        description,
        format,
      })),
      others: [...failed.map((m) => ({ name: m.name, format: m.format })), ...others],
      // Prompt-side copies — the budget ladder pops these; validation below
      // keeps the full lists
      tagCandidates: [...tagCandidates],
      groupCandidates: [...groupCandidates],
    }
    const suggestName = pkg.state === 'draft'
    const requireGroup = pkg.groups.length === 0 && groupCandidates.length > 0
    const phase2Content = this.fitDatasetToBudget(materials)
    const phase2Args = {
      system: buildDatasetSystemPrompt(opts.locale, { suggestName, requireGroup }),
      jsonSchema: { name: 'suggest_metadata', schema: buildDatasetOutputJsonSchema(suggestName) },
      outputSchema: datasetLlmOutputSchema,
      maxTokens: SUGGEST_DATASET_MAX_TOKENS,
      // The integration gets its reserved slot even when Phase 1 ate the budget
      deadlineAt: Math.max(deadlineAt, Date.now() + SUGGEST_PHASE2_RESERVE_MS),
      opts,
    }
    let output = await this.completeJson(phase2Content, phase2Args)

    // Tags and groups are additions-only: the current sets are always kept,
    // so adopting a suggestion can never remove an existing value
    const currentTags = pkg.tags.map((t) => t.name)
    const currentGroups = pkg.groups.map((g) => g.name)
    let groups = selectGroups(output.groups, groupCandidates, currentGroups)
    if (requireGroup && groups.length === 0) {
      // The required first category is best-effort: regenerate once, then
      // accept — an otherwise usable suggestion beats a hard failure
      this.log.warn(
        { component: 'suggest', model: opts.model, rawGroups: output.groups },
        'required category missing, regenerating the integration'
      )
      try {
        const retry = await this.completeJson(phase2Content, phase2Args)
        const retryGroups = selectGroups(retry.groups, groupCandidates, currentGroups)
        if (retryGroups.length > 0) {
          output = retry
          groups = retryGroups
        }
      } catch {
        // Out of budget or provider failure — keep the first output
      }
    }
    const suggestion: MetadataSuggestion = {
      title: output.title.trim().slice(0, MAX_TITLE_LENGTH),
      notes: output.notes.trim().slice(0, MAX_NOTES_LENGTH),
      tags: this.selectTags(output.tags, tagCandidates, currentTags),
      groups,
      resources: resourceSuggestions.map(({ id, name, description }) => ({
        id,
        name,
        description,
      })),
    }
    if (output.groups.length > 0 && suggestion.groups.length === currentGroups.length) {
      // Discards are otherwise invisible — surface them to tell "the model
      // picked nothing" apart from "the picks didn't resolve to a candidate"
      this.log.warn(
        { component: 'suggest', model: opts.model, rawGroups: output.groups },
        'suggested groups discarded: no candidate match'
      )
    }
    if (suggestName && output.name) {
      const name = await this.resolveUniqueName(output.name, pkg.id)
      if (name) suggestion.name = name
    }

    // used = described resources whose content actually loaded and whose
    // completion succeeded — their material shaped the suggestion
    const hasContent = (r: ResourceMaterial) =>
      r.schema !== null ||
      (r.sampleRows?.length ?? 0) > 0 ||
      Boolean(r.textHead) ||
      (r.fileList?.length ?? 0) > 0
    const usedResources = succeeded.filter((r) => hasContent(r.material)).map((r) => r.material.id)
    const used = new Set(usedResources)
    const skippedResources = pkg.resources.map((r) => r.id).filter((id) => !used.has(id))

    this.log.info(
      {
        component: 'suggest',
        packageId: pkg.id,
        model: opts.model,
        resourceCompletions: described.length,
        failedResources: failed.length,
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
   * SUGGEST_MAX_RESOURCES, each given its own completion) and `others`
   * (resources beyond the cap, kept as lightweight name/format context for
   * the dataset fields only). Every described resource gets a slot regardless
   * of format so the LLM can name it; content-eligible ones (pipeline
   * complete + CSV/TSV, text, document with a text-head artifact, or ZIP with
   * a manifest) additionally carry a column schema + sample rows, head text,
   * or a file listing and are ordered first so their material always keeps a
   * slot.
   */
  private async collectMaterials(
    pkg: SuggestPackageDetail,
    user: AuthUser
  ): Promise<{
    described: ResourceMaterial[]
    others: { name: string | null; format: string | null }[]
  }> {
    const resourceIds = pkg.resources.map((r) => r.id)
    // The live-object pointers are read here rather than carried on the package
    // detail: they are internal (ADR-043) and the detail is a serialized shape.
    const [pipelineRows, liveKeyRows] = pkg.resources.length
      ? await Promise.all([
          this.db
            .select({
              resourceId: resourcePipeline.resourceId,
              status: resourcePipeline.status,
              previewKey: resourcePipeline.previewKey,
              metadata: resourcePipeline.metadata,
            })
            .from(resourcePipeline)
            .where(inArray(resourcePipeline.resourceId, resourceIds)),
          this.db
            .select({ id: resource.id, storageKey: resource.storageKey })
            .from(resource)
            .where(inArray(resource.id, resourceIds)),
        ])
      : [[], []]
    const pipelines = new Map(pipelineRows.map((row) => [row.resourceId, row]))
    const liveKeys = new Map(liveKeyRows.map((row) => [row.id, row.storageKey]))

    // Documents require the Index step's text-head artifact (ADR-040 addendum)
    // and ZIPs their Extract-step manifest; requiring the pipeline record also
    // guards against a key left over from a previous format
    const contentKind = (r: SuggestPackageDetail['resources'][number]) => {
      const pipeline = pipelines.get(r.id)
      if (pipeline?.status !== 'complete') return null
      if (isCsvFormat(r.format, r.mimetype)) return 'tabular'
      // Text is read from the live object; the others from pipeline artifacts.
      if (isTextFormat(r.format)) return liveKeys.get(r.id) ? 'text' : null
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
            material.textHead = await this.readTextHead(liveKeys.get(resource.id)!, {
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

    // Beyond the cap: name/format context for the dataset fields only
    const others = pkg.resources
      .filter((r) => !describedIds.has(r.id))
      .map((r) => ({
        name: r.name?.slice(0, MAX_MATERIAL_NAME_CHARS) ?? null,
        format: r.format?.slice(0, MAX_MATERIAL_NAME_CHARS) ?? null,
      }))

    return { described, others }
  }

  /**
   * Phase 1 completion for one resource. Returns null (degrading the resource
   * to lightweight context) on provider failure, persistent invalid JSON, or
   * an all-blank result — one resource must not fail the whole suggestion.
   */
  private async generateResource(
    material: ResourceMaterial,
    system: string,
    opts: SuggestOptions,
    deadlineAt: number
  ): Promise<{ name: string; description: string } | null> {
    // A completion launched past the deadline would only run into the proxy
    // timeout — degrade the resource to context and keep the response bounded
    const phase1DeadlineAt = deadlineAt - SUGGEST_PHASE2_RESERVE_MS
    if (phase1DeadlineAt - Date.now() < SUGGEST_MIN_CALL_MS) {
      this.log.warn(
        { component: 'suggest', resourceId: material.id },
        'resource completion skipped: request deadline reached'
      )
      return null
    }
    try {
      const output = await this.completeJson(this.fitResourceToBudget(material), {
        system,
        jsonSchema: { name: 'suggest_resource', schema: RESOURCE_OUTPUT_JSON_SCHEMA },
        outputSchema: resourceLlmOutputSchema,
        maxTokens: SUGGEST_RESOURCE_MAX_TOKENS,
        deadlineAt: phase1DeadlineAt,
        opts,
      })
      const name = output.name.trim().slice(0, MAX_MATERIAL_NAME_CHARS)
      const description = output.description.trim().slice(0, MAX_DESCRIPTION_LENGTH)
      if (!name && !description) return null
      return { name, description }
    } catch (error) {
      this.log.warn(
        { component: 'suggest', resourceId: material.id, model: opts.model, err: error },
        'resource suggestion failed'
      )
      return null
    }
  }

  /**
   * One LLM completion returning validated JSON. Throttled calls (Bedrock
   * ThrottlingException / HTTP 429 — expected when resource completions run
   * concurrently) retry with backoff; other provider failures fail fast.
   * Parsing gets one retry because local models occasionally emit invalid
   * JSON despite the provider's grammar enforcement.
   */
  private async completeJson<T>(content: string, args: CompleteJsonArgs<T>): Promise<T> {
    let jsonRetried = false
    let throttleRetries = 0
    for (;;) {
      // Retries must not extend past the deadline — recheck every attempt
      const remaining = args.deadlineAt - Date.now()
      if (remaining < SUGGEST_MIN_CALL_MS) {
        throw new ServiceUnavailableError('AI suggestion ran out of time')
      }
      let raw: string
      try {
        raw = await this.ai.complete(content, {
          system: args.system,
          model: args.opts.model,
          maxTokens: args.maxTokens,
          timeoutMs: Math.min(SUGGEST_TIMEOUT_MS, remaining),
          jsonSchema: args.jsonSchema,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (isThrottleError(message) && throttleRetries < SUGGEST_THROTTLE_BACKOFF_MS.length) {
          this.log.warn(
            { component: 'suggest', model: args.opts.model, throttleRetries },
            'completion throttled, backing off'
          )
          await sleep(SUGGEST_THROTTLE_BACKOFF_MS[throttleRetries++])
          continue
        }
        // Other provider failures (model missing, timeout) won't improve on retry
        throw new ServiceUnavailableError(`AI suggestion failed: ${message}`)
      }

      try {
        const parsed = args.outputSchema.safeParse(JSON.parse(raw))
        if (parsed.success) return parsed.data as T
      } catch {
        // fall through to retry
      }
      this.log.warn(
        { component: 'suggest', model: args.opts.model, retried: jsonRetried },
        'LLM returned invalid JSON'
      )
      if (jsonRetried) throw new ServiceUnavailableError('AI suggestion returned invalid JSON')
      jsonRetried = true
    }
  }

  /**
   * Serialize one resource's material, shrinking it until it fits
   * SUGGEST_RESOURCE_PROMPT_BYTES. In order of increasing damage: textHead
   * halved then dropped, sample rows, file list, schema. With the material
   * clamps in place this rarely fires (encoding growth on text-heavy files).
   */
  private fitResourceToBudget(material: ResourceMaterial): string {
    const over = () =>
      Buffer.byteLength(buildResourceUserContent(material)) > SUGGEST_RESOURCE_PROMPT_BYTES
    while (over()) {
      if (material.textHead && material.textHead.length > 1024) {
        material.textHead = material.textHead.slice(0, Math.floor(material.textHead.length / 2))
      } else if (material.textHead) {
        material.textHead = null
      } else if (material.sampleRows?.length) {
        material.sampleRows = null
      } else if (material.fileList?.length) {
        material.fileList = null
        material.fileCount = null
      } else if (material.schema) {
        material.schema = null
      } else {
        break
      }
    }
    const content = buildResourceUserContent(material)
    // Unreachable with the material clamps in place — fail loud over silently
    // shipping an oversized prompt if a clamp is ever missed
    if (Buffer.byteLength(content) > SUGGEST_RESOURCE_PROMPT_BYTES) {
      throw new ValidationError('Suggestion material could not be reduced to fit the prompt budget')
    }
    return content
  }

  /**
   * Serialize the integration material, shrinking until it fits
   * SUGGEST_DATASET_PROMPT_BYTES: drop lightweight `others` context from the
   * tail, then shorten the generated descriptions. The input is generated
   * text plus candidates, so with the length clamps this rarely fires.
   */
  private fitDatasetToBudget(materials: DatasetMaterials): string {
    const over = () =>
      Buffer.byteLength(buildDatasetUserContent(materials)) > SUGGEST_DATASET_PROMPT_BYTES
    while (over() && materials.others.length) materials.others.pop()
    // Candidate tails are the least valuable context (tags are usage-ordered)
    while (over() && materials.groupCandidates.length) materials.groupCandidates.pop()
    while (over() && materials.tagCandidates.length) materials.tagCandidates.pop()
    if (over()) {
      for (const r of materials.resources) {
        r.description = r.description.slice(0, TRIMMED_DESCRIPTION_CHARS)
      }
    }
    const total = materials.resources.length
    while (over() && materials.resources.length > 1) materials.resources.pop()
    if (materials.resources.length < total) {
      this.log.warn(
        { component: 'suggest', droppedResources: total - materials.resources.length },
        'generated descriptions dropped to fit prompt budget'
      )
    }
    const content = buildDatasetUserContent(materials)
    if (Buffer.byteLength(content) > SUGGEST_DATASET_PROMPT_BYTES) {
      throw new ValidationError('Suggestion material could not be reduced to fit the prompt budget')
    }
    return content
  }

  /** Category candidates (closed list): the SUGGEST_GROUP_CANDIDATES
   *  most-used groups, usage-ordered in SQL so the cap and the budget ladder
   *  deterministically drop the least-used first. Titles/descriptions are
   *  unbounded free text and get clamped */
  private async fetchGroupCandidates() {
    const { items } = await new GroupService(this.db).list({
      limit: SUGGEST_GROUP_CANDIDATES,
      orderBy: 'datasetCount',
    })
    return items.map((g) => ({
      name: g.name,
      title: g.title?.slice(0, MAX_MATERIAL_NAME_CHARS) ?? null,
      ...(g.description && {
        description: g.description.slice(0, MAX_MATERIAL_NAME_CHARS),
      }),
    }))
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
  private async readTextHead(storageKey: string, source: { format: string; metadata: unknown }) {
    const { stream } = await this.storage.downloadRange(storageKey, 0, SUGGEST_TEXT_HEAD_BYTES - 1)
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

  /** Enforce the tag contracts the LLM schema cannot: current tags always
   *  kept, additions deduped, ≤2 new, ≤5 total (caps gate additions only) */
  private selectTags(
    rawTags: string[],
    tagCandidates: string[],
    currentTags: string[]
  ): SuggestedTag[] {
    const candidates = new Set(tagCandidates)
    const seen = new Set<string>()
    const tags: SuggestedTag[] = []
    for (const name of currentTags) {
      if (seen.has(name)) continue
      seen.add(name)
      tags.push({ name, isNew: false })
    }
    let newTags = 0
    for (const raw of rawTags) {
      if (tags.length >= MAX_TAGS) break
      const name = raw.trim().slice(0, MAX_TAG_LENGTH)
      if (!name || seen.has(name)) continue
      const isNew = !candidates.has(name)
      if (isNew && newTags >= MAX_NEW_TAGS) continue
      seen.add(name)
      if (isNew) newTags++
      tags.push({ name, isNew })
    }
    return tags
  }

  /**
   * Normalize the generated slug into a valid unique package name, or null
   * when it cannot be salvaged (the suggestion then simply omits `name`).
   */
  private async resolveUniqueName(raw: string, packageId: string): Promise<string | null> {
    const base = normalizeSlug(raw)
    if (!base) return null
    // Leave room for a collision suffix within the length limit
    const stem = base.slice(0, PACKAGE_NAME_MAX_LENGTH - 3).replace(/[-._]+$/, '')
    const candidates = [
      base,
      ...Array.from({ length: NAME_SUFFIX_ATTEMPTS }, (_, i) => `${stem}-${i + 2}`),
    ]
    // One round-trip for all candidates; names taken by this package don't count
    const rows = await this.db
      .select({ id: packageTable.id, name: packageTable.name })
      .from(packageTable)
      .where(inArray(packageTable.name, candidates))
    const taken = new Set(rows.filter((r) => r.id !== packageId).map((r) => r.name))
    return candidates.find((c) => !taken.has(c)) ?? null
  }
}

/** Current memberships are always kept; picks add to them and are valid only
 *  when they resolve to a candidate group. The MAX_GROUPS cap gates additions
 *  only. Small models sometimes echo the human-readable title instead of the
 *  name — accept a title too, but only when it is unambiguous (titles are not
 *  unique) and does not shadow another group's name. */
function selectGroups(
  rawGroups: string[],
  groupCandidates: { name: string; title: string | null }[],
  currentGroups: string[]
): string[] {
  const byKey = new Map<string, string>()
  const byTitle = new Map<string, string | null>() // null = ambiguous
  for (const g of groupCandidates) {
    byKey.set(g.name, g.name)
    if (g.title) byTitle.set(g.title, byTitle.has(g.title) ? null : g.name)
  }
  for (const [title, name] of byTitle) {
    if (name && !byKey.has(title)) byKey.set(title, name)
  }
  const groups = [...new Set(currentGroups)]
  for (const raw of rawGroups) {
    if (groups.length >= MAX_GROUPS) break
    const name = byKey.get(raw.trim())
    if (name && !groups.includes(name)) groups.push(name)
  }
  return groups
}

/** Lowercase ASCII slug per the package.name contract, or null if unsalvageable */
function normalizeSlug(raw: string): string | null {
  const slug = raw
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, PACKAGE_NAME_MAX_LENGTH)
    .replace(/^[-._]+|[-._]+$/g, '')
  return isValidPackageName(slug) ? slug : null
}

/** Global-setTimeout sleep so fake timers can drive the backoff in tests
 *  (node:timers/promises binds the real timer implementation) */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Throttling is the one provider failure worth retrying — expected under
 *  concurrent resource completions (Bedrock ThrottlingException, HTTP 429) */
function isThrottleError(message: string): boolean {
  return /throttl|too many requests|rate.?limit|\b429\b/i.test(message)
}

/** Run `fn` over `items` with at most `limit` in flight (order preserved) */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = next++
        if (index >= items.length) return
        results[index] = await fn(items[index])
      }
    })
  )
  return results
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
