/**
 * KUKAN Pipeline Type Definitions (shared between API and Worker)
 */

export type PipelineStatus = 'pending' | 'queued' | 'processing' | 'complete' | 'error'

export type PipelineStepStatus = 'pending' | 'running' | 'complete' | 'error' | 'skipped'

export type PipelineStepName = 'fetch' | 'extract'

export const PIPELINE_JOB_TYPE = 'resource-pipeline' as const
