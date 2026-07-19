/**
 * Golden synth snapshots for the single-site (all-in-one KukanStack) shape.
 *
 * These snapshots pin the synthesized template of every representative
 * configuration. The ADR-041 multi-site refactor must keep them byte-identical
 * (asset hashes normalized) — a diff here means an existing environment would
 * see a CloudFormation change. Review procedure for legitimate churn
 * (aws-cdk-lib upgrades): run `vitest -u --project infra` and eyeball the diff.
 */

import { describe, it, expect } from 'vitest'
import { normalize, stackTemplate, synthStage } from './helpers/synth.js'

describe('minimal dev (small / rds / no OpenSearch / no AI)', () => {
  const stage = synthStage({
    scale: 'small',
    dbEngine: 'rds',
    enableOpenSearch: false,
    bedrock: false,
  })
  const template = stackTemplate(stage, 'KukanStack')

  it('matches the golden template', () => {
    expect(normalize(template)).toMatchSnapshot()
  })

  it('keeps env-prefixed physical names', () => {
    template.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'kukan-dev-pipeline' })
    template.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'kukan-dev-pipeline-dlq' })
    template.hasResourceProperties('AWS::ECS::Cluster', { ClusterName: 'kukan-dev' })
    template.hasResourceProperties('AWS::ECS::Service', { ServiceName: 'kukan-dev-web' })
    template.hasResourceProperties('AWS::ECS::Service', { ServiceName: 'kukan-dev-worker' })
    template.hasResourceProperties('AWS::RDS::DBInstance', { DBInstanceIdentifier: 'kukan-dev' })
  })
})

describe('typical (medium / aurora / OpenSearch / bedrock defaults)', () => {
  const stage = synthStage({ scale: 'medium' })
  const template = stackTemplate(stage, 'KukanStack')

  it('matches the golden template', () => {
    expect(normalize(template)).toMatchSnapshot()
  })

  it('keeps env-prefixed physical names', () => {
    template.hasResourceProperties('AWS::RDS::DBCluster', { DBClusterIdentifier: 'kukan-dev' })
    template.hasResourceProperties('AWS::OpenSearchService::Domain', {
      DomainName: 'kukan-dev-search',
    })
  })
})

describe('full (large / domain with supplied ARNs / GA4 / AWS Backup)', () => {
  const stage = synthStage({
    scale: 'large',
    domainName: 'data.example.jp',
    hostedZoneId: 'Z0000000000000000000',
    hostedZoneName: 'example.jp',
    certificateArn: `arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000`,
    webAclArn: `arn:aws:wafv2:us-east-1:123456789012:global/webacl/kukan/00000000-0000-0000-0000-000000000000`,
    enableGa4DataApi: true,
  })

  it('matches the golden template', () => {
    expect(normalize(stackTemplate(stage, 'KukanStack'))).toMatchSnapshot()
  })

  it('does not create the global stack when ARNs are supplied', () => {
    expect(stage.node.tryFindChild('KukanGlobalStack')).toBeUndefined()
  })
})

describe('edge-gated (basic auth + IP allowlist, WAF auto-off)', () => {
  const stage = synthStage({
    scale: 'small',
    allowedIpRanges: ['203.0.113.0/24'],
    basicAuth: { username: 'preview', password: 'preview-pass' },
  })

  it('matches the golden template', () => {
    expect(normalize(stackTemplate(stage, 'KukanStack'))).toMatchSnapshot()
  })
})

describe('self-created global stack (domain without certificateArn)', () => {
  const stage = synthStage({
    scale: 'small',
    domainName: 'data.example.jp',
    hostedZoneId: 'Z0000000000000000000',
    hostedZoneName: 'example.jp',
  })

  it('matches the golden main template', () => {
    expect(normalize(stackTemplate(stage, 'KukanStack'))).toMatchSnapshot()
  })

  it('matches the golden global template', () => {
    expect(normalize(stackTemplate(stage, 'KukanGlobalStack'))).toMatchSnapshot()
  })
})
