/**
 * KUKAN Global CDK Stack (us-east-1)
 * Resources that must reside in us-east-1 for CloudFront integration:
 *   - ACM Certificate (CloudFront viewer certificate)
 *   - WAF WebACL (CLOUDFRONT scope)
 */

import * as cdk from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as route53 from 'aws-cdk-lib/aws-route53'
import type { Construct } from 'constructs'
import { loadConfig, type EnvironmentConfig } from './config.js'
import { WafConstruct } from './constructs/waf.js'

export interface KukanGlobalStackProps extends cdk.StackProps {
  /** Environment definition for this stack (ADR-031). */
  envConfig?: EnvironmentConfig
}

export class KukanGlobalStack extends cdk.Stack {
  /** CloudFront viewer certificate ARN (undefined when no custom domain). */
  readonly certificateArn?: string
  /** WAF WebACL ARN for CloudFront (undefined when WAF is disabled). */
  readonly webAclArn?: string

  constructor(scope: Construct, id: string, props: KukanGlobalStackProps = {}) {
    super(scope, id, props)

    const config = loadConfig(this, props.envConfig)

    // --- ACM Certificate (custom domain only) ---
    if (config.domainName && config.hostedZoneId && config.hostedZoneName) {
      const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: config.hostedZoneId,
        zoneName: config.hostedZoneName,
      })

      const certificate = new acm.Certificate(this, 'Certificate', {
        domainName: config.domainName,
        validation: acm.CertificateValidation.fromDns(hostedZone),
      })

      this.certificateArn = certificate.certificateArn
    }

    // --- WAF WebACL (CLOUDFRONT scope) ---
    if (config.enableWaf) {
      const waf = new WafConstruct(this, 'Waf')
      this.webAclArn = waf.webAcl.attrArn
    }

    cdk.Tags.of(this).add('kukan:stack', 'global')
  }
}
