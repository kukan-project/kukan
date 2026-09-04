/**
 * Synth tests for the multi-site shape (ADR-041): SharedStack + SiteStack × N.
 * The single-site golden snapshots (synth-single-site.test.ts) must stay
 * untouched by anything asserted here — that is the drift guard between the
 * two shapes.
 */

import { describe, it, expect } from 'vitest'
import { Match, Template } from 'aws-cdk-lib/assertions'
import * as cdk from 'aws-cdk-lib'
import {
  assertPipelineAccount,
  resolveSiteConfig,
  validateSites,
  type EnvironmentConfig,
  type SiteConfig,
} from '../config.js'
import { KukanPipelineStack } from '../pipeline-stack.js'
import {
  normalize,
  stackTemplate,
  synthStage,
  testApp,
  TEST_ACCOUNT,
  TEST_REGION,
} from './helpers/synth.js'

const MULTI_SITE: Omit<EnvironmentConfig, 'account'> = {
  scale: 'medium',
  sites: [
    {
      name: 'citya',
      domainName: 'catalog.city-a.example.jp',
      hostedZoneId: 'Z0000000000000000000',
      hostedZoneName: 'city-a.example.jp',
      certificateArn: `arn:aws:acm:us-east-1:${TEST_ACCOUNT}:certificate/00000000-0000-0000-0000-000000000000`,
      webAclArn: `arn:aws:wafv2:us-east-1:${TEST_ACCOUNT}:global/webacl/kukan/00000000-0000-0000-0000-000000000000`,
      enableGa4DataApi: true,
    },
    { name: 'cityb', enableWaf: false },
  ],
}

describe('multi-site (medium / aurora / OpenSearch / 2 sites)', () => {
  const stage = synthStage(MULTI_SITE)
  const shared = stackTemplate(stage, 'KukanSharedStack')
  const siteA = stackTemplate(stage, 'KukanSiteStackCitya')
  const siteB = stackTemplate(stage, 'KukanSiteStackCityb')

  it('matches the golden shared template', () => {
    expect(normalize(shared)).toMatchSnapshot()
  })

  it('matches the golden site templates', () => {
    expect(normalize(siteA)).toMatchSnapshot()
    expect(normalize(siteB)).toMatchSnapshot()
  })

  it('keeps shared boxes on env-level names', () => {
    shared.hasResourceProperties('AWS::RDS::DBCluster', { DBClusterIdentifier: 'kukan-dev' })
    shared.hasResourceProperties('AWS::OpenSearchService::Domain', {
      DomainName: 'kukan-dev-search',
    })
    shared.hasResourceProperties('AWS::ECS::Cluster', { ClusterName: 'kukan-dev' })
  })

  it('publishes the shared surface as SSM parameters', () => {
    for (const suffix of [
      'vpc/id',
      'vpc/azs',
      'vpc/public-subnet-ids',
      'vpc/isolated-subnet-ids',
      'sg/alb',
      'sg/web',
      'sg/worker',
      'sg/db-access',
      'ecs/cluster-name',
      'db/endpoint',
      'db/port',
      'db/master-secret-arn',
      'search/endpoint',
    ]) {
      shared.hasResourceProperties('AWS::SSM::Parameter', {
        Name: `/kukan/dev/shared/${suffix}`,
      })
    }
  })

  it('extends physical names with the site segment', () => {
    siteA.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'kukan-dev-citya-pipeline' })
    siteA.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'kukan-dev-citya-pipeline-dlq' })
    siteA.hasResourceProperties('AWS::ECS::Service', { ServiceName: 'kukan-dev-citya-web' })
    siteA.hasResourceProperties('AWS::ECS::Service', { ServiceName: 'kukan-dev-citya-worker' })
    siteB.hasResourceProperties('AWS::ECS::Service', { ServiceName: 'kukan-dev-cityb-web' })
  })

  it('wires per-site database and index prefix into the containers', () => {
    for (const [template, site] of [
      [siteA, 'citya'],
      [siteB, 'cityb'],
    ] as const) {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Environment: Match.arrayWith([
              { Name: 'POSTGRES_DB', Value: `kukan_${site}` },
              { Name: 'OPENSEARCH_INDEX_PREFIX', Value: `kukan-dev-${site}` },
            ]),
          }),
        ]),
      })
    }
  })

  it('creates the site database custom resource', () => {
    siteA.hasResourceProperties('Custom::KukanSiteDatabase', {
      DbName: 'kukan_citya',
    })
  })

  it('uses no CloudFormation exports between stacks', () => {
    for (const template of [shared, siteA, siteB]) {
      const outputs = (template.toJSON() as { Outputs?: Record<string, { Export?: unknown }> })
        .Outputs
      for (const [key, output] of Object.entries(outputs ?? {})) {
        expect(output.Export, `Output ${key} must not be exported`).toBeUndefined()
      }
    }
  })

  it('deploys serially: shared → canary site → remaining sites', () => {
    const stacks = Object.fromEntries(
      ['KukanSharedStack', 'KukanSiteStackCitya', 'KukanSiteStackCityb'].map((id) => [
        id,
        stage.node.findChild(id) as cdk.Stack,
      ])
    )
    const deps = (s: cdk.Stack) => s.dependencies.map((d) => d.node.id)
    // A chain, not a fan-out — the connection budget assumes at most one site
    // runs a rolling update at a time
    expect(deps(stacks.KukanSiteStackCitya)).toEqual(['KukanSharedStack'])
    expect(deps(stacks.KukanSiteStackCityb)).toEqual(['KukanSiteStackCitya'])
  })
})

describe('multi-site global stack (auto-created cert/WAF, standalone mode)', () => {
  // citya: cert to create (hosted zone, no ARN) + default-on WAF without an ARN
  // cityb: no domain, default-on WAF → shares the auto-created ACL
  const stage = synthStage({
    scale: 'medium',
    sites: [
      {
        name: 'citya',
        domainName: 'catalog.city-a.example.jp',
        hostedZoneId: 'Z0000000000000000000',
        hostedZoneName: 'city-a.example.jp',
      },
      { name: 'cityb' },
    ],
  })
  const global = stackTemplate(stage, 'KukanGlobalStack')

  it('matches the golden global template', () => {
    expect(normalize(global)).toMatchSnapshot()
  })

  it('creates one cert per site domain and a single shared WebACL', () => {
    global.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'catalog.city-a.example.jp',
    })
    global.resourceCountIs('AWS::CertificateManager::Certificate', 1)
    global.resourceCountIs('AWS::WAFv2::WebACL', 1)
  })

  it('exports the created ARNs as outputs for pipeline-mode pasting', () => {
    global.hasOutput('CertificateArnCitya', {})
    global.hasOutput('WebAclArn', {})
  })

  it('retains cert/WAF so an external-ARN switchover never deletes in-use resources', () => {
    // Metadata forces the DeletionPolicy change to be a recognized update
    global.hasResource('AWS::CertificateManager::Certificate', {
      DeletionPolicy: 'Retain',
      Metadata: { 'kukan:retain': Match.anyValue() },
    })
    global.hasResource('AWS::WAFv2::WebACL', {
      DeletionPolicy: 'Retain',
      Metadata: { 'kukan:retain': Match.anyValue() },
    })
  })

  it('deploys the global stack before the canary site', () => {
    const canary = stage.node.findChild('KukanSiteStackCitya') as cdk.Stack
    expect(canary.dependencies.map((d) => d.node.id)).toEqual(
      expect.arrayContaining(['KukanSharedStack', 'KukanGlobalStack'])
    )
  })
})

describe('multi-site AWS Backup (large preset)', () => {
  const stage = synthStage({
    scale: 'large',
    sites: [
      { name: 'citya', enableWaf: false },
      { name: 'cityb', enableWaf: false },
    ],
  })
  const shared = stackTemplate(stage, 'KukanSharedStack')
  const siteA = stackTemplate(stage, 'KukanSiteStackCitya')

  it('backs up the shared database once, in the shared stack', () => {
    shared.hasResourceProperties('AWS::Backup::BackupVault', {
      BackupVaultName: 'kukan-dev-backup',
    })
    shared.resourceCountIs('AWS::Backup::BackupSelection', 1)
  })

  it('backs up each site bucket in its own site-scoped vault', () => {
    siteA.hasResourceProperties('AWS::Backup::BackupVault', {
      BackupVaultName: 'kukan-dev-citya-backup',
    })
    siteA.resourceCountIs('AWS::Backup::BackupSelection', 1)
  })
})

describe('pipeline mode', () => {
  const OTHER_ACCOUNT = '210987654321'

  /** One env, one site — the smallest environment a pipeline can be built from. */
  const pipelineStack = (site: SiteConfig, targetAccount = TEST_ACCOUNT, app = testApp()) =>
    new KukanPipelineStack(app, 'KukanPipeline', {
      env: { account: TEST_ACCOUNT, region: TEST_REGION },
      connectionArn: `arn:aws:codeconnections:${TEST_REGION}:${TEST_ACCOUNT}:connection/x`,
      environments: {
        dev: { account: targetAccount, githubRepo: 'example/kukan', sites: [site] },
      },
    })

  it('rejects multi-site environments that need the global stack', () => {
    expect(() => pipelineStack({ name: 'main' })).toThrow(
      /pipeline mode cannot create the us-east-1 ACM certificate \/ WAF/
    )
  })

  it('rejects a pipeline account that differs from the active credentials', () => {
    expect(() => assertPipelineAccount(OTHER_ACCOUNT, TEST_ACCOUNT)).toThrow(
      /Pipeline account mismatch/
    )
    expect(() => assertPipelineAccount(undefined, TEST_ACCOUNT)).not.toThrow()
  })

  it('gives a cross-account target CMK-encrypted artifacts, and a same-account one none', () => {
    // Building the pipeline synthesizes its stages; nothing here asserts on the
    // Lambda bundles, and skipping them is ~400 ms of esbuild per app
    const keys = (targetAccount: string) =>
      Template.fromStack(
        pipelineStack(
          { name: 'main', enableWaf: false },
          targetAccount,
          testApp({ 'aws:cdk:bundling-stacks': [] })
        )
      )
    keys(OTHER_ACCOUNT).resourceCountIs('AWS::KMS::Key', 1)
    keys(TEST_ACCOUNT).resourceCountIs('AWS::KMS::Key', 0)
  })
})

describe('validateSites', () => {
  const base = { account: TEST_ACCOUNT }
  const messages = (env: EnvironmentConfig) =>
    validateSites(env)
      .map((w) => w.message)
      .join('\n')

  it('rejects an empty sites array (it would silently deploy the single-site shape)', () => {
    expect(() => validateSites({ ...base, sites: [] })).toThrow(/declared but empty/)
    // The stage runs the check before choosing a shape
    expect(() => synthStage({ sites: [] })).toThrow(/declared but empty/)
  })

  it('rejects invalid names, duplicates, and the reserved name', () => {
    expect(() => validateSites({ ...base, sites: [{ name: 'City-A' }] })).toThrow(/must match/)
    expect(() =>
      validateSites({ ...base, sites: [{ name: 'a1', enableWaf: false }, { name: 'a1' }] })
    ).toThrow(/Duplicate/)
    expect(() => validateSites({ ...base, sites: [{ name: 'shared' }] })).toThrow(/reserved/)
  })

  it('requires the hosted zone when the certificate is to be auto-created', () => {
    expect(() =>
      validateSites({ ...base, sites: [{ name: 'citya', domainName: 'a.example.jp' }] })
    ).toThrow(/hostedZone/)
    // Hosted zone present → the global stack creates the cert; ARN → nothing to create
    expect(
      validateSites({
        ...base,
        sites: [
          {
            name: 'citya',
            domainName: 'a.example.jp',
            hostedZoneId: 'Z0000000000000000000',
            hostedZoneName: 'example.jp',
            enableWaf: false,
          },
        ],
      })
    ).toEqual([])
    // Missing webAclArn is fine too — the global stack creates a shared ACL
    expect(validateSites({ ...base, sites: [{ name: 'citya' }] })).toEqual([])
  })

  it('rejects blank cert/WAF ARNs (missing for needsGlobalStack, supplied for wiring)', () => {
    expect(() =>
      validateSites({ ...base, sites: [{ name: 'citya', certificateArn: ' ' }] })
    ).toThrow(/blank certificateArn/)
    expect(() => validateSites({ ...base, sites: [{ name: 'citya', webAclArn: '' }] })).toThrow(
      /blank webAclArn/
    )
  })

  it('warns about a burstable shared OpenSearch from the second site on', () => {
    const sites = [
      { name: 'citya', enableWaf: false },
      { name: 'cityb', enableWaf: false },
    ]
    expect(messages({ ...base, sites })).toContain('t3.small.search')
    expect(validateSites({ ...base, sites: [sites[0]] })).toEqual([])
    expect(validateSites({ ...base, enableOpenSearch: false, sites })).toEqual([])
    expect(validateSites({ ...base, scale: 'medium', sites })).toEqual([])
  })

  it('enforces the shared-database connection budget', () => {
    // medium preset: 60 worst-case connections per site (10×5 web + 5×2 worker),
    // plus one site's rolling-update doubling (+60); maxACU 2 → 400 estimated
    // max_connections (documented-anchor interpolation), 70% = 280
    const site = (name: string) => ({ name, enableWaf: false })
    const sitesOf = (n: number) => Array.from({ length: n }, (_, i) => site(`s${i + 1}`))

    expect(() => validateSites({ ...base, scale: 'medium', sites: sitesOf(8) })).toThrow(
      /480.*exceed the estimated max_connections \(400\)/
    )

    // large preset (250 worst-case/site): the raw memory formula said ~1802 and
    // let 7 sites (1750) pass with a warning — the AWS-documented 8-ACU value
    // is 1669, so this must fail
    expect(() => validateSites({ ...base, scale: 'large', sites: sitesOf(7) })).toThrow(
      /1750.*exceed the estimated max_connections \(1669\)/
    )

    // PostgreSQL caps max_connections at 2,000 when minACU is 0 or 0.5.
    // 34 sites (2,100 required) fit the uncapped 16-ACU estimate (3,360) —
    // only minAcu needs to change
    expect(() =>
      validateSites({
        ...base,
        scale: 'medium',
        overrides: { db: { maxAcu: 16 } },
        sites: sitesOf(34),
      })
    ).toThrow(/2040.*\(2000\).*raise db\.minAcu to 1 or higher(?!.*AND db\.maxAcu)/)

    // Boundary: 33 sites on maxAcu 8 need 2,040 — above the uncapped 8-ACU
    // estimate (1,669) AND above the 2,000 minACU cap, so raising maxAcu
    // alone would just hit the cap: both knobs must move
    expect(() =>
      validateSites({
        ...base,
        scale: 'medium',
        overrides: { db: { maxAcu: 8 } },
        sites: sitesOf(33),
      })
    ).toThrow(/raise db\.minAcu to 1 or higher.*AND db\.maxAcu/)

    // Boundary: 60 sites on maxAcu 16 need 3,660 — uncapping via minAcu is
    // not enough (16 ACU tops out at 3,360), so both knobs must move
    expect(() =>
      validateSites({
        ...base,
        scale: 'medium',
        overrides: { db: { maxAcu: 16 } },
        sites: sitesOf(60),
      })
    ).toThrow(/AND db\.maxAcu \(the current maxAcu tops out at 3360 connections\)/)

    // Beyond the Aurora PostgreSQL absolute ceiling (5,000) no ACU setting
    // helps — the remedy must not suggest one (medium 84 sites need 5,100)
    const overCeiling = () =>
      validateSites({
        ...base,
        scale: 'medium',
        overrides: { db: { minAcu: 1, maxAcu: 32 } },
        sites: sitesOf(84),
      })
    expect(overCeiling).toThrow(/Aurora PostgreSQL tops out at 5000/)
    expect(overCeiling).toThrow(/split the sites/)
    try {
      overCeiling()
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message).not.toMatch(/raise db\.(min|max)Acu/)
    }

    // 6 sites: steady 360 + rolling 60 = 420 > 400 — the rolling component tips it over
    expect(() => validateSites({ ...base, scale: 'medium', sites: sitesOf(6) })).toThrow(
      /420 — steady 360/
    )

    expect(messages({ ...base, scale: 'medium', sites: sitesOf(5) })).toContain('exceed 70%')

    // Warning advice targets ceil(worstCase / 0.7), not the hard limit:
    // 29 sites need 1,800/2,000 (capped) — clearing 70% needs 2,572, which the
    // 0.5-minACU cap blocks regardless of maxAcu → advise minAcu, not maxAcu
    const cappedWarning = messages({
      ...base,
      scale: 'medium',
      overrides: { db: { maxAcu: 16 } },
      sites: sitesOf(29),
    })
    expect(cappedWarning).toContain('raise db.minAcu to 1 or higher')
    expect(cappedWarning).not.toMatch(/AND db\.maxAcu/)

    // 74 sites need 4,500/5,000 — clearing 70% needs 6,429, beyond the Aurora
    // absolute ceiling → no ACU advice at all
    const ceilingWarning = messages({
      ...base,
      scale: 'medium',
      overrides: { db: { minAcu: 1, maxAcu: 32 } },
      sites: sitesOf(74),
    })
    expect(ceilingWarning).toContain('Aurora PostgreSQL tops out at 5000')
    expect(ceilingWarning).not.toMatch(/raise db\.(min|max)Acu/)

    expect(validateSites({ ...base, scale: 'medium', sites: sitesOf(2) })).toEqual([])

    // Site-level pool overrides relax the budget
    expect(
      validateSites({
        ...base,
        scale: 'medium',
        sites: sitesOf(8).map((s) => ({
          ...s,
          overrides: { dbPool: { webMax: 5 }, web: { maxSize: 2 } },
        })),
      })
    ).toEqual([])
  })

  it('rejects site-scoped fields on the environment entry and per-site AWS Backup', () => {
    expect(() =>
      validateSites({ ...base, domainName: 'x.example.jp', sites: [{ name: 'citya' }] })
    ).toThrow(/domainName per site/)
    // Security gates must never be silently discarded
    expect(() =>
      validateSites({
        ...base,
        allowedIpRanges: ['203.0.113.0/24'],
        basicAuth: { username: 'u', password: 'p' },
        sites: [{ name: 'citya', enableWaf: false }],
      })
    ).toThrow(/allowedIpRanges\/basicAuth per site/)
    expect(() =>
      validateSites({ ...base, enableWaf: false, sites: [{ name: 'citya', enableWaf: false }] })
    ).toThrow(/enableWaf per site/)
    // overrides stays allowed at env level (deep-merged under site overrides)
    expect(
      validateSites({
        ...base,
        overrides: { dbPool: { webMax: 5 } },
        sites: [{ name: 'citya', enableWaf: false }],
      })
    ).toEqual([])
    // Untypeable via SiteConfig (tsx strips types, so the runtime gate matters)
    const forcedOverride = (overrides: object): SiteConfig['overrides'] =>
      overrides as SiteConfig['overrides']
    const withOverrides = (overrides: object): EnvironmentConfig => ({
      ...base,
      sites: [{ name: 'citya', enableWaf: false, overrides: forcedOverride(overrides) }],
    })
    expect(() => validateSites(withOverrides({ backup: { awsBackup: false } }))).toThrow(
      /awsBackup/
    )
    expect(() => validateSites(withOverrides({ backup: { dbBackupRetentionDays: 35 } }))).toThrow(
      /dbBackupRetentionDays/
    )
    // Shared-box sections would be silently ignored by the shared stacks while
    // still skewing the connection budget — allow-list, not deny-list
    expect(() => validateSites(withOverrides({ db: { maxAcu: 16 } }))).toThrow(
      /must not override db/
    )
    expect(() => validateSites(withOverrides({ opensearch: { instanceCount: 2 } }))).toThrow(
      /must not override opensearch/
    )
  })

  it('ignores site-scoped CLI context when resolving a site (no cross-site stamping)', () => {
    const app = new cdk.App({
      context: { domainName: 'ctx.example.jp', bucketName: 'ctx-bucket', enableWaf: false },
    })
    const config = resolveSiteConfig(app, { ...base }, { name: 'citya', enableWaf: false })
    expect(config.domainName).toBeUndefined()
    expect(config.bucketName).toBeUndefined()
    // Shared-box context (scale/dbEngine/enableOpenSearch) still applies
    const scaled = resolveSiteConfig(
      new cdk.App({ context: { scale: 'medium' } }),
      { ...base },
      { name: 'citya', enableWaf: false }
    )
    expect(scaled.scale).toBe('medium')
  })
})
