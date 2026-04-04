/**
 * KUKAN Network Construct
 * VPC, Subnets, Security Groups, S3 VPC Endpoint.
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
  readonly albSecurityGroup: ec2.ISecurityGroup
  readonly webSecurityGroup: ec2.ISecurityGroup
  readonly workerSecurityGroup: ec2.ISecurityGroup

  constructor(scope: Construct, id: string, props: NetworkProps) {
    super(scope, id)

    const { config } = props

    // ECS tasks run in public subnets (assignPublicIp: true) — no NAT needed.
    // Private isolated subnets are for RDS / OpenSearch only (no internet access).
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    })

    // S3 Gateway VPC Endpoint (free — avoids NAT for S3 traffic)
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    })

    // --- Security Groups ---

    // ALB (internet-facing)
    // All SG rules managed here; listener uses open=false to prevent CDK auto-rules.
    // With custom domain (HTTPS): allow 443 + 80 (HTTP→HTTPS redirect).
    // Without custom domain: allow 80 only (dev/test).
    const albPorts = config.domainName ? [443, 80] : [80]
    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      description: 'ALB for web service',
      allowAllOutbound: true,
    })
    if (config.allowedIpRanges && config.allowedIpRanges.length > 0) {
      for (const cidr of config.allowedIpRanges) {
        const peer = cidr.includes(':') ? ec2.Peer.ipv6(cidr) : ec2.Peer.ipv4(cidr)
        for (const port of albPorts) {
          this.albSecurityGroup.addIngressRule(peer, ec2.Port.tcp(port), 'Allowed IP')
        }
      }
    } else {
      for (const port of albPorts) {
        this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(port), 'Public')
        this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(port), 'Public IPv6')
      }
    }

    // Web (ECS Fargate tasks — ALB traffic only)
    this.webSecurityGroup = new ec2.SecurityGroup(this, 'WebSg', {
      vpc: this.vpc,
      description: 'Web ECS Fargate tasks',
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

    // OpenSearch
    this.searchSecurityGroup = new ec2.SecurityGroup(this, 'SearchSg', {
      vpc: this.vpc,
      description: 'OpenSearch domain',
      allowAllOutbound: false,
    })

    // --- Inter-SG traffic (allowFrom) ---
    this.webSecurityGroup.connections.allowFrom(this.albSecurityGroup, ec2.Port.tcp(3000), 'ALB')
    this.dbSecurityGroup.connections.allowFrom(this.webSecurityGroup, ec2.Port.tcp(5432), 'Web')
    this.dbSecurityGroup.connections.allowFrom(
      this.workerSecurityGroup,
      ec2.Port.tcp(5432),
      'Worker'
    )
    this.searchSecurityGroup.connections.allowFrom(this.webSecurityGroup, ec2.Port.tcp(443), 'Web')
    this.searchSecurityGroup.connections.allowFrom(
      this.workerSecurityGroup,
      ec2.Port.tcp(443),
      'Worker'
    )

    cdk.Tags.of(this).add('kukan:component', 'network')
  }
}
