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
import { needsGlobalStack, resolveEnv, validateSites, type EnvironmentConfig } from './config.js'
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

    // Multi-site environments (ADR-041): shared boxes + one stack per site.
    // Environments without `sites` keep the all-in-one KukanStack below with
    // unchanged logical IDs (guarded by the synth snapshot tests).
    if (config.sites?.length) {
      validateSites(config)
      const shared = new KukanSharedStack(this, 'KukanSharedStack', {
        env: { account, region },
        envConfig: config,
      })
      const siteStacks = config.sites.map(
        (site) =>
          new KukanSiteStack(this, `KukanSiteStack${pascal(site.name)}`, {
            env: { account, region },
            envConfig: config,
            site,
          })
      )
      for (const stack of siteStacks) {
        stack.addDependency(shared)
      }
      // First site is the canary: it deploys alone before the rest (ADR-041)
      for (const stack of siteStacks.slice(1)) {
        stack.addDependency(siteStacks[0])
      }
      return
    }

    // Create the us-east-1 global stack only when we must CREATE the cert/WAF.
    // When the ARNs are supplied (config.certificateArn / config.webAclArn), the main
    // stack consumes them as plain strings — no cross-region reference, which keeps this
    // compatible with CDK Pipelines (whose Lambda-backed cross-region support stack
    // cannot carry the Docker assets in the main stack). See ADR-030.
    const needGlobal = needsGlobalStack(config)

    let globalStack: KukanGlobalStack | undefined
    if (needGlobal) {
      globalStack = new KukanGlobalStack(this, 'KukanGlobalStack', {
        env: { account, region: 'us-east-1' },
        crossRegionReferences: true,
        envConfig: config,
      })
    }

    const mainStack = new KukanStack(this, 'KukanStack', {
      env: { account, region },
      // Cross-region references are only needed (and only safe outside CDK Pipelines)
      // when this stage creates the global stack itself.
      crossRegionReferences: needGlobal,
      envConfig: config,
      globalCertificateArn: config.certificateArn ?? globalStack?.certificateArn,
      globalWebAclArn: config.webAclArn ?? globalStack?.webAclArn,
    })

    if (globalStack) {
      mainStack.addDependency(globalStack)
    }
  }
}
