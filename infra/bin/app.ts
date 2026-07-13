#!/usr/bin/env node
/**
 * KUKAN CDK App — Entry Point (ADR-030 / ADR-031)
 *
 * Two modes:
 *   - Pipeline (default):  npx cdk deploy KukanPipeline
 *       Deploys the CDK Pipelines stack; pushes auto-deploy each environment as a Stage.
 *       Manual ops on a pipeline-managed env use its qualified path WITHOUT -c env
 *       (e.g. `npx cdk deploy 'KukanPipeline/Dev/KukanStack'`); the -c env synthesis
 *       path differs, changing physical names and forcing resource replacement.
 *   - Standalone (local):  npx cdk deploy -c env=dev 'Dev/**'
 *       Deploys one environment's Stage directly (for bootstrap / local iteration).
 *       Select the Stage with a glob — stacks nest under it (Dev/KukanStack), so
 *       `--all` (top-level only) finds nothing.
 *
 * Environments are defined in config/environments.ts (forks commit theirs; upstream
 * does not — it falls back to config/environments.example.ts on a fresh checkout).
 */

import { existsSync } from 'node:fs'
import * as cdk from 'aws-cdk-lib'
import { DEFAULT_REGION, resolveEnv, type EnvironmentConfig } from '../lib/config.js'
import { pascal } from '../lib/naming.js'
import { KukanStage } from '../lib/kukan-stage.js'
import { KukanPipelineStack } from '../lib/pipeline-stack.js'
import * as exampleEnvs from '../config/environments.example.js'

interface EnvModule {
  environments: Record<string, EnvironmentConfig>
  connectionArn: string
}

/** Prefer config/environments.ts (committed by forks); fall back to the example when absent. */
async function loadEnvironments(): Promise<EnvModule> {
  // Check the real file's existence directly so we can distinguish "file absent"
  // (→ example) from "file present but broken" (→ throw). A catch on
  // ERR_MODULE_NOT_FOUND cannot tell them apart: a bad import *inside* a real
  // environments.ts raises the same code and would silently fall back to the example.
  if (!existsSync(new URL('../config/environments.ts', import.meta.url))) {
    return exampleEnvs as EnvModule
  }
  // Present — import it and let any error (syntax, missing export, broken import)
  // propagate. Non-literal path so TypeScript does not require the file at compile time.
  const localPath = '../config/environments.js'
  return (await import(localPath)) as EnvModule
}

const app = new cdk.App()
const account = process.env.CDK_DEFAULT_ACCOUNT
if (!account) {
  throw new Error(
    'CDK_DEFAULT_ACCOUNT is not set. Run "aws sso login" or configure AWS credentials.'
  )
}

const { environments, connectionArn } = await loadEnvironments()

const standaloneEnv = app.node.tryGetContext('env') as string | undefined
if (standaloneEnv) {
  // --- Standalone mode: deploy one environment's Stage directly ---
  const config = environments[standaloneEnv]
  if (!config) {
    throw new Error(
      `Unknown environment "${standaloneEnv}". Defined: ${Object.keys(environments).join(', ')}`
    )
  }
  new KukanStage(app, pascal(standaloneEnv), {
    env: resolveEnv(config),
    config,
  })
} else {
  // --- Pipeline mode (default): deploy CDK Pipelines ---
  new KukanPipelineStack(app, 'KukanPipeline', {
    env: { account, region: DEFAULT_REGION },
    crossRegionReferences: true,
    environments,
    connectionArn,
  })
}
