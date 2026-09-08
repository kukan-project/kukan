/**
 * KUKAN Shared ALB Construct (ADR-049)
 * One internal ALB per multi-site environment, plus the single CloudFront VPC
 * origin every site's distribution uses to reach it. Sites attach their own
 * target group and a listener rule keyed on the X-Kukan-Site header that
 * their distribution adds to origin requests (WebServiceConstruct / composeSite).
 */

import * as cdk from 'aws-cdk-lib'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import { Construct } from 'constructs'

/**
 * Origin custom header each site's CloudFront adds; the shared listener routes
 * on it. A separation key, not a security boundary — the ALB is internal and
 * only admits the CloudFront managed prefix list (NetworkConstruct).
 */
export const SITE_ROUTING_HEADER = 'X-Kukan-Site'

export interface InternalAlbProps {
  vpc: ec2.IVpc
  securityGroup: ec2.ISecurityGroup
  /** Listener default action. Unset → the caller sets it via addTargets(). */
  defaultAction?: elbv2.ListenerAction
}

/**
 * The internal ALB + HTTP:80 listener shape shared by the single-site
 * WebServiceConstruct and SharedAlbConstruct. A plain function so the ids
 * ('Alb', 'HttpListener') land directly under the caller's scope — the
 * single-site logical IDs must not move (composition.ts).
 */
export function createInternalAlb(scope: Construct, props: InternalAlbProps) {
  // Private subnet — CloudFront connects via VPC origin, no public IPs
  const loadBalancer = new elbv2.ApplicationLoadBalancer(scope, 'Alb', {
    vpc: props.vpc,
    internetFacing: false,
    securityGroup: props.securityGroup,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  })
  // open: false — SG rules are managed by NetworkConstruct
  const listener = loadBalancer.addListener('HttpListener', {
    port: 80,
    protocol: elbv2.ApplicationProtocol.HTTP,
    open: false,
    defaultAction: props.defaultAction,
  })
  return { loadBalancer, listener }
}

export interface SharedAlbProps {
  vpc: ec2.IVpc
  albSecurityGroup: ec2.ISecurityGroup
}

export class SharedAlbConstruct extends Construct {
  readonly loadBalancer: elbv2.ApplicationLoadBalancer
  readonly listener: elbv2.ApplicationListener
  readonly vpcOrigin: cloudfront.VpcOrigin

  constructor(scope: Construct, id: string, props: SharedAlbProps) {
    super(scope, id)

    // Requests carrying no known site header (nothing legitimate: every
    // distribution sets it) get a plain 404 instead of some arbitrary site.
    const alb = createInternalAlb(this, {
      vpc: props.vpc,
      securityGroup: props.albSecurityGroup,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Unknown site',
      }),
    })
    this.loadBalancer = alb.loadBalancer
    this.listener = alb.listener

    // Protocol/port must match the listener above — pinned by the synth tests
    this.vpcOrigin = new cloudfront.VpcOrigin(this, 'VpcOrigin', {
      endpoint: cloudfront.VpcOriginEndpoint.applicationLoadBalancer(this.loadBalancer),
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
    })

    cdk.Tags.of(this).add('kukan:component', 'shared-alb')
  }
}
