/**
 * KUKAN Search Construct
 * OpenSearch domain (VPC mode) with kuromoji plugin for Japanese search.
 */

import * as cdk from 'aws-cdk-lib'
import * as cr from 'aws-cdk-lib/custom-resources'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice'
import { Construct } from 'constructs'
import type { KukanConfig } from '../config.js'

export interface SearchProps {
  config: KukanConfig
  vpc: ec2.IVpc
  searchSecurityGroup: ec2.ISecurityGroup
}

export class SearchConstruct extends Construct {
  readonly domain: opensearch.Domain
  readonly domainEndpoint: string

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

    this.domain = new opensearch.Domain(this, 'Domain', {
      domainName: 'kukan-search',
      version: opensearch.EngineVersion.OPENSEARCH_2_17,
      vpc,
      vpcSubnets: [
        {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
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
      accessPolicies: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          principals: [new iam.AnyPrincipal()],
          actions: ['es:*'],
          resources: ['*'],
        }),
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      // analysis-kuromoji plugin is pre-installed on all OpenSearch domains
    })

    // Ensure service-linked role is created before the domain
    this.domain.node.addDependency(slr)

    this.domainEndpoint = this.domain.domainEndpoint

    cdk.Tags.of(this).add('kukan:component', 'search')
  }
}
