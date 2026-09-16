/**
 * Reading a resource's material out of storage and the pipeline's artifacts.
 *
 * Shared by the suggestion flow (ADR-040) and the abstract the pipeline writes
 * (ADR-053): both answer "what is in this file" from the same four places, and
 * a second copy of that answer would drift from this one.
 *
 * Never the search index — its content leg is a no-op on the PostgreSQL
 * fallback (ADR-021), so material read from it would be empty on exactly the
 * deployments that have no other source.
 */

import type { Readable } from 'node:stream'
import type { Database } from '@kukan/db'
import type { StorageAdapter } from '@kukan/storage-adapter'
import {
  isCsvFormat,
  isTextFormat,
  isDocumentFormat,
  isZipFormat,
  type Logger,
  type ResourceSchema,
  type ZipManifest,
} from '@kukan/shared'
import {
  detectEncoding,
  bufferToUtf8,
  stripTrailingReplacementChar,
} from '@kukan/shared/encoding-node'
import { QueryService } from '../query-service'
import { parseResourceSchema } from '../pipeline-service'
import type { AuthUser } from '../../auth/permissions'
import {
  SUGGEST_TEXT_HEAD_BYTES,
  SUGGEST_ZIP_MANIFEST_ENTRIES,
  SUGGEST_ZIP_MANIFEST_MAX_BYTES,
  SUGGEST_SAMPLE_ROWS,
  SUGGEST_SAMPLE_CELL_CHARS,
} from '../../config'

/** Longest path kept from a ZIP listing — entry paths are unbounded free text */
const MAX_PATH_CHARS = 200

export interface MaterialDeps {
  db: Database
  storage: StorageAdapter
  log: Logger
}

/** What the row says about itself, as both callers already have it */
export interface MaterialResource {
  id: string
  format: string | null
  mimetype?: string | null
}

/** Where the derived material lives, from `resource_pipeline` and the row */
export interface MaterialArtifacts {
  pipelineStatus: string | null
  previewKey: string | null
  pipelineMetadata: unknown
  /** The object holding the live content, null when nothing is stored */
  liveStorageKey: string | null
}

export type MaterialKind = 'tabular' | 'text' | 'document' | 'zip'

/**
 * Which of the four materials this resource has, or null.
 *
 * Documents need the Index step's text-head artifact (ADR-040 addendum) and
 * ZIPs their Interpret-step manifest.
 *
 * **Whether the run that produced them has finished is the caller's question,
 * not this one's.** A suggestion is asked for from outside any run and wants a
 * settled row; the pipeline's own Summarize step reads the artifacts the run it
 * is part of has just written, and at that moment the row still says
 * `processing`. Deciding it here made the second caller see no material at all
 * for every table, text file and archive it ran on.
 */
export function materialKind(
  resource: MaterialResource,
  artifacts: MaterialArtifacts
): MaterialKind | null {
  if (isCsvFormat(resource.format, resource.mimetype ?? null)) return 'tabular'
  // Text is read from the live object; the others from pipeline artifacts.
  if (isTextFormat(resource.format)) return artifacts.liveStorageKey ? 'text' : null
  if (isDocumentFormat(resource.format) && textHeadKeyOf(artifacts.pipelineMetadata)) {
    return 'document'
  }
  if (isZipFormat(resource.format) && artifacts.previewKey) return 'zip'
  return null
}

/** The material itself — the subset of a prompt's fields that comes from content */
export interface LoadedMaterial {
  schema: ResourceSchema | null
  sampleRows: Record<string, unknown>[] | null
  textHead: string | null
  fileList: string[] | null
  fileCount: number | null
}

export const EMPTY_MATERIAL: LoadedMaterial = {
  schema: null,
  sampleRows: null,
  textHead: null,
  fileList: null,
  fileCount: null,
}

/**
 * Read one resource's material. Throws what the read threw — both callers treat
 * material as best-effort, but they record the failure differently. The one
 * exception is the sample rows, which are an enhancement rather than a source;
 * see the `tabular` branch.
 *
 * `user` scopes the sample-row read to what that caller may see. The pipeline
 * passes none: it summarizes public resources only, so anonymous visibility is
 * exactly the set it is allowed to send to a provider.
 */
export async function loadMaterial(
  kind: MaterialKind,
  resource: MaterialResource,
  artifacts: MaterialArtifacts,
  deps: MaterialDeps,
  user?: AuthUser
): Promise<LoadedMaterial> {
  switch (kind) {
    case 'tabular': {
      // Sample rows enhance the schema; they are not the material. The query
      // path refuses a resource with no preview, and that is a fact about the
      // resource rather than a failure of this read — so losing them must not
      // cost the schema as well. It must also not reach the caller: the
      // suggestion degrades the whole resource to its metadata, and the
      // pipeline step fails its job, which has the queue retry the same package
      // for ever.
      const sampleRows = await readSampleRows(resource.id, deps, user).catch((err) => {
        deps.log.warn(
          { component: 'material', resourceId: resource.id, err },
          'sample rows unavailable; using the schema alone'
        )
        return null
      })
      return {
        ...EMPTY_MATERIAL,
        schema: parseResourceSchema(artifacts.pipelineMetadata),
        sampleRows,
      }
    }
    case 'text':
      return {
        ...EMPTY_MATERIAL,
        textHead: await readTextHead(artifacts.liveStorageKey!, deps, {
          format: resource.format ?? '',
          metadata: artifacts.pipelineMetadata,
        }),
      }
    case 'document':
      return {
        ...EMPTY_MATERIAL,
        textHead: await readArtifactTextHead(textHeadKeyOf(artifacts.pipelineMetadata)!, deps),
      }
    case 'zip': {
      const manifest = await readZipFileList(artifacts.previewKey!, deps)
      return { ...EMPTY_MATERIAL, ...manifest }
    }
  }
}

/** `metadata.textHeadKey` persisted by the Index step (document formats, ADR-040) */
export function textHeadKeyOf(metadata: unknown): string | null {
  const key = (metadata as { textHeadKey?: unknown } | null | undefined)?.textHeadKey
  return typeof key === 'string' && key ? key : null
}

/** First rows of the preview Parquet via the sandboxed query path (ADR-032) */
export async function readSampleRows(
  resourceId: string,
  deps: MaterialDeps,
  user?: AuthUser
): Promise<Record<string, unknown>[]> {
  const result = await new QueryService(deps.db, deps.storage, deps.log).query(
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
export async function readTextHead(
  storageKey: string,
  deps: MaterialDeps,
  source: { format: string; metadata: unknown }
): Promise<string> {
  const { stream } = await deps.storage.downloadRange(storageKey, 0, SUGGEST_TEXT_HEAD_BYTES - 1)
  const buffer = await readAll(stream)
  // Prefer the encoding the Interpret step detected on the full file; only
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
export async function readArtifactTextHead(
  textHeadKey: string,
  deps: MaterialDeps
): Promise<string> {
  const { stream } = await deps.storage.downloadRange(textHeadKey, 0, SUGGEST_TEXT_HEAD_BYTES - 1)
  const buffer = await readAll(stream)
  return stripTrailingReplacementChar(buffer.toString('utf-8'))
}

/**
 * Whether this head is the whole of what was extracted, or where the budget
 * ran out.
 *
 * It decides what a ratio taken over the head can mean. Capped, the head
 * measures {@link SUGGEST_TEXT_HEAD_BYTES} and nothing about the document:
 * 16KB of Japanese over a 467-page yearbook reads as 11 characters a page
 * whatever the file holds, and that one held 1,034 (ADR-053 §3.6).
 *
 * The slack is one UTF-8 character: the range is cut on a byte boundary and
 * {@link stripTrailingReplacementChar} takes off whatever that split.
 */
export function textHeadWasCapped(text: string): boolean {
  return Buffer.byteLength(text, 'utf-8') >= SUGGEST_TEXT_HEAD_BYTES - 4
}

/** File paths from the Interpret step's ZIP manifest, capped by entry count.
 *  The read is byte-capped: entry paths are attacker-controlled, so the
 *  manifest can be made arbitrarily large despite the worker's entry cap */
export async function readZipFileList(
  previewKey: string,
  deps: MaterialDeps
): Promise<{ fileList: string[]; fileCount: number }> {
  const buffer = await readAll(
    await deps.storage.download(previewKey),
    SUGGEST_ZIP_MANIFEST_MAX_BYTES
  )
  const manifest = JSON.parse(buffer.toString('utf-8')) as ZipManifest
  const fileList = (manifest.entries ?? [])
    .filter((entry) => !entry.isDirectory)
    .slice(0, SUGGEST_ZIP_MANIFEST_ENTRIES)
    .map((entry) => entry.path.slice(0, MAX_PATH_CHARS))
  return { fileList, fileCount: manifest.totalFiles ?? fileList.length }
}

export async function readAll(stream: Readable, maxBytes = Infinity): Promise<Buffer> {
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
