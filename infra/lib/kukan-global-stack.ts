/**
 * KUKAN Global Stack (us-east-1)
 * Resources that must reside in us-east-1 for CloudFront:
 *   - ACM Certificate  (always when domainName is set)
 *   - WAF WebACL       (when enableWaf is true)
 */

import * as cdk from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as wafv2 from 'aws-cdk-lib/aws-wafv2'
import type { Construct } from 'constructs'

export interface KukanGlobalStackProps extends cdk.StackProps {
  enableWaf: boolean
  domainName?: string
  hostedZoneId?: string
  hostedZoneName?: string
}

/** Create an AWS managed WAF rule group definition */
function managedRuleGroup(
  name: string,
  priority: number,
  metricSuffix: string
): wafv2.CfnWebACL.RuleProperty {
  return {
    name,
    priority,
    overrideAction: { none: {} },
    statement: {
      managedRuleGroupStatement: { vendorName: 'AWS', name },
    },
    visibilityConfig: {
      sampledRequestsEnabled: true,
      cloudWatchMetricsEnabled: true,
      metricName: `kukan-waf-${metricSuffix}`,
    },
  }
}

export class KukanGlobalStack extends cdk.Stack {
  /** ACM certificate ARN (us-east-1). Defined when domainName + hostedZone are provided. */
  readonly certificateArn?: string
  /** WAF WebACL ARN. Defined when enableWaf is true. */
  readonly webAclArn?: string

  constructor(scope: Construct, id: string, props: KukanGlobalStackProps) {
    super(scope, id, props)

    const { enableWaf, domainName, hostedZoneId, hostedZoneName } = props

    // ACM Certificate for CloudFront (DNS-validated via Route53)
    if (domainName && hostedZoneId && hostedZoneName) {
      const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId,
        zoneName: hostedZoneName,
      })
      const cert = new acm.Certificate(this, 'Certificate', {
        domainName,
        validation: acm.CertificateValidation.fromDns(hostedZone),
        certificateName: 'kukan-cdn',
      })
      this.certificateArn = cert.certificateArn
    }

    // WAF WebACL — managed rule groups only (IP restriction uses CloudFront Function)
    if (enableWaf) {
      const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
        defaultAction: { allow: {} },
        scope: 'CLOUDFRONT',
        visibilityConfig: {
          sampledRequestsEnabled: true,
          cloudWatchMetricsEnabled: true,
          metricName: 'kukan-waf',
        },
        rules: [
          managedRuleGroup('AWSManagedRulesCommonRuleSet', 0, 'common'),
          managedRuleGroup('AWSManagedRulesKnownBadInputsRuleSet', 1, 'bad-inputs'),
          managedRuleGroup('AWSManagedRulesAmazonIpReputationList', 2, 'ip-reputation'),
        ],
      })
      this.webAclArn = webAcl.attrArn
    }

    cdk.Tags.of(this).add('kukan:component', 'global')
  }
}
