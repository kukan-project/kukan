/**
 * KUKAN WAF Construct
 * WAF WebACL with AWS managed rule groups, two rate-based rules and the log of
 * what the rules matched (CLOUDFRONT scope). Deployed in us-east-1 via
 * KukanGlobalStack, one WebACL shared by the environment's sites.
 *
 * IP restriction is handled by CloudFront Function (see cf-functions/viewer-request.js).
 */

import { isIP } from 'node:net'
import * as cdk from 'aws-cdk-lib'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as wafv2 from 'aws-cdk-lib/aws-wafv2'
import { Construct } from 'constructs'
import { WAF_RATE_LIMIT_WINDOW_SEC, type ResolvedWafConfig } from '../config.js'
import { envPrefix } from '../naming.js'

/**
 * Paths the catch-all rate rule does not count. CloudFront-scope WAF sees
 * cache hits too, and one page view fetches a dozen of these; counting them
 * would make the limit a page budget rather than a request budget.
 */
const UNCOUNTED_PATH_PREFIXES = ['/_next/static/', '/vendor/ibis-office/']

/** Better Auth's mount in the API (packages/api/src/app.ts). */
const AUTH_PATH_PREFIX = '/api/auth/'

/** Key of the WebACL-level body the rate rules answer with in block mode. */
const RATE_LIMITED_BODY_KEY = 'rate-limited'

/** Required prefix of a bucket WAF logs to. */
const WAF_LOG_BUCKET_PREFIX = 'aws-waf-logs-'

/** S3's limit on a bucket name. */
const MAX_BUCKET_NAME_LENGTH = 63

type Statement = wafv2.CfnWebACL.StatementProperty

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

/** The URI path starts with `prefix`, compared after `transforms` in order. */
function uriPathStartsWith(prefix: string, transforms: TextTransformation[]): Statement {
  return {
    byteMatchStatement: {
      fieldToMatch: { uriPath: {} },
      positionalConstraint: 'STARTS_WITH',
      searchString: prefix,
      textTransformations: transforms.map((type, priority) => ({ priority, type })),
    },
  }
}

/** The raw URI path contains `needle`. */
function uriPathContains(needle: string): Statement {
  return {
    byteMatchStatement: {
      fieldToMatch: { uriPath: {} },
      positionalConstraint: 'CONTAINS',
      searchString: needle,
      textTransformations: [{ priority: 0, type: 'NONE' }],
    },
  }
}

type TextTransformation = 'NONE' | 'URL_DECODE' | 'NORMALIZE_PATH_WIN'

/**
 * A static asset, judged on the raw path and strictly: the prefix, and no
 * dot segment, escape or backslash anywhere, the same test the viewer-request
 * function applies to the ibisOffice files. A spelling such as
 * `/vendor/ibis-office/../../api/auth/x` is forwarded raw and resolves at the
 * origin to the sign-in route, so it must stay on the counted side — as must
 * anything else ambiguous, since the exclusion is the one place a mistake
 * uncounts a request.
 */
function isStaticAsset(): Statement {
  return {
    andStatement: {
      statements: [
        {
          orStatement: {
            statements: UNCOUNTED_PATH_PREFIXES.map((p) => uriPathStartsWith(p, ['NONE'])),
          },
        },
        ...['..', '%', '\\'].map((needle) => not(uriPathContains(needle))),
      ],
    },
  }
}

/**
 * A sign-in request in either spelling an origin might read: decoded, and
 * decoded with backslashes as slashes and dot segments resolved — the two
 * parsers disagree on `..`, and the rule must count under both.
 */
function isAuthPath(): Statement {
  return {
    orStatement: {
      statements: [
        uriPathStartsWith(AUTH_PATH_PREFIX, ['URL_DECODE']),
        uriPathStartsWith(AUTH_PATH_PREFIX, ['URL_DECODE', 'NORMALIZE_PATH_WIN']),
      ],
    },
  }
}

function not(statement: Statement): Statement {
  return { notStatement: { statement } }
}

/** AWS refuses an And of one statement, so one is returned as it is. */
function allOf(statements: Statement[]): Statement {
  return statements.length === 1 ? statements[0] : { andStatement: { statements } }
}

export class WafConstruct extends Construct {
  readonly webAcl: wafv2.CfnWebACL
  /** The IP sets the WebACL references, so they must outlive the stack whenever it does. */
  readonly exemptIpSets: wafv2.CfnIPSet[]
  /** Where the counted and blocked requests are logged (undefined with logging off). */
  readonly logBucket?: s3.Bucket

  /** `waf`: the environment's rate rules and logging (resolveWafConfig). */
  constructor(scope: Construct, id: string, waf: ResolvedWafConfig) {
    super(scope, id)

    const { rateLimit, logging } = waf
    this.exemptIpSets = this.createExemptIpSets(rateLimit.exemptIpRanges)
    const exempt = this.exemptIpSets.map((ipSet) =>
      not({ ipSetReferenceStatement: { arn: ipSet.attrArn } })
    )
    const block = rateLimit.mode === 'block'

    // CLOUDFRONT scope — must be deployed in us-east-1 (KukanGlobalStack)
    this.webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      defaultAction: { allow: {} },
      scope: 'CLOUDFRONT',
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'kukan-waf',
      },
      // The rate rules come after the managed groups, so a request a managed
      // rule blocked is neither counted against its IP nor logged twice
      rules: [
        managedRuleGroup('AWSManagedRulesCommonRuleSet', 10, 'common'),
        managedRuleGroup('AWSManagedRulesKnownBadInputsRuleSet', 20, 'bad-inputs'),
        managedRuleGroup('AWSManagedRulesAmazonIpReputationList', 30, 'ip-reputation'),
        this.rateRule(
          'RateLimitAll',
          40,
          'all',
          rateLimit.limit,
          block,
          allOf([not(isStaticAsset()), ...exempt])
        ),
        this.rateRule(
          'RateLimitAuth',
          50,
          'auth',
          rateLimit.authLimit,
          block,
          allOf([isAuthPath(), ...exempt])
        ),
      ],
      // Plain text, so a rate block is told apart from an origin 403 by its body
      ...(block && {
        customResponseBodies: {
          [RATE_LIMITED_BODY_KEY]: {
            contentType: 'TEXT_PLAIN',
            content: 'Too many requests from your address. Please wait a few minutes and retry.\n',
          },
        },
      }),
    })

    if (logging) {
      this.logBucket = this.createLogging(logging.retentionDays)
    }

    cdk.Tags.of(this).add('kukan:component', 'waf')
  }

  /** A rate-based rule over the requests `scopeDown` admits, aggregated on the viewer IP. */
  private rateRule(
    name: string,
    priority: number,
    metricSuffix: string,
    limit: number,
    block: boolean,
    scopeDown: Statement
  ): wafv2.CfnWebACL.RuleProperty {
    return {
      name,
      priority,
      action: block
        ? {
            block: {
              customResponse: {
                responseCode: 429,
                customResponseBodyKey: RATE_LIMITED_BODY_KEY,
                responseHeaders: [
                  { name: 'Retry-After', value: String(WAF_RATE_LIMIT_WINDOW_SEC) },
                ],
              },
            },
          }
        : { count: {} },
      statement: {
        rateBasedStatement: {
          aggregateKeyType: 'IP',
          limit,
          evaluationWindowSec: WAF_RATE_LIMIT_WINDOW_SEC,
          scopeDownStatement: scopeDown,
        },
      },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: `kukan-waf-rate-${metricSuffix}`,
      },
    }
  }

  /**
   * The exempt ranges as IP sets, one per address version — an IP set holds
   * one version, and either set exists only when the list has ranges of it.
   */
  private createExemptIpSets(ranges: string[]): wafv2.CfnIPSet[] {
    const isV6 = (range: string) => isIP(range.split('/')[0]) === 6
    const byVersion = {
      IPV4: ranges.filter((r) => !isV6(r)),
      IPV6: ranges.filter(isV6),
    }
    return Object.entries(byVersion)
      .filter(([, addresses]) => addresses.length > 0)
      .map(
        ([ipAddressVersion, addresses]) =>
          new wafv2.CfnIPSet(this, `RateLimitExempt${ipAddressVersion}`, {
            scope: 'CLOUDFRONT',
            ipAddressVersion,
            addresses,
            description: 'Addresses the rate-based rules do not count',
          })
      )
  }

  /**
   * The WebACL's log: only the requests a rule counted or blocked, to a bucket
   * in this (us-east-1) stack. The full access log is CloudFront's, which is
   * free; WAF logs are billed per GB, so the allowed requests are dropped.
   */
  private createLogging(retentionDays: number): s3.Bucket {
    const { account } = cdk.Stack.of(this)
    const bucketName = `${WAF_LOG_BUCKET_PREFIX}${envPrefix(this)}-${account}`
    if (!cdk.Token.isUnresolved(bucketName) && bucketName.length > MAX_BUCKET_NAME_LENGTH) {
      throw new Error(
        `WAF log bucket name "${bucketName}" is longer than S3 allows (${MAX_BUCKET_NAME_LENGTH}): ` +
          'shorten the environment name'
      )
    }
    // RETAIN like the CloudFront access log bucket: the record outlives the stack
    const bucket = new s3.Bucket(this, 'LogBucket', {
      bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ id: 'ExpireWafLogs', expiration: cdk.Duration.days(retentionDays) }],
    })

    // The grants the log delivery service needs; CfnLoggingConfiguration adds none
    const delivery = new iam.ServicePrincipal('delivery.logs.amazonaws.com')
    const sourceArn = cdk.Stack.of(this).formatArn({ service: 'logs', resource: '*' })
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AWSLogDeliveryWrite',
        principals: [delivery],
        actions: ['s3:PutObject'],
        resources: [bucket.arnForObjects(`AWSLogs/${account}/*`)],
        conditions: {
          StringEquals: {
            's3:x-amz-acl': 'bucket-owner-full-control',
            'aws:SourceAccount': account,
          },
          ArnLike: { 'aws:SourceArn': sourceArn },
        },
      })
    )
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AWSLogDeliveryAclCheck',
        principals: [delivery],
        actions: ['s3:GetBucketAcl', 's3:ListBucket'],
        resources: [bucket.bucketArn],
        conditions: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: { 'aws:SourceArn': sourceArn },
        },
      })
    )

    const logging = new wafv2.CfnLoggingConfiguration(this, 'Logging', {
      resourceArn: this.webAcl.attrArn,
      logDestinationConfigs: [bucket.bucketArn],
      loggingFilter: {
        DefaultBehavior: 'DROP',
        Filters: [
          {
            Behavior: 'KEEP',
            Requirement: 'MEETS_ANY',
            Conditions: [
              { ActionCondition: { Action: 'BLOCK' } },
              { ActionCondition: { Action: 'COUNT' } },
            ],
          },
        ],
      },
      // The session token and bearer tokens have no place in a log
      redactedFields: [
        { singleHeader: { Name: 'cookie' } },
        { singleHeader: { Name: 'authorization' } },
      ],
    })
    // AWS checks the grants when the configuration is created, so the policy
    // must land first — the implicit order (bucket, not its policy) does not do
    if (bucket.policy) {
      logging.addDependency(bucket.policy.node.defaultChild as cdk.CfnResource)
    }
    return bucket
  }
}
