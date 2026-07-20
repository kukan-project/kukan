/**
 * KUKAN Stage — environment boundary (ADR-031).
 * Encapsulates the two stacks for one environment:
 *   - KukanGlobalStack (us-east-1) — ACM cert + WAF WebACL for CloudFront
 *   - KukanStack (target region)   — VPC, ECS, RDS, CloudFront, etc.
 *
 * Stack names are namespaced by the Stage name (e.g. "Dev/KukanStack"),
 * which gives per-environment uniqueness for auto-named resources.
 */

import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import {
  needsGlobalStack,
  needsManagedWaf,
  rejectBlankEdgeArns,
  resolveEnv,
  validateSites,
  type EnvironmentConfig,
} from './config.js'
import { pascal } from './naming.js'
import { KukanGlobalStack } from './global-stack.js'
import { KukanStack } from './kukan-stack.js'
import { KukanSharedStack } from './shared-stack.js'
import { KukanSiteStack } from './site-stack.js'

export interface KukanStageProps extends cdk.StageProps {
  /** Environment definition for this stage. */
  config: EnvironmentConfig
}

export class KukanStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: KukanStageProps) {
    super(scope, id, props)

    const { config } = props
    const { account, region } = resolveEnv(config)

    // Runs before the shape branch so `sites: []` is rejected instead of
    // silently falling back to the single-site shape below.
    const warnings = validateSites(config, this)

    // Multi-site environments (ADR-041): shared boxes + one stack per site.
    // Environments without `sites` keep the all-in-one KukanStack below with
    // unchanged logical IDs (guarded by the synth snapshot tests).
    if (config.sites?.length) {
      for (const warning of warnings) {
        cdk.Annotations.of(this).addWarningV2(warning.key, warning.message)
      }
      const globalStack = this.createGlobalStack(config, account)
      const shared = new KukanSharedStack(this, 'KukanSharedStack', {
        env: { account, region },
        envConfig: config,
      })
      const siteStacks = config.sites.map(
        (site) =>
          new KukanSiteStack(this, `KukanSiteStack${pascal(site.name)}`, {
            env: { account, region },
            crossRegionReferences: globalStack !== undefined,
            envConfig: config,
            site,
            globalCertificateArn:
              site.certificateArn ?? globalStack?.siteCertificateArns[site.name],
            globalWebAclArn:
              site.webAclArn ?? (needsManagedWaf(site) ? globalStack?.webAclArn : undefined),
          })
      )
      // Sites deploy one at a time: the first is the canary, and serializing
      // the rest bounds the rolling-update connection overlap (ECS runs old and
      // new tasks together, MaximumPercent 200) to a single site — exactly the
      // one doubling the connection budget accounts for (validateSites).
      siteStacks.forEach((stack, i) => {
        stack.addDependency(i === 0 ? shared : siteStacks[i - 1])
      })
      if (globalStack) {
        siteStacks[0].addDependency(globalStack)
      }
      return
    }

    rejectBlankEdgeArns(config, `Environment "${id}"`)
    const globalStack = this.createGlobalStack(config, account)

    const mainStack = new KukanStack(this, 'KukanStack', {
      env: { account, region },
      // Cross-region references are only needed (and only safe outside CDK Pipelines)
      // when this stage creates the global stack itself.
      crossRegionReferences: globalStack !== undefined,
      envConfig: config,
      globalCertificateArn: config.certificateArn ?? globalStack?.certificateArn,
      globalWebAclArn: config.webAclArn ?? globalStack?.webAclArn,
    })

    if (globalStack) {
      mainStack.addDependency(globalStack)
    }
  }

  /**
   * Create the us-east-1 global stack only when we must CREATE the cert/WAF.
   * When the ARNs are supplied, the consuming stacks take them as plain strings
   * — no cross-region reference, which keeps this compatible with CDK Pipelines
   * (whose Lambda-backed cross-region support stack cannot carry the Docker
   * assets in the main stack; KukanPipelineStack rejects the combination). See ADR-030.
   */
  private createGlobalStack(
    config: EnvironmentConfig,
    account: string
  ): KukanGlobalStack | undefined {
    if (!needsGlobalStack(config)) return undefined
    return new KukanGlobalStack(this, 'KukanGlobalStack', {
      env: { account, region: 'us-east-1' },
      crossRegionReferences: true,
      envConfig: config,
    })
  }
}
