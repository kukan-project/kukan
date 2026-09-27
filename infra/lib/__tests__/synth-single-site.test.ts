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
import { Annotations, Match, type Template } from 'aws-cdk-lib/assertions'
import { CDN_LOG_BUCKET, normalize, stackOf, stackTemplate, synthStage } from './helpers/synth.js'
import { validateEcrImageRetention } from '../config.js'
import { supportsLegacyCdnLogging } from '../constructs/access-log.js'

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
    template.hasResourceProperties('AWS::ServiceDiscovery::PrivateDnsNamespace', {
      Name: 'kukan-dev.internal',
    })
    template.hasResourceProperties('AWS::ServiceDiscovery::Service', { Name: 'kukan-dev-worker' })
    template.hasResourceProperties('AWS::ECS::Cluster', { ClusterName: 'kukan-dev' })
    template.hasResourceProperties('AWS::ECS::Service', { ServiceName: 'kukan-dev-web' })
    template.hasResourceProperties('AWS::ECS::Service', { ServiceName: 'kukan-dev-worker' })
    template.hasResourceProperties('AWS::RDS::DBInstance', { DBInstanceIdentifier: 'kukan-dev' })
  })

  it('wakes the worker by its name in the namespace, with no queue beside it (ADR-058)', () => {
    template.resourceCountIs('AWS::SQS::Queue', 0)
    // The worker signals its own tasks as well as the web does
    for (const container of ['Web', 'Worker']) {
      expectContainerEnv(template, container, {
        WORKER_WAKE_URL: 'http://kukan-dev-worker.kukan-dev.internal:8080/wake',
      })
    }
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      FromPort: 8080,
      ToPort: 8080,
      Description: 'Web wake',
    })
  })

  it('puts the retention rule on the bootstrap container-assets repository', () => {
    // The SDK call payload is an Fn::Join because the repository name is a token.
    template.hasResourceProperties('Custom::KukanEcrAssetRetention', {
      Update: {
        'Fn::Join': [
          '',
          Match.arrayWith([
            {
              'Fn::Sub': [
                'cdk-${Qualifier}-container-assets-${AWS::AccountId}-${AWS::Region}',
                { Qualifier: 'hnb659fds' },
              ],
            },
            Match.stringLikeRegexp('countNumber.*:100.*ecr-asset-retention:100:bootstrap-'),
            { Ref: 'BootstrapVersion' },
          ]),
        ],
      },
    })
  })

  it('logs to the site log bucket without cookies, expiring after 90 days by default', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Logging: { Bucket: CDN_LOG_BUCKET, IncludeCookies: false },
      }),
    })
    expectLogExpiration(template, 90)
  })

  it('makes the logs queryable from Athena without a pasted DDL', () => {
    template.hasResourceProperties('AWS::Glue::Database', {
      DatabaseInput: { Name: 'kukan_dev_logs' },
    })
    template.hasResourceProperties('AWS::Glue::Table', {
      DatabaseName: 'kukan_dev_logs',
      TableInput: Match.objectLike({
        Name: 'cloudfront',
        StorageDescriptor: Match.objectLike({
          Location: {
            'Fn::Join': [
              '',
              ['s3://', { Ref: Match.stringLikeRegexp('^CDNAccessLogBucket') }, '/'],
            ],
          },
        }),
      }),
    })
    template.hasResourceProperties('AWS::Athena::WorkGroup', {
      Name: 'kukan-dev-logs',
      WorkGroupConfiguration: Match.objectLike({
        ManagedQueryResultsConfiguration: { Enabled: true },
      }),
    })
  })
})

describe('typical (medium / aurora / OpenSearch / bedrock defaults)', () => {
  const stage = synthStage({ scale: 'medium' })
  const template = stackTemplate(stage, 'KukanStack')

  it('matches the golden template', () => {
    expect(normalize(template)).toMatchSnapshot()
  })

  it('scales the worker on the waiting jobs it reports (ADR-058 §4)', () => {
    expectContainerEnv(template, 'Worker', { WORKER_METRIC_SITE: 'kukan-dev' })
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'KUKAN/Worker',
      MetricName: 'JobsWaiting',
      Dimensions: [{ Name: 'Site', Value: 'kukan-dev' }],
      Statistic: 'Maximum',
    })
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
    nameSiteInUserAgent: true,
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

describe('ecrImageRetention', () => {
  it('rejects a non-positive count at synth', () => {
    expect(() => synthStage({ ecrImageRetention: 0 })).toThrow(/ecrImageRetention must be/)
  })

  it('rejects environments that share a bootstrap repository but disagree on the count', () => {
    expect(() =>
      validateEcrImageRetention({
        dev: { account: '123456789012', ecrImageRetention: 100 },
        prd: { account: '123456789012', ecrImageRetention: 300 },
      })
    ).toThrow(/differs between "dev" \(100\) and "prd" \(300\)/)
  })

  it('allows different counts in different regions or accounts', () => {
    expect(() =>
      validateEcrImageRetention({
        dev: { account: '123456789012', ecrImageRetention: 100 },
        prd: { account: '123456789012', region: 'us-west-2', ecrImageRetention: 300 },
        other: { account: '210987654321', ecrImageRetention: 50 },
      })
    ).not.toThrow()
  })
})

/** The site's log bucket, expiring after `days`. */
function expectLogExpiration(template: Template, days: number): void {
  template.hasResourceProperties('AWS::S3::Bucket', {
    OwnershipControls: { Rules: [{ ObjectOwnership: 'ObjectWriter' }] },
    LifecycleConfiguration: {
      Rules: [{ Id: 'ExpireAccessLogs', ExpirationInDays: days, Status: 'Enabled' }],
    },
  })
}

describe('CloudFront access logs', () => {
  it('takes the retention from cdnLogRetentionDays', () => {
    expectLogExpiration(stackTemplate(synthStage({ cdnLogRetentionDays: 30 }), 'KukanStack'), 30)
  })

  it('goes without logs in an opt-in region, where legacy logging cannot deliver', () => {
    const stage = synthStage({ region: 'af-south-1' })
    const template = stackTemplate(stage, 'KukanStack')
    template.resourceCountIs('AWS::Glue::Table', 0)
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ Logging: Match.absent() }),
    })
    Annotations.fromStack(stackOf(stage, 'KukanStack')).hasWarning(
      '*',
      Match.stringLikeRegexp('access logs are off.*af-south-1')
    )
  })

  it('treats a region CDK does not know as opt-in', () => {
    expect(supportsLegacyCdnLogging('ap-northeast-1')).toBe(true)
    expect(supportsLegacyCdnLogging('xx-new-1')).toBe(false)
  })

  it('rejects a non-positive retention at synth', () => {
    expect(() => synthStage({ cdnLogRetentionDays: 0 })).toThrow(/cdnLogRetentionDays must be/)
  })
})

/**
 * Assert a container's environment: a string is the value it must have,
 * `undefined` that the variable must be absent.
 */
function expectContainerEnv(
  template: Template,
  container: string,
  expected: Record<string, string | undefined>
) {
  const defs = Object.values(template.findResources('AWS::ECS::TaskDefinition')).flatMap(
    (r) =>
      (
        r as {
          Properties: {
            ContainerDefinitions: {
              Name: string
              Environment?: { Name: string; Value: unknown }[]
            }[]
          }
        }
      ).Properties.ContainerDefinitions
  )
  const env = defs.find((d) => d.Name === container)?.Environment ?? []
  for (const [name, value] of Object.entries(expected)) {
    expect(env.find((e) => e.Name === name)?.Value, name).toEqual(value)
  }
}
