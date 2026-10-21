/**
 * The shapes of an environment entry (config/environments.ts, ADR-031), a site
 * entry (ADR-041), and the fully resolved configuration the stacks consume.
 */

export type Scale = 'small' | 'medium' | 'large'

export type DbEngine = 'rds' | 'aurora'

/** CPU architecture the web and worker run on (Fargate) and their images are built for. */
export type CpuArchitecture = 'x86_64' | 'arm64'

/** RDS certificate authorities that can sign the database's server certificate. */
export const RDS_CA_CERTIFICATES = [
  'rds-ca-rsa2048-g1',
  'rds-ca-rsa4096-g1',
  'rds-ca-ecc384-g1',
] as const
export type RdsCaCertificate = (typeof RDS_CA_CERTIFICATES)[number]

/** Bedrock embedding for semantic search (ADR-034). Presence enables it. */
export interface BedrockConfig {
  /** Bedrock API region. Omit → the deployment region. */
  region?: string
  /** Embedding model ID. Omit → Titan Text Embeddings v2. */
  embeddingModel?: string
  /** Embedding dimensions. Omit → adapter default (1024). */
  embeddingDimensions?: number
  /** Cosine similarity floor override. Omit → the model's golden-set-measured
   *  recommendation, held by the AI adapter (Titan 0.15 / Cohere 0.3). */
  vectorMinSimilarity?: number
  /** Completion models the task role may invoke (ADR-040); also the admin
   *  model-picker options. Omit → the default Haiku 5.5 profile. Changing needs redeploy. */
  completionModels?: string[]
  /** Model that writes the AI resource abstracts (ADR-053), and by its absence
   *  the switch that leaves them off. Must be one of `completionModels` — the
   *  allow-list is the IAM grant, so anything else is refused at synth rather
   *  than leaving the worker to log abstracts off after the deploy. */
  summaryModel?: string
}

/** Sections computed from `scale`. These are overridable per environment via `overrides`. */
export interface ScaleComputed {
  web: {
    cpu: number // vCPU units (1024 = 1 vCPU)
    memory: number // MB
    minSize: number
    maxSize: number
  }
  worker: {
    cpu: number
    memory: number
    minTasks: number
    maxTasks: number
    healthPort: number
  }
  db: {
    engine: DbEngine
    // RDS
    instanceClass?: string
    // Aurora Serverless v2
    minAcu?: number
    maxAcu?: number
    // Common
    multiAz: boolean
  }
  opensearch: {
    instanceType: string
    instanceCount: number
    volumeSize: number // GB
    multiAz: boolean
    /** Number of index replicas. Must be < instanceCount. */
    indexReplicas: number
  }
  dbPool: {
    webMax: number
    workerMax: number
  }
  backup: {
    /** S3 versioning (delete/overwrite protection; required for AWS Backup on S3). ADR-037. */
    s3Versioning: boolean
    /** Days to keep noncurrent object versions (bounds versioning storage cost). */
    s3NoncurrentVersionExpirationDays: number
    /** RDS/Aurora automated backup retention = PITR window, days (1–35). */
    dbBackupRetentionDays: number
    /** AWS Backup plan (isolated vault, daily/monthly snapshots). false = disabled.
     *  The vault (kukan-<env>-backup) is RETAINed on disable; delete it manually
     *  once empty before re-enabling (ADR-037). */
    awsBackup: false | { dailyRetentionDays: number; monthlyRetentionMonths: number }
  }
}

/** Recursive partial — used for `overrides` (fine-grained tuning on top of a scale preset). */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

/**
 * One entry per environment in `config/environments.ts` (ADR-031).
 * Only `account` is required (misdeployment guard); other fields fall back to
 * scale defaults / built-in defaults.
 */
export interface EnvironmentConfig {
  /**
   * Target AWS account ID. **Required** — pinning it makes CDK refuse to deploy when the
   * active credentials are for a different account, preventing accidental deploys to the
   * wrong account. Set it equal to your login account for same-account operation.
   */
  account: string
  /** Target region. Omit → ap-northeast-1. */
  region?: string
  scale?: Scale
  dbEngine?: DbEngine
  enableOpenSearch?: boolean
  /**
   * CPU architecture of the web and worker tasks. The images are built for it
   * wherever the deploy runs: the pipeline publishes them on a CodeBuild of the
   * same architecture, and a standalone deploy from a machine of the other one
   * builds the image's own stages under QEMU (Docker Desktop provides it).
   * Omit → arm64 (Graviton, about 20% less per vCPU and GB than x86_64).
   */
  cpuArchitecture?: CpuArchitecture
  /**
   * Certificate authority of the database's server certificate, which the web
   * and worker verify against the RDS CA bundle in their images. Named rather
   * than left to the account's default, which `modify-certificates` can change.
   * Omit → rds-ca-rsa2048-g1, the one offered in every Region (the other two
   * are not, e.g. in Mumbai or Zurich).
   */
  rdsCaCertificate?: RdsCaCertificate
  // --- Site-scoped fields, enableWaf through timeZone (ADR-041) ---
  // Legacy single-site placement, kept for compatibility: without `sites` they
  // apply to the environment's one site; with `sites` declared they are
  // rejected at synth (validateSites) — declare them per site instead.
  enableWaf?: boolean
  /** Non-empty: omit it to leave the site open (checked again at synth). */
  allowedIpRanges?: [string, ...string[]]
  /**
   * Basic auth edge gate (CF Function), OR-combined with `allowedIpRanges`. Light gate
   * only — credentials are embedded (base64) in the readable CF Function source (ADR-027).
   */
  basicAuth?: { username: string; password: string }
  /**
   * Resolve the domain over IPv6 too (an AAAA alias beside the A). Omit → on,
   * except behind `allowedIpRanges`: there a viewer admitted by its IPv4
   * address would come over IPv6 once its network has it, miss the list and
   * get a 403, which browsers do not retry over IPv4. Set it there only once
   * the list holds the IPv6 prefixes of every place it admits.
   */
  enableIpv6Dns?: boolean
  domainName?: string
  hostedZoneId?: string
  hostedZoneName?: string
  /** IANA zone the web prerenders times in (env `TIME_ZONE`). Omit → Asia/Tokyo. */
  timeZone?: string
  /**
   * Pre-created us-east-1 ACM certificate ARN for CloudFront (ADR-030).
   * Supply this in pipeline mode to avoid cross-region references (which are
   * incompatible with CDK Pipelines). Create it once via a standalone
   * `cdk deploy -c env=<name> <Stage>/KukanGlobalStack`, then paste the ARN here.
   */
  certificateArn?: string
  /** Pre-created us-east-1 WAF WebACL ARN for CloudFront (see `certificateArn`). */
  webAclArn?: string
  /** S3 bucket name. Omit → CDK auto-naming (globally unique). */
  bucketName?: string
  enableGa4DataApi?: boolean
  /**
   * Name the site's URL in the worker's User-Agent (USER_AGENT_URL), so the
   * operators of the servers it fetches from can reach this site. Only for a
   * site anyone may visit and search engines may index; rejected at synth on
   * an edge-gated one.
   */
  nameSiteInUserAgent?: boolean
  /**
   * Bedrock embedding for semantic search (ADR-034). Omit → enabled with Titan v2
   * defaults; `false` → AI disabled (AI_TYPE=none). No console setup needed —
   * serverless foundation models auto-enable on first invocation; the task-role
   * IAM policy added here is the only access gate.
   * Multi-site environments set the shared default here and adjust it per site
   * (`sites[].bedrock`).
   */
  bedrock?: BedrockConfig | false
  /**
   * Post this environment's deploy outcomes to Slack (ADR-030). Omit → no
   * notification resources are created at all.
   *
   * Pipeline mode only — it reports on the pipeline's executions. The stack
   * creates the secret that holds the webhook; paste the URL into it once and
   * the messages start.
   */
  deployNotification?: boolean
  /** CodeConnections source repository in "owner/repo" form (ADR-030). */
  githubRepo?: string
  /** Branch that deploys this environment (ADR-030). */
  deployBranch?: string
  /** Fine-grained overrides of the scale preset. */
  overrides?: DeepPartial<ScaleComputed>
  /**
   * Sites deployed at once after the canary (ADR-041 wave parallelism). The
   * first site always deploys alone; the rest go this many at a time, each
   * wave waiting for the previous one. The connection budget counts this many
   * sites' rolling-update overlap (minSize new tasks each), so a value that
   * does not fit fails synth (size the database up first — see the table in
   * docs/specs phase4-deploy).
   * Omit → 2; set 1 to serialize. Multi-site only.
   */
  deployConcurrency?: number
  /**
   * Images kept in the CDK bootstrap container-assets repository (newest
   * first); older ones expire. Environments in one account/region share the
   * repository, so give them the same value. Omit → 100.
   */
  ecrImageRetention?: number
  /**
   * Days CloudFront access logs are kept in each site's log bucket before
   * they expire. Applies to every site of the environment. Omit → 90.
   */
  cdnLogRetentionDays?: number
  /**
   * Allow ECS Exec (`aws ecs execute-command`) into the web and worker tasks.
   * A shell there reads the secrets injected as environment variables, and
   * session contents are not logged — CloudTrail records only who opened one,
   * when, and into which task. Turn it on only where operators investigate in
   * place. A deploy changes only the service setting and the task role, not
   * the task definition: tasks running already keep what they started with
   * until replaced (`update-service --force-new-deployment`), while turning
   * it off drops the role's grant and so stops new sessions at once. The
   * default for every site, which `sites[].enableExecuteCommand` overrides.
   * Omit → off.
   */
  enableExecuteCommand?: boolean
  /**
   * Sites hosted by this environment (ADR-041). Presence (non-empty) opts the
   * environment into the SharedStack/SiteStack split; absence keeps the
   * all-in-one KukanStack with unchanged logical IDs. Existing single-site
   * environments migrate blue/green only — never by adding `sites` in place.
   */
  sites?: SiteConfig[]
}

/**
 * One site inside a multi-site environment (ADR-041). Undeclared aspects
 * (scale, dbEngine, enableOpenSearch, …) are shared-box territory and always
 * come from the environment entry.
 */
export interface SiteConfig {
  /**
   * Site key: lowercase alphanumeric, 2–16 chars, no hyphens (used in resource
   * names `kukan-<env>-<site>-*` AND PostgreSQL identifiers `kukan_<site>`).
   */
  name: string
  /**
   * Web image brand (ADR-042): the Docker build arg `KUKAN_BRAND`. Default
   * `'default'` (the `apps/web/brands/default` brand) — omitting it or setting
   * `'default'` are equivalent. Any other value requires a matching
   * `apps/web/brands/<brand>/` (an unknown brand fails the image build).
   */
  brand?: string
  domainName?: string
  hostedZoneId?: string
  hostedZoneName?: string
  timeZone?: string
  /**
   * Pre-created us-east-1 ACM certificate ARN. Omit in standalone mode to have
   * the environment's KukanGlobalStack create one per site domain; pipeline
   * mode requires the ARN (cross-region references are incompatible with CDK
   * Pipelines — same rule as single-site, ADR-030).
   */
  certificateArn?: string
  /** Pre-created us-east-1 WAF WebACL ARN. May be shared by several sites.
   *  Omit in standalone mode to have KukanGlobalStack create one shared ACL. */
  webAclArn?: string
  enableWaf?: boolean
  /** Non-empty: omit it to leave the site open (checked again at synth). */
  allowedIpRanges?: [string, ...string[]]
  basicAuth?: { username: string; password: string }
  /**
   * Resolve the domain over IPv6 too (an AAAA alias beside the A). Omit → on,
   * except behind `allowedIpRanges`: there a viewer admitted by its IPv4
   * address would come over IPv6 once its network has it, miss the list and
   * get a 403, which browsers do not retry over IPv4. Set it there only once
   * the list holds the IPv6 prefixes of every place it admits.
   */
  enableIpv6Dns?: boolean
  /** S3 bucket name. Omit → CDK auto-naming (globally unique). */
  bucketName?: string
  enableGa4DataApi?: boolean
  /**
   * Name the site's URL in the worker's User-Agent (USER_AGENT_URL), so the
   * operators of the servers it fetches from can reach this site. Only for a
   * site anyone may visit and search engines may index; rejected at synth on
   * an edge-gated one.
   */
  nameSiteInUserAgent?: boolean
  /**
   * Listener rule priority on the environment's shared ALB (ADR-049). Omit →
   * derived from the site name (a stable hash in 1000–49999), so removing or
   * reordering sites never renumbers the others. Set it (1–999 — the derived
   * band is reserved, so an explicit value can never collide with one) on the
   * site you are adding when validateSites reports a collision, or to pin an
   * order deliberately. Never move a deployed site's value onto another
   * deployed site's: the live rule still holds it and the deploy fails.
   */
  albPriority?: number
  /**
   * ECS Exec into this site's web and worker tasks — only this site's task
   * roles get the exec channel permissions. Omit → the environment's
   * `enableExecuteCommand` (off unless set there).
   */
  enableExecuteCommand?: boolean
  /**
   * Per-site AI on top of the environment's `bedrock`. An object deep-merges
   * onto it (arrays replace, so `completionModels` is given whole or not at
   * all), which is how one site gets a different `summaryModel` — or none, with
   * `summaryModel: undefined` — while the rest keep the environment's.
   * `false` turns AI off for this site alone. Requires the environment to
   * declare `bedrock` (with AI off there, a per-site entry is rejected: there
   * is no allow-list to override, and each site would need its own).
   */
  bedrock?: BedrockConfig | false
  /**
   * Per-site sizing on top of the environment's scale preset. Only the
   * site-owned sections — db/opensearch sizing belongs to the shared boxes.
   * Of `backup`, only the S3 (site bucket) settings are allowed: DB retention
   * and the AWS Backup schedule are environment-level settings (the DB plan
   * lives in the SharedStack, the per-site bucket plans follow the same
   * schedule — ADR-041). Of `worker`, not the health port: the shared
   * security groups open the environment's to the web (ADR-058).
   */
  overrides?: DeepPartial<Pick<ScaleComputed, 'web' | 'dbPool'>> & {
    worker?: DeepPartial<Omit<ScaleComputed['worker'], 'healthPort'>>
    backup?: Partial<
      Pick<ScaleComputed['backup'], 's3Versioning' | 's3NoncurrentVersionExpirationDays'>
    >
  }
}

/** Fully-resolved configuration consumed by stacks and constructs. */
export interface KukanConfig extends ScaleComputed {
  scale: Scale
  dbEngine: DbEngine
  enableOpenSearch: boolean
  cpuArchitecture: CpuArchitecture
  rdsCaCertificate: RdsCaCertificate
  enableWaf: boolean
  allowedIpRanges?: string[]
  basicAuth?: { username: string; password: string }
  /** Whether the domain has an AAAA alias beside the A. */
  enableIpv6Dns: boolean
  /** Whether the worker's User-Agent carries the site URL (USER_AGENT_URL). */
  nameSiteInUserAgent: boolean
  domainName?: string
  hostedZoneId?: string
  hostedZoneName?: string
  timeZone?: string
  /** undefined → CDK auto-naming (globally unique). */
  bucketName?: string
  enableGa4DataApi: boolean
  /** undefined → AI disabled. `embeddingModel` / `completionModels` are resolved
   *  (never undefined here). */
  bedrock?: BedrockConfig & { embeddingModel: string; completionModels: string[] }
  /** Images kept in the bootstrap container-assets repository (account/region-wide). */
  ecrImageRetention: number
  /** Days CloudFront access logs are kept (lifecycle expiration on the log bucket). */
  cdnLogRetentionDays: number
  /** Whether the web and worker services allow ECS Exec. */
  enableExecuteCommand: boolean
}
