/**
 * KUKAN CDN Construct
 * CloudFront distribution in front of the given origin (a VPC origin to the
 * site's own or the shared internal ALB — composeSite), cookie-based cache
 * bypass, optional edge gate (IP allowlist and/or Basic auth, via CF Function),
 * WAF integration, and access logs (AccessLogConstruct).
 */

import * as cdk from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import { Construct } from 'constructs'
import { PINNED_PAGE_MAX_AGE_S } from '@kukan/shared'
import { loadViewerRequestCode } from '../cf-functions/inject.js'
import type { KukanConfig } from '../config.js'
import { resourceName } from '../naming.js'
import { AccessLogConstruct, supportsLegacyCdnLogging } from './access-log.js'

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
  /** Unset in a region legacy logging cannot deliver to (see supportsLegacyCdnLogging). */
  readonly accessLog?: AccessLogConstruct

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

    // --- Cache Policy: OData feed (ADR-055) ---
    // The query string MUST be in the cache key: `$skip=0` and `$skip=1000` are
    // different pages of the same path, and collapsing them would serve every
    // caller the same first page with no error anywhere to show for it.
    // Cookies are absent from this path by design (public resources only), and
    // the origin's own `Cache-Control` decides the age — `minTtl` 0 so a refusal
    // is not held for a minute, and `maxTtl` the same figure the origin asks
    // for on a version-pinned page (`PINNED_PAGE_MAX_AGE_S`), so nothing is held
    // past the point a withdrawal should have taken effect. Such a page is
    // immutable in content and could justify far longer, but a dataset made
    // private or a version withdrawn is someone asking for it to stop being
    // readable, and an edge still serving it is that not happening (ADR-026).
    const odataCachePolicy = new cloudfront.CachePolicy(this, 'OdataCachePolicy', {
      cachePolicyName: resourceName(this, 'odata'),
      defaultTtl: cdk.Duration.seconds(60),
      minTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(PINNED_PAGE_MAX_AGE_S),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
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

    // OData feed: read-only, unauthenticated, and re-fetched page by page by a
    // BI tool's extract — the one API-shaped path worth caching (ADR-055 §6).
    // It sits outside `/api/*` precisely so `CACHING_DISABLED` does not apply.
    const odataFeed: cloudfront.BehaviorOptions = {
      ...passthrough,
      cachePolicy: odataCachePolicy,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
    }

    // --- Access logs ---
    // Without them a burst cannot be traced to who sent it, which URLs, or why
    // the cache missed.
    const { region } = cdk.Stack.of(this)
    if (supportsLegacyCdnLogging(region)) {
      this.accessLog = new AccessLogConstruct(this, 'AccessLog', {
        retentionDays: config.cdnLogRetentionDays,
      })
    } else {
      // Failing the deploy over logs would cost more than going without them
      cdk.Annotations.of(this).addWarningV2(
        'kukan:cdn-logs-unsupported-region',
        `CloudFront access logs are off: legacy standard logging cannot deliver to a bucket in ${region} (an opt-in region)`
      )
    }

    // --- Distribution ---
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'KUKAN CDN',
      defaultBehavior: htmlPages,
      additionalBehaviors: {
        '/_next/static/*': staticAssets,
        '/auth/*': passthrough,
        '/api/*': passthrough,
        '/odata/*': odataFeed,
      },
      ...(viewerCertificate && config.domainName
        ? { domainNames: [config.domainName], certificate: viewerCertificate }
        : {}),
      ...(webAclArn ? { webAclId: webAclArn } : {}),
      ...(this.accessLog
        ? {
            logBucket: this.accessLog.bucket,
            // Cookies carry the session token — a log reader must not be able to sign in with them
            logIncludesCookies: false,
          }
        : {}),
    })

    this.distributionDomainName = this.distribution.distributionDomainName

    cdk.Tags.of(this).add('kukan:component', 'cdn')
  }
}
