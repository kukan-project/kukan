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
  DERIVED_ALB_PRIORITY_MAX,
  DERIVED_ALB_PRIORITY_MIN,
  RDS_DEFAULT_INSTANCE_CLASS,
  resolveAlbPriority,
  resolveSiteConfig,
  validateSites,
  type EnvironmentConfig,
  type SiteConfig,
} from '../config.js'
import { pascal } from '../naming.js'
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
      'alb/listener-arn',
      'alb/dns-name',
      'cloudfront/vpc-origin-id',
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

  it('creates one shared ALB with a 404 default action and one VPC origin (ADR-049)', () => {
    shared.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1)
    shared.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internal',
      Type: 'application',
    })
    shared.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      DefaultActions: [
        Match.objectLike({
          Type: 'fixed-response',
          FixedResponseConfig: Match.objectLike({ StatusCode: '404' }),
        }),
      ],
    })
    // The VPC origin must speak what the listener listens on
    shared.hasResourceProperties('AWS::CloudFront::VpcOrigin', {
      VpcOriginEndpointConfig: Match.objectLike({
        HTTPPort: 80,
        OriginProtocolPolicy: 'http-only',
      }),
    })
    shared.resourceCountIs('AWS::CloudFront::VpcOrigin', 1)
  })

  it('attaches each site to the shared ALB by its X-Kukan-Site header (ADR-049)', () => {
    for (const [template, site] of [
      [siteA, 'citya'],
      [siteB, 'cityb'],
    ] as const) {
      // No ALB / VPC origin of its own — the site rides on the shared ones
      template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0)
      template.resourceCountIs('AWS::CloudFront::VpcOrigin', 0)
      template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 1)
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
        Priority: resolveAlbPriority({ name: site }),
        Conditions: [
          {
            Field: 'http-header',
            HttpHeaderConfig: { HttpHeaderName: 'X-Kukan-Site', Values: [`kukan-dev-${site}`] },
          },
        ],
      })
      // The rule is owned by WebService (not the listener import) so it inherits
      // the site-database dependency and its logical id survives import moves
      template.hasResource('AWS::ElasticLoadBalancingV2::ListenerRule', {
        DependsOn: Match.arrayWith([Match.stringLikeRegexp('^SiteDatabase')]),
      })
      expect(
        Object.keys(template.findResources('AWS::ElasticLoadBalancingV2::ListenerRule'))
      ).toEqual([expect.stringMatching(/^WebServiceSiteRule/)])
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          Origins: [
            Match.objectLike({
              OriginCustomHeaders: [
                { HeaderName: 'X-Kukan-Site', HeaderValue: `kukan-dev-${site}` },
              ],
              VpcOriginConfig: Match.objectLike({ VpcOriginId: Match.anyValue() }),
            }),
          ],
        }),
      })
      // The shared ALB's name is the SharedStack's SSM parameter, not N site outputs
      expect(
        (template.toJSON() as { Outputs?: Record<string, unknown> }).Outputs
      ).not.toHaveProperty('AlbDnsName')
    }
  })

  it('pins DesiredCount to the minimum — the budget counts only minSize new tasks', () => {
    // medium preset: web minSize 1, worker minTasks 1. Removing the pin from the
    // service constructs must fail here, not as an accepted snapshot diff
    // (config validateSites relies on it)
    for (const template of [siteA, siteB]) {
      template.hasResourceProperties('AWS::ECS::Service', {
        ServiceName: Match.stringLikeRegexp('-web$'),
        DesiredCount: 1,
      })
      template.hasResourceProperties('AWS::ECS::Service', {
        ServiceName: Match.stringLikeRegexp('-worker$'),
        DesiredCount: 1,
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

  it('deploys shared → canary site → remaining sites', () => {
    const stacks = Object.fromEntries(
      ['KukanSharedStack', 'KukanSiteStackCitya', 'KukanSiteStackCityb'].map((id) => [
        id,
        stage.node.findChild(id) as cdk.Stack,
      ])
    )
    const deps = (s: cdk.Stack) => s.dependencies.map((d) => d.node.id)
    expect(deps(stacks.KukanSiteStackCitya)).toEqual(['KukanSharedStack'])
    expect(deps(stacks.KukanSiteStackCityb)).toEqual(['KukanSiteStackCitya'])
  })

  it('deploys sites after the canary in waves of deployConcurrency', () => {
    const sites = ['s1', 's2', 's3', 's4', 's5'].map((name) => ({ name, enableWaf: false }))
    const depsOf = (concurrency: number | undefined) => {
      // maxAcu 4 gives the budget room for two medium sites rolling at once
      const synthesized = synthStage({
        scale: 'medium',
        overrides: { db: { maxAcu: 4 } },
        sites,
        deployConcurrency: concurrency,
      })
      return Object.fromEntries(
        sites.map(({ name }) => [
          name,
          (synthesized.node.findChild(`KukanSiteStack${pascal(name)}`) as cdk.Stack).dependencies
            .map((d) => d.node.id)
            .sort(),
        ])
      )
    }
    // Default 2: canary alone, then pairs, each waiting for the whole previous wave
    expect(depsOf(undefined)).toEqual({
      s1: ['KukanSharedStack'],
      s2: ['KukanSiteStackS1'],
      s3: ['KukanSiteStackS1'],
      s4: ['KukanSiteStackS2', 'KukanSiteStackS3'],
      s5: ['KukanSiteStackS2', 'KukanSiteStackS3'],
    })
    // 1: the serial chain
    expect(depsOf(1)).toEqual({
      s1: ['KukanSharedStack'],
      s2: ['KukanSiteStackS1'],
      s3: ['KukanSiteStackS2'],
      s4: ['KukanSiteStackS3'],
      s5: ['KukanSiteStackS4'],
    })
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
  // Serial keeps the budget arithmetic below at one site's new tasks; the
  // wave (deployConcurrency) cases are covered separately
  const base = { account: TEST_ACCOUNT, deployConcurrency: 1 }
  const messages = (env: EnvironmentConfig) =>
    validateSites(env)
      .map((w) => w.message)
      .join('\n')
  // Explicit priorities: with many sites the derived hash can collide, which is
  // its own (tested) error and would mask the one under test
  const sitesOf = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      name: `s${i + 1}`,
      enableWaf: false,
      albPriority: i + 1,
    }))

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

  it('counts deployConcurrency sites of rolling-update doubling in the budget', () => {
    // medium: 60 per site at max scale, 15 new-task connections per rolling site
    // (minSize 1 × webMax 10 + minTasks 1 × workerMax 5), maxAcu 2 → 400.
    // 6 sites steady 360: serial (+15) warns, four at a time (+60) exceeds the
    // limit — and says how to serialize
    expect(messages({ ...base, scale: 'medium', sites: sitesOf(6) })).toMatch(
      /375 — steady 360 \+ 1 site's rolling update 15/
    )
    expect(() =>
      validateSites({ ...base, deployConcurrency: 4, scale: 'medium', sites: sitesOf(6) })
    ).toThrow(/420 — steady 360 \+ 4 sites' rolling update 60.*set deployConcurrency: 1/)
    expect(() =>
      validateSites({ account: TEST_ACCOUNT, deployConcurrency: 0, sites: sitesOf(1) })
    ).toThrow(/deployConcurrency must be an integer of 1 or more/)
    expect(() => validateSites({ account: TEST_ACCOUNT, deployConcurrency: 2 })).toThrow(
      /multi-site environments only/
    )
  })

  it('counts at most sites.length - 1 rolling sites (the canary deploys alone)', () => {
    // small: 16 per site + 8 per rolling site on db.t4g.micro (112). 5 sites with
    // K=8: only 4 can roll after the canary → 80 + 32 = 112, at the limit, not over
    const wide = messages({ ...base, deployConcurrency: 8, sites: sitesOf(5) })
    expect(wide).toMatch(/112 — steady 80 \+ 4 sites' rolling update 32/)
    // 2 sites: the canary, then one — never two at once, whatever K says
    expect(() =>
      validateSites({
        ...base,
        deployConcurrency: 2,
        overrides: { dbPool: { webMax: 40 } },
        sites: sitesOf(2),
      })
    ).toThrow(/1 site's rolling update 43/)
  })

  it('estimates RDS max_connections from the instance class memory', () => {
    // small preset: 16 per site + 8 for the rolling one; 7 sites need 120 — over
    // db.t4g.micro's 112, comfortably under db.t4g.small's 225
    expect(() => validateSites({ ...base, sites: sitesOf(7) })).toThrow(
      /exceed the estimated max_connections \(112\).*db\.t4g\.micro allows only ~112/
    )
    expect(
      messages({
        ...base,
        overrides: { db: { instanceClass: 'db.t4g.small' } },
        sites: sitesOf(7),
      })
    ).not.toContain('max_connections')
  })

  it('caps sites per environment at the VPC-origin association quota (ADR-049)', () => {
    expect(() => validateSites({ ...base, sites: sitesOf(51) })).toThrow(
      /51 sites exceed the 50 distributions CloudFront allows on one VPC origin/
    )
    // 50 itself passes this gate (the connection budget is a separate check)
    expect(() => validateSites({ ...base, sites: sitesOf(50) })).not.toThrow(/VPC origin/)
  })

  it('resolves shared-ALB rule priorities stably and rejects collisions (ADR-049)', () => {
    // Pinned vector: changing the hash renumbers every deployed derived rule
    // (a ListenerRule priority update on all site stacks)
    const derived = resolveAlbPriority({ name: 'citya' })
    expect(derived).toBe(46313)
    expect(derived).toBeGreaterThanOrEqual(DERIVED_ALB_PRIORITY_MIN)
    expect(derived).toBeLessThanOrEqual(DERIVED_ALB_PRIORITY_MAX)
    expect(resolveAlbPriority({ name: 'citya', albPriority: 7 })).toBe(7)
    // Explicit values live below the derived band, so the two can never collide
    for (const albPriority of [0, 1.5, DERIVED_ALB_PRIORITY_MIN]) {
      expect(() => validateSites({ ...base, sites: [{ name: 'citya', albPriority }] })).toThrow(
        /albPriority must be an integer in 1–999/
      )
    }
    expect(
      validateSites({
        ...base,
        enableOpenSearch: false,
        sites: [
          { name: 'citya', albPriority: 1 },
          { name: 'cityb', enableWaf: false },
        ],
      })
    ).toEqual([])
    // Two names hashing alike collide; the message points at the site being added
    let twin = ''
    for (let i = 0; twin === ''; i++) {
      const candidate = `x${i.toString(36)}`
      if (resolveAlbPriority({ name: candidate }) === derived) twin = candidate
    }
    expect(() =>
      validateSites({ ...base, sites: [{ name: 'citya' }, { name: twin, enableWaf: false }] })
    ).toThrow(/same shared-ALB listener rule priority 46313 .* on the site you are adding/)
    expect(
      validateSites({
        ...base,
        enableOpenSearch: false,
        sites: [{ name: 'citya' }, { name: twin, albPriority: 2, enableWaf: false }],
      })
    ).toEqual([])
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

    // Boundary: 34 sites on maxAcu 8 need 2,055 — above the uncapped 8-ACU
    // estimate (1,669) AND above the 2,000 minACU cap, so raising maxAcu
    // alone would just hit the cap: both knobs must move
    expect(() =>
      validateSites({
        ...base,
        scale: 'medium',
        overrides: { db: { maxAcu: 8 } },
        sites: sitesOf(34),
      })
    ).toThrow(/raise db\.minAcu to 1 or higher.*AND db\.maxAcu/)

    // The higher bands need more than 50 sites' worth of connections at the
    // preset pools, and 50 is the per-environment site cap (VPC origin quota) —
    // so widen the web pool to 20 (110 worst-case per site) instead
    const wide = { dbPool: { webMax: 20 } }

    // Boundary: 33 wide sites on maxAcu 16 need 3,740 — uncapping via minAcu is
    // not enough (16 ACU tops out at 3,360), so both knobs must move
    expect(() =>
      validateSites({
        ...base,
        scale: 'medium',
        overrides: { ...wide, db: { maxAcu: 16 } },
        sites: sitesOf(33),
      })
    ).toThrow(/AND db\.maxAcu \(the current maxAcu tops out at 3360 connections\)/)

    // Beyond the Aurora PostgreSQL absolute ceiling (5,000) no ACU setting
    // helps — the remedy must not suggest one (46 wide sites need 5,170)
    const overCeiling = () =>
      validateSites({
        ...base,
        scale: 'medium',
        overrides: { ...wide, db: { minAcu: 1, maxAcu: 32 } },
        sites: sitesOf(46),
      })
    expect(overCeiling).toThrow(/Aurora PostgreSQL tops out at 5000/)
    expect(overCeiling).toThrow(/split the sites/)
    try {
      overCeiling()
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message).not.toMatch(/raise db\.(min|max)Acu/)
    }

    // 7 sites: steady 420 + rolling 15 = 435 > 400
    expect(() => validateSites({ ...base, scale: 'medium', sites: sitesOf(7) })).toThrow(
      /435 — steady 420 \+ 1 site's rolling update 15/
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

    // 40 wide sites need 4,510/5,000 — clearing 70% needs 6,443, beyond the
    // Aurora absolute ceiling → no ACU advice at all
    const ceilingWarning = messages({
      ...base,
      scale: 'medium',
      overrides: { ...wide, db: { minAcu: 1, maxAcu: 32 } },
      sites: sitesOf(40),
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

  it('rejects a time zone Intl does not know, at synth', () => {
    const app = new cdk.App()
    expect(() =>
      resolveSiteConfig(
        app,
        { ...base },
        { name: 'citya', enableWaf: false, timeZone: 'Asia/Tokio' }
      )
    ).toThrow(/is not an IANA time zone name/)
    const ok = resolveSiteConfig(
      app,
      { ...base },
      { name: 'citya', enableWaf: false, timeZone: 'Asia/Tokyo' }
    )
    expect(ok.timeZone).toBe('Asia/Tokyo')
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

describe('RDS instance class', () => {
  const shared = (env: Partial<EnvironmentConfig> = {}) =>
    stackTemplate(
      synthStage({ scale: 'small', sites: [{ name: 'aa', enableWaf: false }], ...env }),
      'KukanSharedStack'
    )

  it('creates the instance in the configured class, defaulting to the small preset', () => {
    shared().hasResourceProperties('AWS::RDS::DBInstance', {
      DBInstanceClass: RDS_DEFAULT_INSTANCE_CLASS,
    })
    shared({ overrides: { db: { instanceClass: 'db.t4g.small' } } }).hasResourceProperties(
      'AWS::RDS::DBInstance',
      { DBInstanceClass: 'db.t4g.small' }
    )
    // medium/large presets carry no class — the rds engine falls back to the small one
    shared({ scale: 'medium', dbEngine: 'rds' }).hasResourceProperties('AWS::RDS::DBInstance', {
      DBInstanceClass: RDS_DEFAULT_INSTANCE_CLASS,
    })
  })

  it('rejects classes the connection budget cannot size', () => {
    expect(() => shared({ overrides: { db: { instanceClass: 't4g.small' } } })).toThrow(
      /must look like db\./
    )
    expect(() => shared({ overrides: { db: { instanceClass: 'db.z1d.large' } } })).toThrow(
      /not a known RDS class shape/
    )
    // x generations differ in memory per size, so only the listed ones are sized
    expect(() => shared({ overrides: { db: { instanceClass: 'db.x1e.xlarge' } } })).toThrow(
      /not a known RDS class shape/
    )
  })

  it('sizes memory per family generation (x2g.large is 32 GiB, not 64)', () => {
    // large preset, 250 per site + 60 rolling: 14 sites need 3,560 of the 3,604
    // connections 32 GiB allows — a warning, and the estimate must say 3604
    const sites = Array.from({ length: 14 }, (_, i) => ({ name: `s${i + 1}`, albPriority: i + 1 }))
    const warning = validateSites({
      account: TEST_ACCOUNT,
      scale: 'large',
      dbEngine: 'rds',
      enableOpenSearch: false,
      deployConcurrency: 1,
      overrides: { db: { instanceClass: 'db.x2g.large' } },
      sites,
    })
      .map((w) => w.message)
      .join('\n')
    expect(warning).toMatch(/3560 — steady 3500 .* max_connections \(3604\)/)
    // r doubles the t/m sizes: r6g.large is 16 GiB → 1,802 connections
    expect(() =>
      validateSites({
        account: TEST_ACCOUNT,
        scale: 'large',
        dbEngine: 'rds',
        deployConcurrency: 1,
        overrides: { db: { instanceClass: 'db.r6g.large' } },
        sites,
      })
    ).toThrow(/max_connections \(1802\)/)
  })
})
