#!/usr/bin/env node
/**
 * KUKAN CDK App — Entry Point
 * Deploy: npx cdk deploy --all -c scale=small
 *
 * KukanGlobalStack (us-east-1) is created when domainName or enableWaf is set:
 *   - ACM Certificate  (when domainName is configured)
 *   - WAF WebACL       (when enableWaf is true, managed rules only)
 *
 * IP restriction (allowedIpRanges) uses a CloudFront Function — no WAF needed.
 */

import * as cdk from 'aws-cdk-lib'
import { KukanStack } from '../lib/kukan-stack.js'
import { KukanGlobalStack } from '../lib/kukan-global-stack.js'

const app = new cdk.App()

const region = app.node.tryGetContext('region') ?? 'ap-northeast-1'
const allowedIpRanges = app.node.tryGetContext('allowedIpRanges') as string[] | undefined
// Secure by default: WAF auto-enabled when no IP restriction is set
const enableWafExplicit = app.node.tryGetContext('enableWaf') as boolean | undefined
const enableWaf = enableWafExplicit ?? (allowedIpRanges ? false : true)
const domainName = app.node.tryGetContext('domainName') as string | undefined
const hostedZoneId = app.node.tryGetContext('hostedZoneId') as string | undefined
const hostedZoneName = app.node.tryGetContext('hostedZoneName') as string | undefined

// us-east-1 stack: ACM cert (for CloudFront) + optional WAF
let globalStack: KukanGlobalStack | undefined
if (domainName || enableWaf) {
  globalStack = new KukanGlobalStack(app, 'KukanGlobalStack', {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
    crossRegionReferences: true,
    enableWaf,
    domainName,
    hostedZoneId,
    hostedZoneName,
  })
}

new KukanStack(app, 'KukanStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
  crossRegionReferences: true,
  certArn: globalStack?.certificateArn,
  webAclArn: globalStack?.webAclArn,
})
