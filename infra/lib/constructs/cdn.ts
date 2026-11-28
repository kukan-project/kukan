/**
 * KUKAN CDN Construct
 * CloudFront distribution in front of the given origin (a VPC origin to the
 * site's own or the shared internal ALB — composeSite), cookie-based cache
 * bypass, HTML cache keyed on the resolved locale, optional edge gate (IP
 * allowlist and/or Basic auth, via CF Function), WAF integration, and access
 * logs (AccessLogConstruct).
 */

import * as cdk from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import { Construct } from 'constructs'
import { LOCALE_HEADER, PINNED_PAGE_MAX_AGE_S } from '@kukan/shared'
import { loadViewerRequestCode } from '../cf-functions/inject.js'
import { siteDomainNames, type KukanConfig } from '../config.js'
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
  /**
   * Where the static files come from instead of `origin`, on a Web Function
   * site (its bucket, ADR-068), with the CSP of the ibisOffice directory
   * (`ibisOfficeBootPolicy`). They then get here the headers the web would
   * have given them (next.config.ts and its proxy).
   */
  staticFiles?: { origin: cloudfront.IOrigin; ibisOfficePolicy: string }
}

/**
 * What the app router sends for a page's payload: `RSC`, and the headers Next
 * hashes into `_rsc` (next/dist/shared/lib/router/utils/cache-busting-search-param).
 */
const ROUTER_HEADERS = [
  'RSC',
  'Next-Router-Prefetch',
  'Next-Router-Segment-Prefetch',
  'Next-Router-State-Tree',
  'Next-Url',
]

export class CdnConstruct extends Construct {
  readonly distribution: cloudfront.Distribution
  readonly distributionDomainName: string
  /** Unset in a region legacy logging cannot deliver to (see supportsLegacyCdnLogging). */
  readonly accessLog?: AccessLogConstruct

  constructor(scope: Construct, id: string, props: CdnProps) {
    super(scope, id)

    const { config, origin: albOrigin, certificateArn, webAclArn, staticFiles } = props

    // --- CloudFront Function: IP restriction + cache bypass for credentialed requests ---
    // Env-prefixed name for readability + multi-environment uniqueness (ADR-031).
    const viewerRequestFn = new cloudfront.Function(this, 'ViewerRequestFn', {
      functionName: resourceName(this, 'viewer-request'),
      code: cloudfront.FunctionCode.fromInline(
        loadViewerRequestCode(config.allowedIpRanges, config.basicAuth)
      ),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    })

    // --- Cache Policy: HTML pages (TTL 60–300s, bypass via header) ---
    // The page is rendered in the viewer's locale, so the key varies on the
    // locale the viewer-request function resolved. Without it the next viewer
    // gets whichever language the last cache miss was rendered in — and minTtl
    // holds even a `no-store` response for a minute.
    //
    // And on `RSC`: with it the app answers the same path with the page's
    // payload for its own router, or a redirect to the URL that payload is
    // cached under, and neither is the page a browser asked for. The router's
    // other headers decide which of the two it is — the app redirects unless
    // `_rsc` is their hash — so they are in the key with it. A router's own
    // request has the headers its `_rsc` says, so this splits no entry of its.
    const htmlCachePolicy = new cloudfront.CachePolicy(this, 'HtmlCachePolicy', {
      cachePolicyName: resourceName(this, 'html'),
      defaultTtl: cdk.Duration.seconds(60),
      minTtl: cdk.Duration.seconds(60),
      maxTtl: cdk.Duration.seconds(300),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
        'x-cache-bypass',
        LOCALE_HEADER,
        ...ROUTER_HEADERS
      ),
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

    // --- Cache Policy: crawl files (sitemap, robots.txt) ---
    // The same bytes for every viewer and language, and fetched by crawlers far
    // more than by people, so none of the viewer's headers, cookies or query
    // string splits the key (under the HTML policy one copy per locale, and any
    // `?x` reaches the origin). An hour for both: robots.txt comes back from
    // Next with `max-age=0`, so `minTtl` sets the age, not the origin. A change
    // that must show sooner — the brand's noindex flipped — wants an invalidation.
    const crawlFilesCachePolicy = new cloudfront.CachePolicy(this, 'CrawlFilesCachePolicy', {
      cachePolicyName: resourceName(this, 'crawl'),
      defaultTtl: cdk.Duration.hours(1),
      minTtl: cdk.Duration.hours(1),
      maxTtl: cdk.Duration.hours(1),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    })

    // --- Response headers: HSTS (ADR-071) ---
    // Set here, not by the origin: only the TLS terminator knows the viewer
    // came over HTTPS, and a browser ignores the header over plain HTTP anyway.
    // One year, no preload (a mistake could not be undone), and
    // includeSubDomains only where the site asks — it binds every host under
    // the domain. The other security headers stay with the origin (ADR-071
    // decision 5).
    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: resourceName(this, 'security-headers'),
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: config.hstsIncludeSubDomains,
          preload: false,
          override: true,
        },
      },
    })

    // --- Response headers: files served from S3 on a Web Function site ---
    // What next.config.ts gives every response and, under the ibisOffice
    // directory, CORS for the sandboxed frame's opaque origin, and the proxy's
    // CSP — which, read at the web's runtime there, is fixed here at the deploy.
    const staticSecurityHeaders: cloudfront.ResponseSecurityHeadersBehavior = {
      strictTransportSecurity: {
        accessControlMaxAge: cdk.Duration.days(365),
        includeSubdomains: config.hstsIncludeSubDomains,
        preload: false,
        override: true,
      },
      frameOptions: { frameOption: cloudfront.HeadersFrameOption.SAMEORIGIN, override: true },
      contentTypeOptions: { override: true },
      referrerPolicy: {
        referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
        override: true,
      },
    }
    const permissionsPolicy: cloudfront.ResponseCustomHeader = {
      header: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=()',
      override: true,
    }
    const staticHeadersPolicy =
      staticFiles &&
      new cloudfront.ResponseHeadersPolicy(this, 'StaticHeaders', {
        responseHeadersPolicyName: resourceName(this, 'static-headers'),
        securityHeadersBehavior: staticSecurityHeaders,
        customHeadersBehavior: { customHeaders: [permissionsPolicy] },
      })
    const ibisOfficeHeadersPolicy =
      staticFiles &&
      new cloudfront.ResponseHeadersPolicy(this, 'IbisOfficeHeaders', {
        responseHeadersPolicyName: resourceName(this, 'ibis-office-headers'),
        securityHeadersBehavior: {
          ...staticSecurityHeaders,
          contentSecurityPolicy: {
            contentSecurityPolicy: staticFiles.ibisOfficePolicy,
            override: true,
          },
        },
        corsBehavior: {
          accessControlAllowOrigins: ['*'],
          accessControlAllowHeaders: ['*'],
          accessControlAllowMethods: ['GET', 'HEAD'],
          accessControlAllowCredentials: false,
          originOverride: true,
        },
        customHeadersBehavior: {
          customHeaders: [
            permissionsPolicy,
            { header: 'X-DNS-Prefetch-Control', value: 'off', override: true },
          ],
        },
      })

    // --- Viewer certificate ---
    const viewerCertificate = certificateArn
      ? acm.Certificate.fromCertificateArn(this, 'ViewerCert', certificateArn)
      : undefined

    // --- Behavior patterns ---
    // Shared: all behaviors use the CF Function (IP restriction + cache bypass).
    const fnAssociations: cloudfront.FunctionAssociation[] = [
      { function: viewerRequestFn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
    ]

    // Passthrough: no cache, forward everything to origin (auth, API)
    const passthrough: cloudfront.BehaviorOptions = {
      origin: albOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      functionAssociations: fnAssociations,
    }

    // Static: immutable assets with content-hash filenames
    const staticAssets: cloudfront.BehaviorOptions = {
      origin: staticFiles?.origin ?? albOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      responseHeadersPolicy: staticHeadersPolicy ?? responseHeadersPolicy,
      functionAssociations: fnAssociations,
    }
    const ibisOfficeAssets: cloudfront.BehaviorOptions = {
      ...staticAssets,
      responseHeadersPolicy: ibisOfficeHeadersPolicy ?? responseHeadersPolicy,
    }

    // HTML pages: short-lived cache, bypassed for requests with a session or an API token
    const htmlPages: cloudfront.BehaviorOptions = {
      origin: albOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: htmlCachePolicy,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      functionAssociations: fnAssociations,
    }

    // Crawl files: what the crawl policy keys on reaches the origin, and nothing
    // else — no cookie, so they are rendered as the anonymous viewer sees them
    const crawlFiles: cloudfront.BehaviorOptions = {
      origin: albOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: crawlFilesCachePolicy,
      responseHeadersPolicy,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
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
        // The ibisOffice build, versioned by directory (ADR-065)
        '/vendor/ibis-office/*': ibisOfficeAssets,
        '/auth/*': passthrough,
        '/api/*': passthrough,
        '/odata/*': odataFeed,
        '/robots.txt': crawlFiles,
        // Both the index, /sitemap.xml, and its files under /sitemap/
        '/sitemap*': crawlFiles,
      },
      ...(viewerCertificate && config.domainName
        ? {
            domainNames: siteDomainNames(config),
            certificate: viewerCertificate,
          }
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
