/**
 * KUKAN Global CDK Stack (us-east-1)
 * Resources that must reside in us-east-1 for CloudFront integration:
 *   - ACM Certificate (CloudFront viewer certificate)
 *   - WAF WebACL (CLOUDFRONT scope)
 */

import * as cdk from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as route53 from 'aws-cdk-lib/aws-route53'
import type { Construct } from 'constructs'
import { loadConfig, needsManagedCert, needsManagedWaf, type EnvironmentConfig } from './config.js'
import { pascal } from './naming.js'
import { WafConstruct } from './constructs/waf.js'

export interface KukanGlobalStackProps extends cdk.StackProps {
  /** Environment definition for this stack (ADR-031). */
  envConfig?: EnvironmentConfig
}

export class KukanGlobalStack extends cdk.Stack {
  /** CloudFront viewer certificate ARN (undefined when no custom domain). */
  readonly certificateArn?: string
  /** WAF WebACL ARN for CloudFront (undefined when WAF is disabled). */
  readonly webAclArn?: string
  /** Per-site certificate ARNs by site name (multi-site, ADR-041). */
  readonly siteCertificateArns: Record<string, string> = {}

  constructor(scope: Construct, id: string, props: KukanGlobalStackProps = {}) {
    super(scope, id, props)

    // Multi-site (ADR-041): one cert per site domain, one WebACL shared by the
    // sites that resolve to WAF without their own ARN. Env-level edge fields
    // are rejected by validateSites, so the single-site path below stays inert
    // — branch anyway to keep its logical IDs untouched.
    if (props.envConfig?.sites?.length) {
      for (const site of props.envConfig.sites) {
        // validateSites enforces the hosted zone when the cert is created here
        if (
          !site.domainName ||
          !needsManagedCert(site) ||
          !site.hostedZoneId ||
          !site.hostedZoneName
        )
          continue
        this.siteCertificateArns[site.name] = this.createCertificate(
          pascal(site.name),
          site.domainName,
          site.hostedZoneId,
          site.hostedZoneName,
          `ACM certificate ARN for site "${site.name}" (sites[].certificateArn)`
        )
      }
      if (props.envConfig.sites.some(needsManagedWaf)) {
        this.webAclArn = this.createWebAcl('Shared WAF WebACL ARN (sites[].webAclArn)')
      }
      cdk.Tags.of(this).add('kukan:stack', 'global')
      return
    }

    const config = loadConfig(this, props.envConfig)

    // Create only the missing half: with one ARN supplied and the other not,
    // this stack still synthesizes — recreating the supplied side would leave
    // an unused duplicate (and a billed WebACL). KukanConfig strips the ARNs,
    // so read them from the raw env entry. The '' id suffix keeps the
    // pre-existing single-site logical IDs (Zone / Certificate).
    if (
      config.domainName &&
      config.hostedZoneId &&
      config.hostedZoneName &&
      !props.envConfig?.certificateArn
    ) {
      this.certificateArn = this.createCertificate(
        '',
        config.domainName,
        config.hostedZoneId,
        config.hostedZoneName,
        'ACM certificate ARN (certificateArn)'
      )
    }

    if (config.enableWaf && !props.envConfig?.webAclArn) {
      this.webAclArn = this.createWebAcl('WAF WebACL ARN (webAclArn)')
    }

    cdk.Tags.of(this).add('kukan:stack', 'global')
  }

  /** DNS-validated viewer certificate + its paste-target output.
   *  RETAINed (see retainEdgeResource). */
  private createCertificate(
    idSuffix: string,
    domainName: string,
    hostedZoneId: string,
    zoneName: string,
    outputDescription: string
  ): string {
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, `Zone${idSuffix}`, {
      hostedZoneId,
      zoneName,
    })
    const certificate = new acm.Certificate(this, `Certificate${idSuffix}`, {
      domainName,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    })
    this.retainEdgeResource(certificate.node.defaultChild as cdk.CfnResource)
    new cdk.CfnOutput(this, `CertificateArn${idSuffix}`, {
      value: certificate.certificateArn,
      description: outputDescription,
    })
    return certificate.certificateArn
  }

  /** WAF WebACL (CLOUDFRONT scope) + its paste-target output. RETAINed (see
   *  retainEdgeResource) — but an orphaned WebACL keeps billing (~$9/month),
   *  so delete it once nothing references it. */
  private createWebAcl(outputDescription: string): string {
    const waf = new WafConstruct(this, 'Waf')
    this.retainEdgeResource(waf.webAcl)
    new cdk.CfnOutput(this, 'WebAclArn', {
      value: waf.webAcl.attrArn,
      description: outputDescription,
    })
    return waf.webAcl.attrArn
  }

  /**
   * Mark an edge resource RETAIN. It protects two external-ARN switchover paths:
   *   - one of two managed resources switched: this stack is re-synthesized
   *     without that resource, so its update removes it from the template while
   *     CloudFront (deployed after this stack) still references it — RETAIN
   *     detaches instead of failing on the in-use delete.
   *   - the LAST managed resource switched: needsGlobalStack becomes false and
   *     this whole stack drops out of the assembly, so no removal update is
   *     ever sent — the physical stack lingers still owning the resources.
   *     Cleanup is to delete the stack by physical name; RETAIN keeps the
   *     resources alive through that stack deletion (do NOT delete them directly
   *     first — that drifts the still-managing stack).
   *
   * The Metadata is not decoration: CloudFormation reports "No updates are to be
   * performed" when a stack's only diffs are DeletionPolicy / Outputs, so
   * upgrading an existing GlobalStack would skip the update and never persist
   * RETAIN. A recognized property change (Metadata) forces the update through.
   * After upgrading, confirm `DeletionPolicy: Retain` via
   * `aws cloudformation get-template` before switching to external ARNs.
   */
  private retainEdgeResource(resource: cdk.CfnResource): void {
    resource.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN)
    resource.addMetadata('kukan:retain', 'in-use edge resource — persist RETAIN before removal')
  }
}
