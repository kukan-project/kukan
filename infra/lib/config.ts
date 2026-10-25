/**
 * KUKAN CDK Configuration
 * Scale-based defaults for small / medium / large deployments,
 * resolved against a per-environment definition (see config/environments.ts, ADR-031).
 *
 * The entry point: the parts live in config/ (types, scale presets, multi-site
 * validation, the CloudFront edge, loading). Forks import the types from this
 * path in their config/environments.ts, so it stays where it is.
 */

export type * from './config/types.js'
export { RDS_DEFAULT_INSTANCE_CLASS, rdsInstanceClass } from './config/scale.js'
export {
  DEFAULT_DEPLOY_CONCURRENCY,
  DERIVED_ALB_PRIORITY_MAX,
  DERIVED_ALB_PRIORITY_MIN,
  MAX_SITES_PER_ENVIRONMENT,
  deployWaves,
  resolveAlbPriority,
  resolveDeployConcurrency,
  resolveSiteConfig,
  validateSites,
  type SiteWarning,
} from './config/sites.js'
export {
  needsGlobalStack,
  needsManagedCert,
  needsManagedWaf,
  rejectBlankEdgeArns,
  resolveEnableWaf,
} from './config/edge.js'
export {
  DEFAULT_BEDROCK_EMBEDDING_MODEL,
  DEFAULT_CDN_LOG_RETENTION_DAYS,
  DEFAULT_CPU_ARCHITECTURE,
  DEFAULT_ECR_IMAGE_RETENTION,
  DEFAULT_REGION,
  assertPipelineAccount,
  loadConfig,
  resolveCpuArchitecture,
  resolveEcrImageRetention,
  resolveEnv,
  validateEcrImageRetention,
  validateEnvironmentNames,
} from './config/load.js'
