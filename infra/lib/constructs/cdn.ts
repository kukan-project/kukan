/**
 * KUKAN CDN Construct
 * CloudFront distribution in front of the given origin (a VPC origin to the
 * site's own or the shared internal ALB — composeSite), cookie-based cache
 * bypass, optional edge gate (IP allowlist and/or Basic auth, via CF Function),
 * and WAF integration.
 */

import * as cdk from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import { Construct } from 'constructs'
import { loadViewerRequestCode } from '../cf-functions/inject.js'
import type { KukanConfig } from '../config.js'
import { resourceName } from '../naming.js'

export interface CdnProps {
  config: KukanConfig
  /** Origin of every behavior (built by composeSite). */
  origin: cloudfront.IOrigin
  /** ACM certificate ARN in us-east-1 for custom domain (from KukanGlobalStack). */
  certificateArn?: string
  /** WAF WebACL ARN in us-east-1 (from KukanGlobalStack). */
  webAclArn?: string
}

export class CdnConstruct extends Construct {
  readonly distribution: cloudfront.Distribution
  readonly distributionDomainName: string

  constructor(scope: Construct, id: string, props: CdnProps) {
    super(scope, id)

    const { config, origin: albOrigin, certificateArn, webAclArn } = props

    // --- CloudFront Function: IP restriction + cookie-based cache bypass ---
    // Env-prefixed name for readability + multi-environment uniqueness (ADR-031).
    const viewerRequestFn = new cloudfront.Function(this, 'ViewerRequestFn', {
      functionName: resourceName(this, 'viewer-request'),
      code: cloudfront.FunctionCode.fromInline(
        loadViewerRequestCode(config.allowedIpRanges, config.basicAuth)
      ),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    })

    // --- Cache Policy: HTML pages (TTL 60–300s, bypass via header) ---
    const htmlCachePolicy = new cloudfront.CachePolicy(this, 'HtmlCachePolicy', {
      cachePolicyName: resourceName(this, 'html'),
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
