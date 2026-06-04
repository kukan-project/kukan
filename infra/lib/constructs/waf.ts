/**
 * KUKAN WAF Construct
 * WAF WebACL with AWS managed rule groups (CLOUDFRONT scope).
 * Deployed in us-east-1 via KukanGlobalStack.
 *
 * IP restriction is handled by CloudFront Function (see cf-functions/viewer-request.js).
 */

import * as cdk from 'aws-cdk-lib'
import * as wafv2 from 'aws-cdk-lib/aws-wafv2'
import { Construct } from 'constructs'

/** Create an AWS managed WAF rule group definition. */
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

export class WafConstruct extends Construct {
  readonly webAcl: wafv2.CfnWebACL

  constructor(scope: Construct, id: string) {
    super(scope, id)

    // CLOUDFRONT scope — must be deployed in us-east-1 (KukanGlobalStack)
    this.webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      defaultAction: { allow: {} },
      scope: 'CLOUDFRONT',
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'kukan-waf',
      },
      rules: [
        managedRuleGroup('AWSManagedRulesCommonRuleSet', 10, 'common'),
        managedRuleGroup('AWSManagedRulesKnownBadInputsRuleSet', 20, 'bad-inputs'),
        managedRuleGroup('AWSManagedRulesAmazonIpReputationList', 30, 'ip-reputation'),
      ],
    })

    cdk.Tags.of(this).add('kukan:component', 'waf')
  }
}
