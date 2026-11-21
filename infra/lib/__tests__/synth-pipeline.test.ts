/**
 * One pipeline stack per environment (ADR-074). Each environment's Stage is
 * built outside its pipeline stack, at the path the single KukanPipeline stack
 * once gave it, so splitting the pipelines leaves the app stacks of a deployed
 * environment as they are: the same stack names and the same templates.
 */

import { describe, it, expect } from 'vitest'
import { Template } from 'aws-cdk-lib/assertions'
import * as cdk from 'aws-cdk-lib'
import {
  pipelinesInAccount,
  resolveEnv,
  resolvePipelinePlacement,
  type EnvironmentConfig,
} from '../config.js'
import { pascal } from '../naming.js'
import { KukanStage } from '../stacks/kukan-stage.js'
import { buildPipelines } from '../stacks/pipeline-stack.js'
import { testApp, TEST_ACCOUNT, TEST_REGION } from './helpers/synth.js'

const OTHER_ACCOUNT = '210987654321'
const CONNECTION = `arn:aws:codeconnections:${TEST_REGION}:${TEST_ACCOUNT}:connection/x`

/** Two environments on branches that drift apart: demo ahead of main. */
const ENVIRONMENTS: Record<string, EnvironmentConfig> = {
  demo: {
    account: TEST_ACCOUNT,
    githubRepo: 'example/kukan',
    deployBranch: 'demo',
    deployNotification: true,
    sites: [
      { name: 'main', enableWaf: false },
      { name: 'sub', enableWaf: false },
    ],
  },
  prd: {
    account: OTHER_ACCOUNT,
    githubRepo: 'example/kukan',
    deployBranch: 'main',
    enableWaf: false,
  },
}

// Nothing here reads the Lambda bundles; skipping them is ~400 ms of esbuild per app
const app = () => testApp({ 'aws:cdk:bundling-stacks': [] })

/** The pipelines bin/app.ts builds, with the credentials of the connection's account. */
function pipelineApp(environments = ENVIRONMENTS) {
  const root = app()
  const pipelines = buildPipelines(root, {
    environments,
    connectionArn: CONNECTION,
    credentialsAccount: TEST_ACCOUNT,
  })
  return { app: root, stacks: pipelines.built, skipped: pipelines.skipped }
}

/** The app stacks where the single pipeline stack put them: each Stage inside it. */
function singleStackApp(): cdk.App {
  const root = app()
  const pipelineStack = new cdk.Stack(root, 'KukanPipeline', {
    env: { account: TEST_ACCOUNT, region: TEST_REGION },
  })
  for (const [name, config] of Object.entries(ENVIRONMENTS)) {
    new KukanStage(pipelineStack, pascal(name), { env: resolveEnv(config), config })
  }
  return root
}

/** Each app stack, by artifact ID: its CloudFormation name and template. */
function appStacks(root: cdk.App): Record<string, { stackName: string; template: unknown }> {
  return Object.fromEntries(
    root
      .synth()
      .nestedAssemblies.flatMap((a) => a.nestedAssembly.stacks)
      .map((s) => [s.id, { stackName: s.stackName, template: s.template }])
  )
}

/** The commands of the CodeBuild project whose build spec contains `marker`. */
function buildSpec(template: Template, marker: string): string {
  const specs = Object.values(template.findResources('AWS::CodeBuild::Project'))
    .map((p) => (p.Properties as { Source: { BuildSpec: string } }).Source.BuildSpec)
    .filter((spec) => spec.includes(marker))
  expect(specs).toHaveLength(1)
  return specs[0]
}

describe('pipeline stacks', () => {
  const { app: root, stacks } = pipelineApp()
  const templates = Object.fromEntries(stacks.map((s) => [s.stackName, Template.fromStack(s)]))

  it('builds one stack per environment, each with its own branch', () => {
    expect(Object.keys(templates)).toEqual(['KukanPipeline-Demo', 'KukanPipeline-Prd'])
    for (const [stackName, pipelineName, branch] of [
      ['KukanPipeline-Demo', 'kukan-demo', 'demo'],
      ['KukanPipeline-Prd', 'kukan-prd', 'main'],
    ]) {
      const template = templates[stackName]
      template.resourceCountIs('AWS::CodePipeline::Pipeline', 1)
      template.hasResourceProperties('AWS::CodePipeline::Pipeline', { Name: pipelineName })
      expect(JSON.stringify(template.toJSON())).toContain(`"BranchName":"${branch}"`)
    }
  })

  it('self-mutates its own stack alone, from its own Stage', () => {
    for (const [name, other] of [
      ['Demo', 'Prd'],
      ['Prd', 'Demo'],
    ]) {
      const template = templates[`KukanPipeline-${name}`]
      const mutate = buildSpec(template, 'deploy')
      expect(mutate).toContain(`KukanPipeline-${name}`)
      expect(mutate).not.toContain(`KukanPipeline-${other}`)
      expect(buildSpec(template, 'cdk synth')).toContain(
        `npx cdk synth --exclusively KukanPipeline-${name} 'KukanPipeline/${name}/**'`
      )
    }
  })

  it('keeps the app stacks the names they were deployed under', () => {
    const names = Object.fromEntries(
      Object.entries(appStacks(root)).map(([id, s]) => [id, s.stackName])
    )
    // Literal: these are the CloudFormation stacks of deployed environments,
    // and the artifact IDs the `cdk deploy 'KukanPipeline/<Env>/...'` paths select
    expect(names).toEqual({
      KukanPipelineDemoKukanSharedStack7690B0F4: 'Demo-KukanSharedStack',
      KukanPipelineDemoKukanSiteStackMain074AFDE1: 'Demo-KukanSiteStackMain',
      KukanPipelineDemoKukanSiteStackSub550A8F7C: 'Demo-KukanSiteStackSub',
      KukanPipelinePrdKukanStack5C766526: 'Prd-KukanStack',
    })
  })

  it("leaves the app stacks' templates as the single pipeline stack built them", () => {
    // The construct path reaches into the templates (security group rules'
    // logical IDs, the VPC's Name tag, task definition families), so the
    // names alone would not catch a moved Stage
    expect(appStacks(root)).toEqual(appStacks(singleStackApp()))
  })
})

describe('pipelines for environments in another region', () => {
  it('give each pipeline a support stack of its own', () => {
    const osaka: EnvironmentConfig = {
      account: TEST_ACCOUNT,
      region: 'ap-northeast-3',
      githubRepo: 'example/kukan',
      sites: [{ name: 'main', enableWaf: false }],
    }
    const { app: root } = pipelineApp({ osaka, osakb: osaka })
    const support = root
      .synth()
      .stacks.filter((s) => s.environment.region === 'ap-northeast-3')
      .map((s) => s.stackName)
    expect(support.sort()).toEqual([
      'KukanPipeline-Osaka-support-ap-northeast-3',
      'KukanPipeline-Osakb-support-ap-northeast-3',
    ])
  })
})

describe('pipelines in another account', () => {
  it('are skipped, and named with the account they are in', () => {
    const otherConnection = `arn:aws:codeconnections:${TEST_REGION}:${OTHER_ACCOUNT}:connection/y`
    const { stacks, skipped } = pipelineApp({
      ...ENVIRONMENTS,
      prd: { ...ENVIRONMENTS.prd, connectionArn: otherConnection },
      standalone: { account: TEST_ACCOUNT },
    })
    expect(stacks.map((s) => s.stackName)).toEqual(['KukanPipeline-Demo'])
    expect(skipped).toEqual([{ name: 'prd', account: OTHER_ACCOUNT }])
  })
})

describe('pipeline placement', () => {
  const defaults = { connectionArn: CONNECTION }
  const otherConnection = `arn:aws:codeconnections:${TEST_REGION}:${OTHER_ACCOUNT}:connection/y`
  const at = (account: string, connectionArn = CONNECTION) => ({ account, connectionArn })

  it("puts a pipeline in its connection's account, the environment's over the top level's", () => {
    expect(resolvePipelinePlacement('dev', {}, defaults)).toEqual(at(TEST_ACCOUNT))
    expect(resolvePipelinePlacement('prd', { connectionArn: otherConnection }, defaults)).toEqual(
      at(OTHER_ACCOUNT, otherConnection)
    )
    // The top-level pipelineAccount declares the top-level connection's account alone
    expect(
      resolvePipelinePlacement(
        'prd',
        { connectionArn: otherConnection },
        { ...defaults, pipelineAccount: TEST_ACCOUNT }
      )
    ).toEqual(at(OTHER_ACCOUNT, otherConnection))
  })

  it("refuses a top-level pipelineAccount that is not its connection's account", () => {
    expect(() =>
      resolvePipelinePlacement('dev', {}, { ...defaults, pipelineAccount: OTHER_ACCOUNT })
    ).toThrow(/pipelineAccount "210987654321" is not the account/)
  })

  it('refuses a pipeline without a connection, or with something else in its place', () => {
    expect(() => resolvePipelinePlacement('dev', {}, {})).toThrow(/no connectionArn/)
    expect(() => resolvePipelinePlacement('dev', { connectionArn: 'REPLACE_ME' }, {})).toThrow(
      /not a CodeConnections ARN/
    )
  })

  it("builds the pipelines in the credentials' account alone", () => {
    const pipelines = [
      { name: 'dev', placement: at(TEST_ACCOUNT) },
      { name: 'prd', placement: at(OTHER_ACCOUNT, otherConnection) },
    ]
    const names = (account: string) => {
      const { here, elsewhere } = pipelinesInAccount(pipelines, account)
      return [here.map((p) => p.name), elsewhere.map((p) => p.name)]
    }
    expect(names(TEST_ACCOUNT)).toEqual([['dev'], ['prd']])
    expect(names(OTHER_ACCOUNT)).toEqual([['prd'], ['dev']])
  })

  it('refuses credentials that would build none of the pipelines', () => {
    const prd = { name: 'prd', placement: at(OTHER_ACCOUNT, otherConnection) }
    expect(() => pipelinesInAccount([prd], TEST_ACCOUNT)).toThrow(/Pipeline account mismatch/)
    expect(pipelinesInAccount([], TEST_ACCOUNT)).toEqual({ here: [], elsewhere: [] })
  })
})
