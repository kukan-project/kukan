/**
 * KUKAN Pipeline Type Definitions
 */

import type { Readable } from 'stream'
import type { DatasetDoc } from '@kukan/shared'

/** Minimal resource data needed by pipeline steps */
export interface ResourceForPipeline {
  id: string
  packageId: string
  url: string | null
  urlType: string | null
  format: string | null
  hash: string | null
}

/** Package with its active resources, used for search indexing */
export interface PackageForIndex {
  id: string
  name: string
  title: string | null
  notes: string | null
  ownerOrg: string | null
  resources: Array<{
    id: string
    name: string | null
    description: string | null
    format: string | null
  }>
}

export interface PipelineContext {
  storage: {
    download(key: string): Promise<Readable>
    upload(key: string, body: Buffer | Readable, meta?: Record<string, unknown>): Promise<void>
  }
  search: {
    index(doc: DatasetDoc): Promise<void>
  }
  /** Get an active resource by ID */
  getResource(id: string): Promise<ResourceForPipeline | null>
  /** Update resource hash, size, and lastModified (without touching updated) */
  updateResourceHashAndSize(id: string, meta: { hash: string; size: number }): Promise<void>
  /** Get package with all its active resources for search indexing */
  getPackageForIndex(packageId: string): Promise<PackageForIndex | null>
}

export interface ExtractedData {
  headers: string[]
  rows: string[][]
  encoding: string
}
