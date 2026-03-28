/**
 * KUKAN CDN Construct
 * CloudFront distribution + Route53 DNS.
 * ACM certificate and WAF are managed in KukanGlobalStack (us-east-1).
 *
 * IP restriction strategy:
 *   - allowedIpRanges only  → CloudFront Function (viewer request, ~free)
 *   - enableWaf only        → WAF WebACL passed as webAclArn (managed rules, ~$5+/month)
 *   - both                  → CF Function for IP + WAF for managed rules
 */

import * as cdk from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import { Construct } from 'constructs'
import type { KukanConfig } from '../config.js'

export interface CdnProps {
  config: KukanConfig
  appRunnerServiceUrl: string // e.g. "https://xxx.ap-northeast-1.awsapprunner.com"
  /** ACM certificate ARN from KukanGlobalStack (us-east-1). Required when domainName is set. */
  certArn?: string
  /** WAF WebACL ARN from KukanGlobalStack (us-east-1). Only needed when enableWaf is true. */
  webAclArn?: string
  /** Secret for X-Origin-Verify header — blocks direct App Runner access. */
  originVerifySecret: secretsmanager.ISecret
}

/** Generate CloudFront Function JS code that enforces an IP allowlist (IPv4 CIDR + IPv6 prefix). */
function buildIpAllowlistFunctionCode(allowedRanges: string[]): string {
  const ipv4 = allowedRanges.filter((r) => !r.includes(':'))
  const ipv6 = allowedRanges.filter((r) => r.includes(':'))
  return `
var IPV4_CIDRS = ${JSON.stringify(ipv4)};
var IPV6_CIDRS = ${JSON.stringify(ipv6)};

function ipv4ToU32(ip) {
  var p = ip.split('.');
  return (((+p[0]) << 24) | ((+p[1]) << 16) | ((+p[2]) << 8) | (+p[3])) >>> 0;
}

function ipv4InCidr(ip, cidr) {
  var parts = cidr.split('/');
  var bits = +parts[1];
  if (bits === 32) return ip === parts[0];
  var mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToU32(ip) & mask) === (ipv4ToU32(parts[0]) & mask);
}

function expandIpv6(addr) {
  var halves = addr.split('::');
  var left  = halves[0] ? halves[0].split(':') : [];
  var right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  var fill  = 8 - left.length - right.length;
  var groups = left.slice();
  for (var i = 0; i < fill; i++) groups.push('0');
  groups = groups.concat(right);
  return groups.map(function(g) { return parseInt(g || '0', 16); });
}

function ipv6InCidr(ip, cidr) {
  var parts     = cidr.split('/');
  var bits      = +parts[1];
  var ipNums    = expandIpv6(ip);
  var prefNums  = expandIpv6(parts[0]);
  var full      = (bits / 16) | 0;
  var rem       = bits % 16;
  for (var i = 0; i < full; i++) {
    if (ipNums[i] !== prefNums[i]) return false;
  }
  if (rem > 0) {
    var mask = ~((1 << (16 - rem)) - 1) & 0xffff;
    if ((ipNums[full] & mask) !== (prefNums[full] & mask)) return false;
  }
  return true;
}

function isAllowed(ip) {
  var i;
  if (ip.indexOf(':') === -1) {
    for (i = 0; i < IPV4_CIDRS.length; i++) {
      if (ipv4InCidr(ip, IPV4_CIDRS[i])) return true;
    }
  } else {
    for (i = 0; i < IPV6_CIDRS.length; i++) {
      if (ipv6InCidr(ip, IPV6_CIDRS[i])) return true;
    }
  }
  return false;
}

function handler(event) {
  if (!isAllowed(event.viewer.ip)) {
    return { statusCode: 403, statusDescription: 'Forbidden' };
  }
  return event.request;
}
`.trim()
}

export class CdnConstruct extends Construct {
  readonly distribution: cloudfront.Distribution

  constructor(scope: Construct, id: string, props: CdnProps) {
    super(scope, id)

    const { config, appRunnerServiceUrl, certArn, webAclArn, originVerifySecret } = props

    // Extract hostname from App Runner URL
    const originDomain = appRunnerServiceUrl.replace('https://', '')

    // Route53 Hosted Zone (for A record only — cert is created in KukanGlobalStack)
    let hostedZone: route53.IHostedZone | undefined
    if (config.hostedZoneId && config.hostedZoneName) {
      hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: config.hostedZoneId,
        zoneName: config.hostedZoneName,
      })
    }

    // ACM Certificate — created in KukanGlobalStack (us-east-1), referenced by ARN
    const certificate = certArn
      ? acm.Certificate.fromCertificateArn(this, 'Certificate', certArn)
      : undefined

    // IP allowlist via CloudFront Function — always cheaper than WAF IP rules.
    // WAF (webAclArn) is used only for managed rule groups, not IP restriction.
    const hasIpRestriction = (config.allowedIpRanges ?? []).length > 0
    let ipAllowlistFn: cloudfront.Function | undefined
    if (hasIpRestriction) {
      ipAllowlistFn = new cloudfront.Function(this, 'IpAllowlist', {
        functionName: 'kukan-ip-allowlist',
        code: cloudfront.FunctionCode.fromInline(
          buildIpAllowlistFunctionCode(config.allowedIpRanges!)
        ),
        runtime: cloudfront.FunctionRuntime.JS_2_0,
      })
    }

    const appRunnerOrigin = new origins.HttpOrigin(originDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      customHeaders: {
        'X-Origin-Verify': originVerifySecret.secretValue.unsafeUnwrap(),
      },
    })

    // CloudFront Distribution
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      domainNames: config.domainName && certificate ? [config.domainName] : undefined,
      certificate,
      webAclId: webAclArn,
      defaultBehavior: {
        origin: appRunnerOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        functionAssociations: ipAllowlistFn
          ? [{ function: ipAllowlistFn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }]
          : undefined,
      },
      // Cache static assets
      additionalBehaviors: {
        '/_next/static/*': {
          origin: appRunnerOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          functionAssociations: ipAllowlistFn
            ? [{ function: ipAllowlistFn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }]
            : undefined,
        },
      },
    })

    // Route53 A record
    if (hostedZone && config.domainName) {
      new route53.ARecord(this, 'ARecord', {
        zone: hostedZone,
        recordName: config.domainName,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.CloudFrontTarget(this.distribution)
        ),
      })
    }

    new cdk.CfnOutput(cdk.Stack.of(this), 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description: 'CloudFront Distribution Domain',
    })

    cdk.Tags.of(this).add('kukan:component', 'cdn')
  }
}
