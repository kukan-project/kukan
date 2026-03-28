/**
 * KUKAN Network Construct
 * VPC, Subnets, NAT (Instance or Gateway), Security Groups, S3 VPC Endpoint.
 */

import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import { Construct } from 'constructs'
import type { KukanConfig } from '../config.js'

export interface NetworkProps {
  config: KukanConfig
}

export class NetworkConstruct extends Construct {
  readonly vpc: ec2.IVpc
  readonly dbSecurityGroup: ec2.ISecurityGroup
  readonly searchSecurityGroup: ec2.ISecurityGroup
  readonly appRunnerSecurityGroup: ec2.ISecurityGroup
  readonly workerSecurityGroup: ec2.ISecurityGroup

  constructor(scope: Construct, id: string, props: NetworkProps) {
    super(scope, id)

    const { config } = props

    // NAT provider: t4g.nano instance (small) or NAT Gateway (medium+)
    const natProvider = config.nat.useNatInstance
      ? ec2.NatProvider.instanceV2({
          instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
        })
      : ec2.NatProvider.gateway()

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      natGatewayProvider: natProvider,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    })

    // S3 Gateway VPC Endpoint (free — avoids NAT for S3 traffic)
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    })

    // --- Security Groups ---

    // App Runner VPC Connector
    this.appRunnerSecurityGroup = new ec2.SecurityGroup(this, 'AppRunnerSg', {
      vpc: this.vpc,
      description: 'App Runner VPC Connector',
      allowAllOutbound: true,
    })

    // Worker (ECS Fargate)
    this.workerSecurityGroup = new ec2.SecurityGroup(this, 'WorkerSg', {
      vpc: this.vpc,
      description: 'Worker ECS Fargate tasks',
      allowAllOutbound: true,
    })

    // Database (RDS / Aurora)
    this.dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSg', {
      vpc: this.vpc,
      description: 'Database (RDS/Aurora)',
      allowAllOutbound: false,
    })
    this.dbSecurityGroup.addIngressRule(
      this.appRunnerSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow App Runner'
    )
    this.dbSecurityGroup.addIngressRule(
      this.workerSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow Worker'
    )

    // OpenSearch
    this.searchSecurityGroup = new ec2.SecurityGroup(this, 'SearchSg', {
      vpc: this.vpc,
      description: 'OpenSearch domain',
      allowAllOutbound: false,
    })
    this.searchSecurityGroup.addIngressRule(
      this.appRunnerSecurityGroup,
      ec2.Port.tcp(443),
      'Allow App Runner'
    )
    this.searchSecurityGroup.addIngressRule(
      this.workerSecurityGroup,
      ec2.Port.tcp(443),
      'Allow Worker'
    )

    cdk.Tags.of(this).add('kukan:component', 'network')
  }
}
