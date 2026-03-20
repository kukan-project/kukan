/**
 * KUKAN Pipeline Package
 * Resource processing pipeline: Fetch → Extract → Index
 */

export { processResource } from './process-resource'
export { ResourcePipelineService } from './pipeline-service'
export { isCsvFormat, parseBuffer } from './parsers/csv-parser'
export type { PipelineContext, ExtractedData, ResourceForPipeline, PackageForIndex } from './types'
