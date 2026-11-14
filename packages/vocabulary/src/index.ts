// Packs are imported on their own (`@kukan/vocabulary/packs/jp`): a code table
// is hundreds of kilobytes, and loading the core must not load a country's
export type * from './types'
export { LEVELS } from './types'
export { RULES_VERSION, createRegistry } from './registry'
export type { Hit, IndexedScheme, Registry } from './registry'
export { INFERENCE_RULES, inferColumn, matchValues, summarizeCodes } from './infer'
export type { CodeSummary, ColumnInference, RepresentationMatch } from './infer'
