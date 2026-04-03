/**
 * KUKAN WAF Construct
 * REGIONAL-scope WAF WebACL for ALB with AWS managed rule groups.
 *
 * IP restriction is handled by ALB Security Group (see network.ts).
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

    this.webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      defaultAction: { allow: {} },
      scope: 'REGIONAL',
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
