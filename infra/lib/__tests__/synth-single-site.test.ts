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
import { Match } from 'aws-cdk-lib/assertions'
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

  it('exports the created ARNs as outputs for pipeline-mode pasting', () => {
    const template = stackTemplate(stage, 'KukanGlobalStack')
    template.hasOutput('CertificateArn', {})
    template.hasOutput('WebAclArn', {})
  })

  it('retains cert/WAF so an external-ARN switchover never deletes in-use resources', () => {
    const template = stackTemplate(stage, 'KukanGlobalStack')
    // Metadata forces the DeletionPolicy change to be a recognized update
    // (CloudFormation skips DeletionPolicy/Outputs-only diffs) so upgrading an
    // existing stack actually persists RETAIN
    template.hasResource('AWS::CertificateManager::Certificate', {
      DeletionPolicy: 'Retain',
      Metadata: { 'kukan:retain': Match.anyValue() },
    })
    template.hasResource('AWS::WAFv2::WebACL', {
      DeletionPolicy: 'Retain',
      Metadata: { 'kukan:retain': Match.anyValue() },
    })
  })
})

describe('half-supplied edge ARNs (create only the missing side)', () => {
  const CERT_ARN =
    'arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000'
  const WAF_ARN =
    'arn:aws:wafv2:us-east-1:123456789012:global/webacl/kukan/00000000-0000-0000-0000-000000000000'
  const domain = {
    domainName: 'data.example.jp',
    hostedZoneId: 'Z0000000000000000000',
    hostedZoneName: 'example.jp',
  }

  it('cert supplied → only the WAF is created', () => {
    const template = stackTemplate(
      synthStage({ ...domain, certificateArn: CERT_ARN }),
      'KukanGlobalStack'
    )
    template.resourceCountIs('AWS::CertificateManager::Certificate', 0)
    template.resourceCountIs('AWS::WAFv2::WebACL', 1)
  })

  it('WAF supplied → only the certificate is created', () => {
    const template = stackTemplate(
      synthStage({ ...domain, webAclArn: WAF_ARN }),
      'KukanGlobalStack'
    )
    template.resourceCountIs('AWS::CertificateManager::Certificate', 1)
    template.resourceCountIs('AWS::WAFv2::WebACL', 0)
  })
})

describe('blank edge ARNs', () => {
  it('rejects a blank certificateArn at synth', () => {
    expect(() => synthStage({ domainName: 'data.example.jp', certificateArn: '' })).toThrow(
      /blank certificateArn/
    )
  })
})
