#!/usr/bin/env node
/**
 * KUKAN CDK App — Entry Point
 * Deploy: npx cdk deploy --all -c scale=small
 *
 * Two stacks:
 *   KukanGlobalStack (us-east-1) — ACM cert + WAF WebACL for CloudFront
 *   KukanStack (ap-northeast-1)  — VPC, ECS, RDS, CloudFront, etc.
 */

import * as cdk from 'aws-cdk-lib'
import { KukanGlobalStack } from '../lib/global-stack.js'
import { KukanStack } from '../lib/kukan-stack.js'

const app = new cdk.App()
const account = process.env.CDK_DEFAULT_ACCOUNT
const region = (app.node.tryGetContext('region') ?? 'ap-northeast-1') as string

// --- Determine whether GlobalStack is needed ---
// Mirror enableWaf default from config.ts: OFF when allowedIpRanges is set (saves ~$9/month).
const domainName = app.node.tryGetContext('domainName') as string | undefined
const allowedIpRanges = app.node.tryGetContext('allowedIpRanges') as string[] | undefined
const enableWafExplicit = app.node.tryGetContext('enableWaf') as boolean | undefined
const enableWaf = enableWafExplicit ?? !allowedIpRanges

const needsGlobalStack = !!domainName || enableWaf

// --- Global Stack (us-east-1) ---
let globalStack: KukanGlobalStack | undefined
if (needsGlobalStack) {
  globalStack = new KukanGlobalStack(app, 'KukanGlobalStack', {
    env: { account, region: 'us-east-1' },
    crossRegionReferences: true,
  })
}

// --- Main Stack ---
const mainStack = new KukanStack(app, 'KukanStack', {
  env: { account, region },
  crossRegionReferences: true,
  globalCertificateArn: globalStack?.certificateArn,
  globalWebAclArn: globalStack?.webAclArn,
})

if (globalStack) {
  mainStack.addDependency(globalStack)
}
