#!/usr/bin/env node
/**
 * KUKAN CDK App — Entry Point
 * Deploy: npx cdk deploy -c scale=small
 */

import * as cdk from 'aws-cdk-lib'
import { KukanStack } from '../lib/kukan-stack.js'

const app = new cdk.App()

const region = app.node.tryGetContext('region') ?? 'ap-northeast-1'

new KukanStack(app, 'KukanStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
})
