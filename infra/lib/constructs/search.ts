/**
 * KUKAN Search Construct
 * OpenSearch domain (VPC mode) with kuromoji plugin for Japanese search.
 */

import { fileURLToPath } from 'node:url'
import * as cdk from 'aws-cdk-lib'
import * as cr from 'aws-cdk-lib/custom-resources'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import type * as ecs from 'aws-cdk-lib/aws-ecs'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice'
import { Construct } from 'constructs'
import type { KukanConfig } from '../config.js'
import type {
  SearchSecurityProperties,
  SiteSearchRole,
} from '../lambda/search-security-handler/index.js'
import { resourceName, taskRoleName } from '../naming.js'

/** One site on the domain (ADR-069). */
export interface SearchTenant {
  /** The site's prefix (naming sitePrefix): its OpenSearch role, and its task roles' names. */
  sitePrefix: string
  /** OPENSEARCH_INDEX_PREFIX its tasks run with. */
  indexPrefix: string
}

/**
 * What a site's task roles may do on the domain, `indices_all` on its own
 * `<prefix>-search*` indexes only (ADR-069). One constant, so a change to it
 * re-runs the custom resource that writes it. Two of the cluster permissions
 * reach past the site: cluster_monitor shows other sites' index names and
 * mappings (not documents), and tasks/cancel could cancel their reindex.
 */
export const SITE_SEARCH_PERMISSIONS = {
  cluster: ['cluster_composite_ops', 'cluster_monitor', 'cluster:admin/tasks/cancel'],
  index: ['indices_all'],
} as const

export interface SearchProps {
  config: KukanConfig
  vpc: ec2.IVpc
  searchSecurityGroup: ec2.ISecurityGroup
  /** Every site whose tasks use the domain: each gets a role of its own. */
  tenants: SearchTenant[]
}

/** What a site's tasks need of the domain: where it is, and what to be granted. */
export interface SearchDomainRef {
  endpoint: string
  arn: string
}

/**
 * Point a task at the domain and let its role call it: the task signs its
 * requests as that role (SigV4), so the domain policy can name principals.
 */
export function connectSearch(
  config: KukanConfig,
  domain: SearchDomainRef,
  taskDef: ecs.TaskDefinition,
  environment: Record<string, string>,
  indexPrefix: string | undefined
) {
  taskDef.taskRole.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['es:ESHttp*'],
      resources: [`${domain.arn}/*`],
    })
  )
  environment.OPENSEARCH_URL = `https://${domain.endpoint}`
  environment.OPENSEARCH_AWS_REGION = cdk.Aws.REGION
  environment.OPENSEARCH_REPLICAS = String(config.opensearch.indexReplicas)
  if (indexPrefix) {
    environment.OPENSEARCH_INDEX_PREFIX = indexPrefix
  }
}

export class SearchConstruct extends Construct {
  readonly domain: opensearch.Domain
  readonly ref: SearchDomainRef

  constructor(scope: Construct, id: string, props: SearchProps) {
    super(scope, id)

    const { config, vpc, searchSecurityGroup } = props

    // Service-linked role required for OpenSearch VPC access (idempotent)
    const slr = new cr.AwsCustomResource(this, 'OpensearchSlr', {
      onCreate: {
        service: 'IAM',
        action: 'createServiceLinkedRole',
        parameters: { AWSServiceName: 'opensearchservice.amazonaws.com' },
        physicalResourceId: cr.PhysicalResourceId.of('opensearch-slr'),
        ignoreErrorCodesMatching: 'InvalidInput',
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    })

    // The domain's master user, the role the security handler runs as. Its
    // trust names the account too, for an operator to look at the domain by
    // hand — only with sts:AssumeRole on it in their own policy.
    const adminRole = new iam.Role(this, 'AdminRole', {
      roleName: resourceName(this, 'search-admin'),
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lambda.amazonaws.com'),
        new iam.AccountRootPrincipal()
      ),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    })

    const domainName = resourceName(this, 'search')
    this.domain = new opensearch.Domain(this, 'Domain', {
      domainName,
      version: opensearch.EngineVersion.openSearch('3.5'),
      vpc,
      vpcSubnets: [
        {
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          onePerAz: true,
          availabilityZones: config.opensearch.multiAz
            ? undefined
            : [cdk.Stack.of(this).availabilityZones[0]],
        },
      ],
      securityGroups: [searchSecurityGroup],
      capacity: {
        dataNodeInstanceType: config.opensearch.instanceType,
        dataNodes: config.opensearch.instanceCount,
        multiAzWithStandbyEnabled: false,
      },
      ebs: {
        volumeSize: config.opensearch.volumeSize,
        volumeType: ec2.EbsDeviceVolumeType.GP3,
      },
      nodeToNodeEncryption: true,
      encryptionAtRest: { enabled: true },
      enforceHttps: true,
      // Per-site index permissions (ADR-069). Cannot be turned off again once
      // on. IAM principals only: no internal users, so no passwords.
      fineGrainedAccessControl: { masterUserArn: adminRole.roleArn },
      zoneAwareness: config.opensearch.multiAz ? { availabilityZoneCount: 2 } : undefined,
      // Signed requests only: the account's principals, each as far as its
      // own policy grants (the site tasks, through connectSearch). An unsigned
      // request — anything a fetch from inside the VPC can be made to send —
      // is refused. HTTP API only, no domain management.
      accessPolicies: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          principals: [new iam.AccountRootPrincipal()],
          actions: ['es:ESHttp*'],
          resources: [`arn:aws:es:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:domain/${domainName}/*`],
        }),
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      // analysis-kuromoji plugin is pre-installed on all OpenSearch domains
    })

    // Ensure service-linked role is created before the domain
    this.domain.node.addDependency(slr)

    this.ref = { endpoint: this.domain.domainEndpoint, arn: this.domain.domainArn }

    this.createSiteRoles(props, adminRole)

    cdk.Tags.of(this).add('kukan:component', 'search')
  }

  /**
   * OpenSearch roles and mappings have no CloudFormation resource: a handler
   * writes them through the security API, as the master user. The mappings
   * name task roles by ARN, built from the fixed names the sites give them,
   * so they exist before the sites deploy (ADR-069 §6).
   */
  private createSiteRoles(props: SearchProps, adminRole: iam.Role) {
    const { vpc, searchSecurityGroup, tenants } = props
    const stack = cdk.Stack.of(this)

    // PUT and DELETE are the handler's writes; GET is for the operator who
    // assumes the role to check the domain by hand (the deploy spec's steps)
    adminRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['es:ESHttpGet', 'es:ESHttpPut', 'es:ESHttpDelete'],
        resources: [`${this.domain.domainArn}/*`],
      })
    )

    // Into the domain on 443 and nowhere else. The VPC has no NAT: the
    // handler answers the provider framework (outside the VPC), which is what
    // reports to CloudFormation, so it needs no way out.
    const handlerSg = new ec2.SecurityGroup(this, 'SecurityHandlerSg', {
      vpc,
      description: 'OpenSearch security role handler (ADR-069)',
      allowAllOutbound: false,
    })
    handlerSg.connections.allowTo(searchSecurityGroup, ec2.Port.tcp(443), 'Security role handler')

    const handler = new lambdaNodejs.NodejsFunction(this, 'SecurityHandler', {
      entry: fileURLToPath(new URL('../lambda/search-security-handler/index.ts', import.meta.url)),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      role: adminRole,
      // Room for the handler's retries while the security API settles after
      // the blue/green update that turns FGAC on
      timeout: cdk.Duration.minutes(15),
      logGroup: new logs.LogGroup(this, 'SecurityHandlerLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
      }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [handlerSg],
      bundling: { minify: false, sourcesContent: false },
    })

    const provider = new cr.Provider(this, 'SecurityProvider', {
      onEventHandler: handler,
      logGroup: new logs.LogGroup(this, 'SecurityProviderLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
      }),
    })

    const taskRoleArn = (prefix: string, service: 'web' | 'worker') =>
      stack.formatArn({
        service: 'iam',
        region: '',
        resource: 'role',
        resourceName: taskRoleName(prefix, service),
      })
    const roles: SiteSearchRole[] = tenants.map((tenant) => ({
      Name: tenant.sitePrefix,
      Permissions: {
        cluster_permissions: [...SITE_SEARCH_PERMISSIONS.cluster],
        index_permissions: [
          {
            index_patterns: [`${tenant.indexPrefix}-search*`],
            allowed_actions: [...SITE_SEARCH_PERMISSIONS.index],
          },
        ],
      },
      BackendRoles: [
        taskRoleArn(tenant.sitePrefix, 'web'),
        taskRoleArn(tenant.sitePrefix, 'worker'),
      ],
    }))

    const siteRoles = new cdk.CustomResource(this, 'SiteRoles', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::KukanSearchSiteRoles',
      properties: {
        Endpoint: this.domain.domainEndpoint,
        Roles: roles,
      } satisfies SearchSecurityProperties,
    })
    // After the domain's every update (FGAC, its access policy), not only
    // after the endpoint exists
    siteRoles.node.addDependency(this.domain)
  }
}
