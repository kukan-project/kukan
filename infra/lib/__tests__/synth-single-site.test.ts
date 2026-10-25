/**
 * Golden synth snapshots for the single-site (all-in-one KukanStack) shape.
 *
 * These snapshots pin the synthesized template of every representative
 * configuration. The ADR-041 multi-site refactor must keep them byte-identical
 * (asset hashes normalized) — a diff here means an existing environment would
 * see a CloudFormation change. Review procedure for legitimate churn
 * (aws-cdk-lib upgrades): run `vitest -u --project infra` and eyeball the diff.
 */

import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { Annotations, Match, type Template } from 'aws-cdk-lib/assertions'
import * as cxapi from 'aws-cdk-lib/cx-api'
import {
  CDN_LOG_BUCKET,
  execChannelGrants,
  normalize,
  searchSiteRoles,
  stackOf,
  stackTemplate,
  synthStage,
  taskRoleNames,
  TEST_ACCOUNT,
} from './helpers/synth.js'
import { validateEcrImageRetention, validateEnvironmentNames } from '../config.js'
import { taskRoleName } from '../naming.js'
import { supportsLegacyCdnLogging } from '../constructs/access-log.js'
import { POSTGRES_TLS_ENVIRONMENT } from '../constructs/database.js'

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

  it('caches the sitemap and robots.txt for an hour, keyed on nothing the viewer sends', () => {
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: Match.objectLike({
        Name: Match.stringLikeRegexp('-crawl$'),
        DefaultTTL: 3600,
        MinTTL: 3600,
        MaxTTL: 3600,
        ParametersInCacheKeyAndForwardedToOrigin: {
          CookiesConfig: { CookieBehavior: 'none' },
          HeadersConfig: { HeaderBehavior: 'none' },
          QueryStringsConfig: { QueryStringBehavior: 'none' },
          EnableAcceptEncodingGzip: true,
          EnableAcceptEncodingBrotli: true,
        },
      }),
    })
    const [policyId] = Object.keys(
      template.findResources('AWS::CloudFront::CachePolicy', {
        Properties: { CachePolicyConfig: { Name: Match.stringLikeRegexp('-crawl$') } },
      })
    )
    const behaviors = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0]
      .Properties.DistributionConfig.CacheBehaviors as {
      PathPattern: string
      CachePolicyId: { Ref: string }
      OriginRequestPolicyId?: unknown
    }[]
    for (const path of ['/robots.txt', '/sitemap*']) {
      const behavior = behaviors.find((b) => b.PathPattern === path)
      expect(behavior?.CachePolicyId).toEqual({ Ref: policyId })
      // No origin request policy: no cookie reaches the origin
      expect(behavior?.OriginRequestPolicyId).toBeUndefined()
    }
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

  it('admits signed requests only, from the task roles it grants', () => {
    // The policy reaches the domain as a JSON string inside the custom resource
    const policy = JSON.stringify(template.findResources('Custom::OpenSearchAccessPolicy'))
    expect(policy).toContain(':root')
    expect(policy.replaceAll('\\', '')).not.toContain('"AWS":"*"')
    expect(searchGrants(template)).toHaveLength(2)
    expectContainerEnv(template, 'Web', { OPENSEARCH_AWS_REGION: { Ref: 'AWS::Region' } })
    expectContainerEnv(template, 'Worker', { OPENSEARCH_AWS_REGION: { Ref: 'AWS::Region' } })
  })

  it('keeps env-prefixed physical names', () => {
    template.hasResourceProperties('AWS::RDS::DBCluster', { DBClusterIdentifier: 'kukan-dev' })
    template.hasResourceProperties('AWS::OpenSearchService::Domain', {
      DomainName: 'kukan-dev-search',
    })
  })

  describe('fine-grained access control (ADR-069)', () => {
    const adminRoleId = Object.entries(template.findResources('AWS::IAM::Role')).find(
      ([, role]) =>
        (role as { Properties: { RoleName?: string } }).Properties.RoleName ===
        'kukan-dev-search-admin'
    )?.[0]

    it('turns it on with the admin role as master and no internal users', () => {
      expect(adminRoleId).toBeDefined()
      template.hasResourceProperties('AWS::OpenSearchService::Domain', {
        AdvancedSecurityOptions: {
          Enabled: true,
          InternalUserDatabaseEnabled: false,
          MasterUserOptions: { MasterUserARN: { 'Fn::GetAtt': [adminRoleId, 'Arn'] } },
        },
      })
      // Signed requests from the account stay the domain policy's whole rule
      const policy = JSON.stringify(template.findResources('Custom::OpenSearchAccessPolicy'))
      expect(policy).toContain(':root')
    })

    it('gives the one site a role on the default index prefix, mapped to both task roles', () => {
      expect(searchSiteRoles(template)).toEqual([
        {
          name: 'kukan-dev',
          indexPatterns: ['kukan-search*'],
          backendRoles: [
            `arn:aws:iam::${TEST_ACCOUNT}:role/kukan-dev-web-task`,
            `arn:aws:iam::${TEST_ACCOUNT}:role/kukan-dev-worker-task`,
          ],
        },
      ])
      expect(taskRoleNames(template).sort()).toEqual([
        'kukan-dev-web-task',
        'kukan-dev-worker-task',
      ])
    })

    it('runs the master role as the security handler only', () => {
      const users = Object.entries(template.findResources('AWS::Lambda::Function')).filter(
        ([, fn]) =>
          JSON.stringify((fn as { Properties: { Role: unknown } }).Properties.Role).includes(
            adminRoleId!
          )
      )
      expect(users).toHaveLength(1)
      expect(users[0][0]).toMatch(/^SearchSecurityHandler/)
      expect(JSON.stringify(template.findResources('AWS::ECS::TaskDefinition'))).not.toContain(
        adminRoleId!
      )
      // In the VPC, let into the domain's SG on 443
      template.hasResourceProperties('AWS::Lambda::Function', {
        Role: { 'Fn::GetAtt': [adminRoleId, 'Arn'] },
        VpcConfig: Match.objectLike({ SubnetIds: Match.anyValue() }),
      })
      template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
        FromPort: 443,
        Description: 'Security role handler',
      })
    })

    it('writes the roles after every update of the domain', () => {
      const [siteRoles] = Object.values(template.findResources('Custom::KukanSearchSiteRoles'))
      const dependsOn = (siteRoles as { DependsOn: string[] }).DependsOn
      expect(dependsOn.some((id) => id.startsWith('SearchDomain') && !id.includes('Policy'))).toBe(
        true
      )
      expect(dependsOn.some((id) => id.startsWith('SearchDomainAccessPolicy'))).toBe(true)
    })
  })
})

describe('task role names', () => {
  it('names the task roles even without OpenSearch, and writes no search roles', () => {
    const template = stackTemplate(
      synthStage({ scale: 'small', dbEngine: 'rds', enableOpenSearch: false, bedrock: false }),
      'KukanStack'
    )
    expect(taskRoleNames(template).sort()).toEqual(['kukan-dev-web-task', 'kukan-dev-worker-task'])
    expect(template.findResources('Custom::KukanSearchSiteRoles')).toEqual({})
  })

  it('rejects a name longer than IAM allows', () => {
    // The longest site name (16) under a 29-character environment fits exactly
    expect(taskRoleName(`kukan-${'e'.repeat(29)}-${'s'.repeat(16)}`, 'worker')).toHaveLength(64)
    expect(() => taskRoleName(`kukan-${'e'.repeat(30)}-${'s'.repeat(16)}`, 'worker')).toThrow(
      /longer than IAM allows/
    )
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

describe('IPv6 in DNS (AAAA beside the A)', () => {
  const domain = {
    scale: 'small',
    domainName: 'data.example.jp',
    hostedZoneId: 'Z0000000000000000000',
    hostedZoneName: 'example.jp',
  } as const
  const recordTypes = (
    overrides: Parameters<typeof synthStage>[0],
    context?: Record<string, unknown>
  ) =>
    Object.values(
      stackTemplate(synthStage(overrides, context), 'KukanStack').findResources(
        'AWS::Route53::RecordSet'
      )
    )
      .map((r) => r.Properties.Type)
      .sort()

  it('resolves an open site over both', () => {
    expect(recordTypes(domain)).toEqual(['A', 'AAAA'])
  })

  it('keeps a site behind an IP allowlist on IPv4, an IPv6 prefix in it or not', () => {
    expect(recordTypes({ ...domain, allowedIpRanges: ['203.0.113.0/24'] })).toEqual(['A'])
    expect(
      recordTypes({ ...domain, allowedIpRanges: ['203.0.113.0/24', '2001:db8::/32'] })
    ).toEqual(['A'])
  })

  it('resolves a site behind an IP allowlist over IPv6 when asked', () => {
    expect(
      recordTypes({
        ...domain,
        allowedIpRanges: ['203.0.113.0/24', '2001:db8::/32'],
        enableIpv6Dns: true,
      })
    ).toEqual(['A', 'AAAA'])
  })

  it('leaves an open site on IPv4 when asked', () => {
    expect(recordTypes({ ...domain, enableIpv6Dns: false })).toEqual(['A'])
  })

  it('reads -c enableIpv6Dns=false as off, not as a truthy string', () => {
    expect(recordTypes(domain, { enableIpv6Dns: 'false' })).toEqual(['A'])
    expect(
      recordTypes({ ...domain, allowedIpRanges: ['203.0.113.0/24'] }, { enableIpv6Dns: 'true' })
    ).toEqual(['A', 'AAAA'])
  })

  it('refuses a -c flag that is neither true nor false', () => {
    expect(() => synthStage(domain, { enableIpv6Dns: 'no' })).toThrow(
      /-c enableIpv6Dns must be true or false/
    )
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

describe('environment names', () => {
  const ACCOUNT = { account: '123456789012' }

  it('rejects two that would share a construct id, whatever their accounts', () => {
    // Both would be the Stage `Dev` and the pipeline `PipelineDev`
    expect(() =>
      validateEnvironmentNames({ dev: ACCOUNT, Dev: { account: '210987654321' } })
    ).toThrow(/"dev" and "Dev" would share the construct id "Dev"/)
  })

  it('rejects two that would create the same IAM role in one account', () => {
    // A single-site environment named like another's site, in another region
    expect(() =>
      validateEnvironmentNames({
        dev: { ...ACCOUNT, sites: [{ name: 'citya' }] },
        'dev-citya': { ...ACCOUNT, region: 'us-west-2' },
      })
    ).toThrow(/"kukan-dev-citya-web-task"/)
  })

  it('allows the same role names in another account, and distinct names in one', () => {
    expect(() =>
      validateEnvironmentNames({
        dev: { ...ACCOUNT, sites: [{ name: 'citya' }] },
        'dev-citya': { account: '210987654321' },
      })
    ).not.toThrow()
    expect(() => validateEnvironmentNames({ dev: ACCOUNT, prd: ACCOUNT })).not.toThrow()
  })

  it('refuses a name the OpenSearch security API would refuse as a role', () => {
    expect(() => validateEnvironmentNames({ dev_1: ACCOUNT })).toThrow(/"dev_1" must start/)
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

describe('S3 buckets', () => {
  it('refuse requests not made over TLS, on the resource bucket and the log bucket', () => {
    const template = stackTemplate(synthStage({}), 'KukanStack')
    const buckets = Object.keys(template.findResources('AWS::S3::Bucket'))
    expect(buckets).toHaveLength(2)
    const policies = template.findResources('AWS::S3::BucketPolicy', {
      Properties: {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Deny',
              Action: 's3:*',
              Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            }),
          ]),
        },
      },
    })
    const guarded = Object.values(policies).map(
      (p) => (p.Properties as { Bucket: { Ref: string } }).Bucket.Ref
    )
    expect(guarded.sort()).toEqual(buckets.sort())
  })
})

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

describe('cpuArchitecture', () => {
  /** The task definitions' architectures and the platforms the images are built for. */
  const platforms = (cpuArchitecture?: 'x86_64' | 'arm64') => {
    const stage = synthStage({ enableOpenSearch: false, bedrock: false, cpuArchitecture })
    const template = stackTemplate(stage, 'KukanStack')
    const tasks = Object.values(template.findResources('AWS::ECS::TaskDefinition')).map(
      (def) => (def.Properties as { RuntimePlatform: { CpuArchitecture: string } }).RuntimePlatform
    )
    const stackId = stackOf(stage, 'KukanStack').artifactId
    const manifest = stage
      .synth()
      .artifacts.find(
        (artifact): artifact is cxapi.AssetManifestArtifact =>
          artifact instanceof cxapi.AssetManifestArtifact && artifact.id === `${stackId}.assets`
      )
    const images = Object.values(manifest?.contents.dockerImages ?? {}).map(
      (image) => image.source.platform
    )
    return { tasks: tasks.map((task) => task.CpuArchitecture), images }
  }

  it('runs and builds on arm64 by default', () => {
    expect(platforms()).toEqual({
      tasks: ['ARM64', 'ARM64'],
      images: ['linux/arm64', 'linux/arm64'],
    })
  })

  it('stays on x86_64 when the environment asks for it', () => {
    expect(platforms('x86_64')).toEqual({
      tasks: ['X86_64', 'X86_64'],
      images: ['linux/amd64', 'linux/amd64'],
    })
  })

  it('rejects anything else at synth', () => {
    expect(() => synthStage({ cpuArchitecture: 'amd64' as unknown as 'x86_64' })).toThrow(
      /cpuArchitecture must be "x86_64" or "arm64" \(got "amd64"\)/
    )
  })
})

describe('enableExecuteCommand', () => {
  const synth = (enableExecuteCommand?: boolean) =>
    stackTemplate(
      synthStage({ enableOpenSearch: false, bedrock: false, enableExecuteCommand }),
      'KukanStack'
    )

  it('keeps ECS Exec off on both services by default', () => {
    const template = synth()
    template.resourcePropertiesCountIs('AWS::ECS::Service', { EnableExecuteCommand: false }, 2)
    expect(execChannelGrants(template)).toHaveLength(0)
  })

  it('turns it on for both services when the environment asks for it', () => {
    const template = synth(true)
    template.resourcePropertiesCountIs('AWS::ECS::Service', { EnableExecuteCommand: true }, 2)
    expect(execChannelGrants(template)).toHaveLength(2)
    // Sessions are not logged: unset, they would go to the application logs
    template.hasResourceProperties('AWS::ECS::Cluster', {
      Configuration: { ExecuteCommandConfiguration: { Logging: 'NONE' } },
    })
  })
})

describe('rdsCaCertificate', () => {
  const synth = (dbEngine: 'rds' | 'aurora', rdsCaCertificate?: 'rds-ca-rsa4096-g1') =>
    stackTemplate(
      synthStage({
        scale: dbEngine === 'aurora' ? 'large' : 'small',
        dbEngine,
        enableOpenSearch: false,
        bedrock: false,
        rdsCaCertificate,
      }),
      'KukanStack'
    )
  /** The CA each database instance names. */
  const pinned = (template: Template) =>
    Object.values(template.findResources('AWS::RDS::DBInstance')).map(
      (def) => (def.Properties as { CACertificateIdentifier?: string }).CACertificateIdentifier
    )

  it('names the CA every Region offers', () => {
    expect(pinned(synth('rds'))).toEqual(['rds-ca-rsa2048-g1'])
  })

  it('names it on each Aurora instance, the writer and the readers', () => {
    expect(pinned(synth('aurora'))).toEqual(['rds-ca-rsa2048-g1', 'rds-ca-rsa2048-g1'])
  })

  it('takes another CA when the environment asks for it', () => {
    expect(pinned(synth('rds', 'rds-ca-rsa4096-g1'))).toEqual(['rds-ca-rsa4096-g1'])
  })

  it('rejects a name RDS does not offer at synth', () => {
    expect(() =>
      synthStage({ rdsCaCertificate: 'rds-ca-2019' as unknown as 'rds-ca-rsa2048-g1' })
    ).toThrow(/rdsCaCertificate must be one of .* \(got "rds-ca-2019"\)/)
  })

  it('has the web and worker verify the server against the bundle the images hold', () => {
    const template = synth('rds')
    for (const container of ['Web', 'Worker']) {
      expectContainerEnv(template, container, POSTGRES_TLS_ENVIRONMENT)
    }
    // Only the Dockerfile puts the bundle there: a path the image lacks would
    // pass synth and fail every connection after the deploy
    const dockerfile = readFileSync(new URL('../../../Dockerfile', import.meta.url), 'utf8')
    expect(dockerfile).toContain(` ${POSTGRES_TLS_ENVIRONMENT.POSTGRES_SSLROOTCERT}\n`)
  })
})

/**
 * Assert a container's environment: a string is the value it must have,
 * `undefined` that the variable must be absent.
 */
/** Task-role statements that let a task call the search domain. */
function searchGrants(template: Template) {
  return Object.values(template.findResources('AWS::IAM::Policy')).flatMap((r) =>
    (
      r as { Properties: { PolicyDocument: { Statement: { Action: unknown }[] } } }
    ).Properties.PolicyDocument.Statement.filter((st) => st.Action === 'es:ESHttp*')
  )
}

function expectContainerEnv(
  template: Template,
  container: string,
  expected: Record<string, unknown>
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
