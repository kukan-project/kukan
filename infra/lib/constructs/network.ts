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
  /**
   * The sites' Web Function network connectors (ADR-068). Shared like the web
   * SG so the DB, OpenSearch and worker rules stay here. Undefined on Fargate.
   */
  readonly webConnectorSecurityGroup?: ec2.ISecurityGroup
  readonly dbSecurityGroup: ec2.ISecurityGroup
  readonly searchSecurityGroup: ec2.ISecurityGroup
  readonly albSecurityGroup: ec2.ISecurityGroup
  readonly webSecurityGroup: ec2.ISecurityGroup
  readonly workerSecurityGroup: ec2.ISecurityGroup

  constructor(scope: Construct, id: string, props: NetworkProps) {
    super(scope, id)

    // ECS tasks run in public subnets (assignPublicIp: true) — no NAT needed.
    // Private isolated subnets are for RDS / OpenSearch only (no internet access).
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    })
    this.vpc = vpc

    // S3 Gateway VPC Endpoint (free — avoids NAT for S3 traffic)
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    })

    // --- Security Groups ---

    // ALB (internal — CloudFront connects via VPC origin)
    // CloudFront VPC origin requires the ALB SG to allow traffic from the
    // CloudFront managed prefix list (com.amazonaws.global.cloudfront.origin-facing).
    // Using the prefix list avoids chicken-and-egg issues with the CloudFront-managed SG.
    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      description: 'Internal ALB for web service (CloudFront VPC origin)',
      allowAllOutbound: true,
    })
    const cfPrefixList = ec2.PrefixList.fromLookup(this, 'CfPrefixList', {
      prefixListName: 'com.amazonaws.global.cloudfront.origin-facing',
    })
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.prefixList(cfPrefixList.prefixListId),
      ec2.Port.tcp(80),
      'CloudFront VPC origin (managed prefix list)'
    )

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
    // The web tells the worker a job is waiting (ADR-058 §3). The SGs are
    // shared by every site of an environment, so a site's web can reach
    // another site's worker; the wake token, derived from each site's own
    // auth secret, is what keeps it out.
    this.workerSecurityGroup.connections.allowFrom(
      this.webSecurityGroup,
      ec2.Port.tcp(props.config.worker.healthPort),
      'Web wake'
    )
    // Web Function connectors: outbound only, IPv6 to the internet (no NAT)
    // and IPv4 within the VPC (ADR-068 §決定 2)
    if (props.config.webFunctionNetwork) {
      addPublicIpv6(this, vpc)
      const connector = new ec2.SecurityGroup(this, 'WebConnectorSg', {
        vpc: this.vpc,
        description: 'Web Function network connectors',
        allowAllOutbound: true,
        allowAllIpv6Outbound: true,
      })
      this.webConnectorSecurityGroup = connector
      this.dbSecurityGroup.connections.allowFrom(connector, ec2.Port.tcp(5432), 'Web Function')
      this.searchSecurityGroup.connections.allowFrom(connector, ec2.Port.tcp(443), 'Web Function')
      this.workerSecurityGroup.connections.allowFrom(
        connector,
        ec2.Port.tcp(props.config.worker.healthPort),
        'Web Function wake'
      )
    }
    // And worker to worker, for the jobs a worker's jobs write
    this.workerSecurityGroup.connections.allowFrom(
      this.workerSecurityGroup,
      ec2.Port.tcp(props.config.worker.healthPort),
      'Worker wake'
    )

    cdk.Tags.of(this).add('kukan:component', 'network')
  }
}

/**
 * An Amazon IPv6 block on the VPC, a /64 of it on each public subnet and a
 * `::/0` route to the internet gateway: how the Web Function connectors reach
 * the internet without a NAT (ADR-068 §決定 2). The /64s are associations of
 * their own, not the subnets' Ipv6CidrBlock, which CloudFormation would meet
 * by replacing the subnets — and every site's tasks and the shared ALB are in
 * them. Nothing else takes an IPv6 address (the subnets do not assign one on
 * creation), and the isolated subnets stay IPv4 only. The internet gateway
 * rather than an egress-only one: the connector's security group admits
 * nothing inbound.
 */
function addPublicIpv6(scope: Construct, vpc: ec2.Vpc) {
  const block = new ec2.CfnVPCCidrBlock(scope, 'Ipv6Block', {
    vpcId: vpc.vpcId,
    amazonProvidedIpv6CidrBlock: true,
  })
  const subnetBlocks = cdk.Fn.cidr(cdk.Fn.select(0, vpc.vpcIpv6CidrBlocks), 256, '64')
  vpc.publicSubnets.forEach((subnet, index) => {
    new ec2.CfnSubnetCidrBlock(subnet, 'Ipv6Block', {
      subnetId: subnet.subnetId,
      ipv6CidrBlock: cdk.Fn.select(index, subnetBlocks),
    }).node.addDependency(block)
    const route = new ec2.CfnRoute(subnet, 'Ipv6DefaultRoute', {
      routeTableId: subnet.routeTable.routeTableId,
      destinationIpv6CidrBlock: '::/0',
      gatewayId: vpc.internetGatewayId,
    })
    route.node.addDependency(block)
    // The gateway's attachment, as the IPv4 default routes wait for it
    route.node.addDependency(vpc.internetConnectivityEstablished)
  })
}
