/**
 * KUKAN Stage — environment boundary (ADR-031).
 * Encapsulates the stacks for one environment:
 *   - KukanGlobalStack (us-east-1)   — ACM cert + WAF WebACL for CloudFront, only
 *     when CDK creates either
 *   - KukanStack (target region)     — single site: VPC, ECS, RDS, CloudFront, etc.
 *   - KukanSharedStack + one KukanSiteStack<Name> per site (target region) —
 *     multi-site (ADR-041), sites deployed in waves after a canary
 *
 * Stack names are namespaced by the Stage name (e.g. "Dev/KukanStack"),
 * which gives per-environment uniqueness for auto-named resources.
 */

import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import {
  deployWaves,
  needsGlobalStack,
  needsManagedWaf,
  rejectBlankEdgeArns,
  resolveEnv,
  resolveWafConfig,
  resolveWebCompute,
  validateSites,
  type EnvironmentConfig,
  type ResolvedWafConfig,
  resolveDeployConcurrency,
} from '../config.js'
import { envName, pascal } from '../naming.js'
import { KukanGlobalStack, managesWebAcl } from './global-stack.js'
import { KukanStack } from './kukan-stack.js'
import { KukanSharedStack } from './shared-stack.js'
import { KukanSiteStack } from './site-stack.js'

/**
 * Construct ids of the stacks a stage deploys, which CDK Pipelines also uses to
 * name its `<id>.Deploy` actions. Exported so anything reading those action
 * names back — the deploy notification — keys off the same names rather than
 * restating them.
 */
export const MAIN_STACK_ID = 'KukanStack'
export function siteStackId(siteName: string): string {
  return `KukanSiteStack${pascal(siteName)}`
}

export interface KukanStageProps extends cdk.StageProps {
  /** Environment definition for this stage. */
  config: EnvironmentConfig
  /**
   * Built for a pipeline, which cannot deploy the us-east-1 global stack: it is
   * left out (KukanPipelineStack already refuses an environment that needs it).
   */
  inPipeline?: boolean
}

export class KukanStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: KukanStageProps) {
    super(scope, id, props)

    const { config } = props
    const { account, region } = resolveEnv(config)

    // Cost allocation tags. `_shared` is every site's, and no site name starts
    // with `_`; a site stack sets its own (phase4-deploy, cost allocation tags)
    cdk.Tags.of(this).add('kukan:env', envName(this)!)
    cdk.Tags.of(this).add('kukan:site', '_shared')

    // Runs before the shape branch so `sites: []` is rejected instead of
    // silently falling back to the single-site shape below.
    const warnings = validateSites(config, this)
    // Whatever the shape, and whether or not this synth creates the WebACL:
    // a pipeline-managed environment keeps `waf` beside its pasted ARN, and
    // a typo there must fail here, not on the standalone deploy that reads it
    const waf = resolveWafConfig(config)

    // Multi-site environments (ADR-041): shared boxes + one stack per site.
    // Environments without `sites` keep the all-in-one KukanStack below with
    // unchanged logical IDs (guarded by the synth snapshot tests).
    if (config.sites?.length) {
      for (const warning of warnings) {
        cdk.Annotations.of(this).addWarningV2(warning.key, warning.message)
      }
      const globalStack = this.createGlobalStack(config, waf, account, props.inPipeline)
      const shared = new KukanSharedStack(this, 'KukanSharedStack', {
        env: { account, region },
        envConfig: config,
      })
      const siteStacks = config.sites.map(
        (site) =>
          new KukanSiteStack(this, siteStackId(site.name), {
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
      // Sites deploy in waves: the first alone as the canary, then
      // `deployConcurrency` at a time, each wave waiting for the whole previous
      // one. That bounds the rolling-update connection overlap (ECS runs old and
      // new tasks together, MaximumPercent 200) to the sites the connection
      // budget accounts for (validateSites).
      const waves = deployWaves(siteStacks, resolveDeployConcurrency(config))
      waves.forEach((wave, w) => {
        const previous = w === 0 ? [shared] : waves[w - 1]
        wave.forEach((stack) => previous.forEach((p) => stack.addStackDependency(p)))
      })
      if (globalStack) {
        siteStacks[0].addStackDependency(globalStack)
      }
      return
    }

    // New environments take the multi-site shape; the all-in-one stack stays
    // as it was for the ones already deployed in it
    if (resolveWebCompute(config) === 'web-function') {
      throw new Error(
        `Environment "${id}": webCompute "web-function" needs the multi-site shape — ` +
          'declare the site under `sites` (ADR-041, ADR-068)'
      )
    }
    // The all-in-one stack has its own ALB and no shared one to keep or drop
    for (const key of ['sharedAlb', 'webFunctionNetwork'] as const) {
      if (config[key] !== undefined) {
        throw new Error(`Environment "${id}": ${key} applies to the multi-site shape only`)
      }
    }
    rejectBlankEdgeArns(config, `Environment "${id}"`)
    const globalStack = this.createGlobalStack(config, waf, account, props.inPipeline)

    const mainStack = new KukanStack(this, MAIN_STACK_ID, {
      env: { account, region },
      // Cross-region references are only needed (and only safe outside CDK Pipelines)
      // when this stage creates the global stack itself.
      crossRegionReferences: globalStack !== undefined,
      envConfig: config,
      globalCertificateArn: config.certificateArn ?? globalStack?.certificateArn,
      globalWebAclArn: config.webAclArn ?? globalStack?.webAclArn,
    })

    if (globalStack) {
      mainStack.addStackDependency(globalStack)
    }
  }

  /**
   * Create the us-east-1 global stack only when we must CREATE the cert/WAF,
   * or, outside a pipeline, when a pasted ARN is its own WebACL — so a
   * standalone deploy of it reaches that WebACL's rules (managesWebAcl).
   * When the ARNs are supplied, the consuming stacks take them as plain strings
   * — no cross-region reference, which keeps this compatible with CDK Pipelines
   * (whose Lambda-backed cross-region support stack cannot carry the Docker
   * assets in the main stack; KukanPipelineStack rejects the combination). See ADR-030.
   */
  private createGlobalStack(
    config: EnvironmentConfig,
    waf: ResolvedWafConfig,
    account: string,
    inPipeline = false
  ): KukanGlobalStack | undefined {
    if (inPipeline) return undefined
    const entries = config.sites?.length ? config.sites : [config]
    if (!needsGlobalStack(config) && !entries.some((entry) => managesWebAcl(entry, account))) {
      return undefined
    }
    return new KukanGlobalStack(this, 'KukanGlobalStack', {
      env: { account, region: 'us-east-1' },
      crossRegionReferences: true,
      envConfig: config,
      waf,
    })
  }
}
