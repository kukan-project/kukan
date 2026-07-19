/**
 * Synth test harness (ADR-041 guardrail).
 *
 * Synthesizes a KukanStage the way the CLI does (cdk.json feature flags included)
 * but with AWS context lookups pre-seeded so tests never touch the network.
 * Normalized-template snapshots are the drift guard that lets the multi-site
 * refactor prove it leaves single-site environments byte-identical.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as cdk from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { KukanStage } from '../../kukan-stage.js'
import type { EnvironmentConfig } from '../../config.js'

// Asset paths in the constructs (e.g. DockerImageAsset `directory: '../'`) are
// relative to the CDK CLI's working directory, `infra/` — match it here.
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)))

export const TEST_ACCOUNT = '123456789012'
export const TEST_REGION = 'ap-northeast-1'

const cdkJson = JSON.parse(readFileSync(new URL('../../../cdk.json', import.meta.url), 'utf8')) as {
  context?: Record<string, unknown>
}

// Pre-seeded lookups (network.ts AZ + CloudFront prefix-list). The key format follows
// the installed aws-cdk-lib; on a format mismatch CDK falls back to its deterministic
// dummy values, so tests stay offline either way.
const LOOKUP_CONTEXT: Record<string, unknown> = {
  [`availability-zones:account=${TEST_ACCOUNT}:region=${TEST_REGION}`]: [
    `${TEST_REGION}a`,
    `${TEST_REGION}c`,
  ],
  [`cc-api-provider:account=${TEST_ACCOUNT}:expectedMatchCount=exactly-one:propertiesToReturn.0=PrefixListId:propertyMatch.PrefixListName=com.amazonaws.global.cloudfront.origin-facing:region=${TEST_REGION}:typeName=AWS$:$:EC2$:$:PrefixList`]:
    [{ PrefixListId: 'pl-00000000000000000' }],
}

/** Synthesize a stage named `Dev` for the given environment definition. */
export function synthStage(config: Omit<EnvironmentConfig, 'account'>): KukanStage {
  const app = new cdk.App({ context: { ...cdkJson.context, ...LOOKUP_CONTEXT } })
  return new KukanStage(app, 'Dev', { config: { account: TEST_ACCOUNT, ...config } })
}

/** Template of a stack inside the stage ('KukanStack' / 'KukanGlobalStack'). */
export function stackTemplate(stage: cdk.Stage, id: string): Template {
  return Template.fromStack(stage.node.findChild(id) as cdk.Stack)
}

/** Replace 64-hex asset hashes so app-source changes don't churn infra snapshots. */
export function normalize(template: Template): unknown {
  return JSON.parse(JSON.stringify(template.toJSON()).replace(/[0-9a-f]{64}/g, 'ASSET_HASH'))
}
