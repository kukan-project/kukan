/**
 * KUKAN CDN Construct
 * CloudFront distribution with VPC origin (internal ALB),
 * cookie-based cache bypass, optional IP restriction (via CF Function),
 * and WAF integration.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cdk from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import type * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import { Construct } from 'constructs'
import type { KukanConfig } from '../config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export interface CdnProps {
  config: KukanConfig
  /** Internal ALB used as CloudFront VPC origin. */
  alb: elbv2.IApplicationLoadBalancer
  /** ACM certificate ARN in us-east-1 for custom domain (from KukanGlobalStack). */
  certificateArn?: string
  /** WAF WebACL ARN in us-east-1 (from KukanGlobalStack). */
  webAclArn?: string
}

/**
 * Load the CF Function source from cf-functions/viewer-request.js
 * and inject allowedIpRanges at synth time.
 */
function loadViewerRequestCode(allowedIpRanges?: string[]): string {
  const src = readFileSync(join(__dirname, '../cf-functions/viewer-request.js'), 'utf-8')
  if (allowedIpRanges && allowedIpRanges.length > 0) {
    return src.replace('var ALLOWED = []', `var ALLOWED = ${JSON.stringify(allowedIpRanges)}`)
  }
  return src
}

export class CdnConstruct extends Construct {
  readonly distribution: cloudfront.Distribution
  readonly distributionDomainName: string

  constructor(scope: Construct, id: string, props: CdnProps) {
    super(scope, id)

    const { config, alb, certificateArn, webAclArn } = props

    // --- CloudFront Function: IP restriction + cookie-based cache bypass ---
    const viewerRequestFn = new cloudfront.Function(this, 'ViewerRequestFn', {
      functionName: 'kukan-viewer-request',
      code: cloudfront.FunctionCode.fromInline(loadViewerRequestCode(config.allowedIpRanges)),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    })

    // --- ALB VPC Origin (CloudFront connects to internal ALB via VPC) ---
    const albOrigin = origins.VpcOrigin.withApplicationLoadBalancer(alb, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
    })

    // --- Cache Policy: HTML pages (TTL 60–300s, bypass via header) ---
    const htmlCachePolicy = new cloudfront.CachePolicy(this, 'HtmlCachePolicy', {
      cachePolicyName: 'kukan-html',
      defaultTtl: cdk.Duration.seconds(60),
      minTtl: cdk.Duration.seconds(60),
      maxTtl: cdk.Duration.seconds(300),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('x-cache-bypass'),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    })

    // --- Viewer certificate ---
    const viewerCertificate = certificateArn
      ? acm.Certificate.fromCertificateArn(this, 'ViewerCert', certificateArn)
      : undefined

    // --- Behavior patterns ---
    // Shared: all behaviors use the CF Function (IP restriction + cookie bypass).
    const fnAssociations: cloudfront.FunctionAssociation[] = [
      { function: viewerRequestFn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
    ]

    // Passthrough: no cache, forward everything to origin (auth, API)
    const passthrough: cloudfront.BehaviorOptions = {
      origin: albOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      functionAssociations: fnAssociations,
    }

    // Static: immutable assets with content-hash filenames
    const staticAssets: cloudfront.BehaviorOptions = {
      origin: albOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      functionAssociations: fnAssociations,
    }

    // HTML pages: short-lived cache with cookie-based bypass for logged-in users
    const htmlPages: cloudfront.BehaviorOptions = {
      origin: albOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: htmlCachePolicy,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      functionAssociations: fnAssociations,
    }

    // --- Distribution ---
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'KUKAN CDN',
      defaultBehavior: htmlPages,
      additionalBehaviors: {
        '/_next/static/*': staticAssets,
        '/auth/*': passthrough,
        '/api/*': passthrough,
      },
      ...(viewerCertificate && config.domainName
        ? { domainNames: [config.domainName], certificate: viewerCertificate }
        : {}),
      ...(webAclArn ? { webAclId: webAclArn } : {}),
    })

    this.distributionDomainName = this.distribution.distributionDomainName

    cdk.Tags.of(this).add('kukan:component', 'cdn')
  }
}
