// Packs are imported on their own (`@kukan/vocabulary/packs/jp`): a code table
// is hundreds of kilobytes, and loading the core must not load a country's
export type * from './types'
export { LEVELS } from './types'
export { RULES_VERSION, createRegistry } from './registry'
export type { Hit, IndexedScheme, Registry } from './registry'
export {
  INFERENCE_RULES,
  corroborate,
  inferColumn,
  judgeColumn,
  judgeNamesByCodes,
  matchValues,
  nameSchemes,
  outranks,
  summarizeCodes,
  verdictOf,
} from './infer'
export type {
  CodeSummary,
  ColumnContext,
  ColumnInference,
  ColumnVerdict,
  RepresentationMatch,
  SettledVerdict,
} from './infer'
export { registryFor } from './catalog'
export { PACK_IDS, PACK_ID_PATTERN, isPackId } from './pack-ids'
export type { PackId } from './pack-ids'
