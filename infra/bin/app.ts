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
import { loadConfig } from '../lib/config.js'

const app = new cdk.App()

const config = loadConfig(app)
const region = app.node.tryGetContext('region') ?? 'ap-northeast-1'

// us-east-1 stack: ACM cert (for CloudFront) + optional WAF
let globalStack: KukanGlobalStack | undefined
if (config.domainName || config.enableWaf) {
  globalStack = new KukanGlobalStack(app, 'KukanGlobalStack', {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
    crossRegionReferences: true,
    enableWaf: config.enableWaf,
    domainName: config.domainName,
    hostedZoneId: config.hostedZoneId,
    hostedZoneName: config.hostedZoneName,
  })
}

new KukanStack(app, 'KukanStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
  crossRegionReferences: true,
  certArn: globalStack?.certificateArn,
  webAclArn: globalStack?.webAclArn,
})
