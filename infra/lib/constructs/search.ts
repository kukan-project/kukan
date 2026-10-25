/**
 * KUKAN Search Construct
 * OpenSearch domain (VPC mode) with kuromoji plugin for Japanese search.
 */

import * as cdk from 'aws-cdk-lib'
import * as cr from 'aws-cdk-lib/custom-resources'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import type * as ecs from 'aws-cdk-lib/aws-ecs'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice'
import { Construct } from 'constructs'
import type { KukanConfig } from '../config.js'
import { resourceName } from '../naming.js'

export interface SearchProps {
  config: KukanConfig
  vpc: ec2.IVpc
  searchSecurityGroup: ec2.ISecurityGroup
}

/** What a site's tasks need of the domain: where it is, and what to be granted. */
export interface SearchDomainRef {
  endpoint: string
  arn: string
}

/**
 * Point a task at the domain and let its role call it: the task signs its
 * requests as that role (SigV4), so the domain policy can name principals.
 */
export function connectSearch(
  config: KukanConfig,
  domain: SearchDomainRef,
  taskDef: ecs.TaskDefinition,
  environment: Record<string, string>,
  indexPrefix: string | undefined
) {
  taskDef.taskRole.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['es:ESHttp*'],
      resources: [`${domain.arn}/*`],
    })
  )
  environment.OPENSEARCH_URL = `https://${domain.endpoint}`
  environment.OPENSEARCH_AWS_REGION = cdk.Aws.REGION
  environment.OPENSEARCH_REPLICAS = String(config.opensearch.indexReplicas)
  if (indexPrefix) {
    environment.OPENSEARCH_INDEX_PREFIX = indexPrefix
  }
}

export class SearchConstruct extends Construct {
  readonly domain: opensearch.Domain
  readonly ref: SearchDomainRef

  constructor(scope: Construct, id: string, props: SearchProps) {
    super(scope, id)

    const { config, vpc, searchSecurityGroup } = props

    // Service-linked role required for OpenSearch VPC access (idempotent)
    const slr = new cr.AwsCustomResource(this, 'OpensearchSlr', {
      onCreate: {
        service: 'IAM',
        action: 'createServiceLinkedRole',
        parameters: { AWSServiceName: 'opensearchservice.amazonaws.com' },
        physicalResourceId: cr.PhysicalResourceId.of('opensearch-slr'),
        ignoreErrorCodesMatching: 'InvalidInput',
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    })

    const domainName = resourceName(this, 'search')
    this.domain = new opensearch.Domain(this, 'Domain', {
      domainName,
      version: opensearch.EngineVersion.openSearch('3.5'),
      vpc,
      vpcSubnets: [
        {
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          onePerAz: true,
          availabilityZones: config.opensearch.multiAz
            ? undefined
            : [cdk.Stack.of(this).availabilityZones[0]],
        },
      ],
      securityGroups: [searchSecurityGroup],
      capacity: {
        dataNodeInstanceType: config.opensearch.instanceType,
        dataNodes: config.opensearch.instanceCount,
        multiAzWithStandbyEnabled: false,
      },
      ebs: {
        volumeSize: config.opensearch.volumeSize,
        volumeType: ec2.EbsDeviceVolumeType.GP3,
      },
      nodeToNodeEncryption: true,
      encryptionAtRest: { enabled: true },
      enforceHttps: true,
      zoneAwareness: config.opensearch.multiAz ? { availabilityZoneCount: 2 } : undefined,
      // Signed requests only: the account's principals, each as far as its
      // own policy grants (the site tasks, through connectSearch). An unsigned
      // request — anything a fetch from inside the VPC can be made to send —
      // is refused. HTTP API only, no domain management.
      accessPolicies: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          principals: [new iam.AccountRootPrincipal()],
          actions: ['es:ESHttp*'],
          resources: [`arn:aws:es:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:domain/${domainName}/*`],
        }),
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      // analysis-kuromoji plugin is pre-installed on all OpenSearch domains
    })

    // Ensure service-linked role is created before the domain
    this.domain.node.addDependency(slr)

    this.ref = { endpoint: this.domain.domainEndpoint, arn: this.domain.domainArn }

    cdk.Tags.of(this).add('kukan:component', 'search')
  }
}
