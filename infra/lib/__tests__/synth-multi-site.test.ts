/**
 * Synth tests for the multi-site shape (ADR-041): SharedStack + SiteStack × N.
 * The single-site golden snapshots (synth-single-site.test.ts) must stay
 * untouched by anything asserted here — that is the drift guard between the
 * two shapes.
 */

import { describe, it, expect } from 'vitest'
import { Match } from 'aws-cdk-lib/assertions'
import type * as cdk from 'aws-cdk-lib'
import { validateSites, type EnvironmentConfig } from '../config.js'
import { normalize, stackTemplate, synthStage, TEST_ACCOUNT } from './helpers/synth.js'

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
      RoleName: 'kukan_citya',
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

  it('orders site stacks behind the shared stack with a canary first', () => {
    const stacks = Object.fromEntries(
      ['KukanSharedStack', 'KukanSiteStackCitya', 'KukanSiteStackCityb'].map((id) => [
        id,
        stage.node.findChild(id) as cdk.Stack,
      ])
    )
    const deps = (s: cdk.Stack) => s.dependencies.map((d) => d.node.id)
    expect(deps(stacks.KukanSiteStackCitya)).toContain('KukanSharedStack')
    expect(deps(stacks.KukanSiteStackCityb)).toContain('KukanSharedStack')
    expect(deps(stacks.KukanSiteStackCityb)).toContain('KukanSiteStackCitya')
  })
})

describe('validateSites', () => {
  const base = { account: TEST_ACCOUNT }

  it('rejects invalid names, duplicates, and the reserved name', () => {
    expect(() => validateSites({ ...base, sites: [{ name: 'City-A' }] })).toThrow(/must match/)
    expect(() =>
      validateSites({ ...base, sites: [{ name: 'a1', enableWaf: false }, { name: 'a1' }] })
    ).toThrow(/Duplicate/)
    expect(() => validateSites({ ...base, sites: [{ name: 'shared' }] })).toThrow(/reserved/)
  })

  it('requires per-site cert/WAF ARNs', () => {
    expect(() =>
      validateSites({ ...base, sites: [{ name: 'citya', domainName: 'a.example.jp' }] })
    ).toThrow(/certificateArn/)
    expect(() => validateSites({ ...base, sites: [{ name: 'citya' }] })).toThrow(/webAclArn/)
  })

  it('enforces the shared-database connection budget', () => {
    // medium preset: 60 worst-case connections per site (10×5 web + 5×2 worker);
    // maxACU 2 → ~450 estimated max_connections, 70% ≈ 315
    const site = (name: string) => ({ name, enableWaf: false })
    const sitesOf = (n: number) => Array.from({ length: n }, (_, i) => site(`s${i + 1}`))

    expect(() => validateSites({ ...base, scale: 'medium', sites: sitesOf(8) })).toThrow(
      /480.*exceed the estimated max_connections \(450\)/
    )

    expect(validateSites({ ...base, scale: 'medium', sites: sitesOf(6) })).toContain('exceed 70%')

    expect(validateSites({ ...base, scale: 'medium', sites: sitesOf(2) })).toBeUndefined()

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
    ).toBeUndefined()
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
    ).toBeUndefined()
    expect(() =>
      validateSites({
        ...base,
        sites: [{ name: 'citya', enableWaf: false, overrides: { backup: { awsBackup: false } } }],
      })
    ).toThrow(/awsBackup/)
  })
})
