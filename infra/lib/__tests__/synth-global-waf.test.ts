/**
 * The global stack's WebACL once its ARN is pasted into a site (ADR-030). The
 * pasted ARN is how a pipeline-managed environment reaches the WebACL, but the
 * global stack that created it must keep managing it: dropping it from the
 * template orphans the WebACL and deletes its logging, and leaves later rule
 * changes nowhere to go. An ARN of a WebACL made elsewhere stays unmanaged.
 */

import { describe, it, expect } from 'vitest'
import type { SiteConfig } from '../config.js'
import { WEB_ACL_LOGICAL_ID } from '../stacks/global-stack.js'
import { KukanStage } from '../stacks/kukan-stage.js'
import { buildPipelines } from '../stacks/pipeline-stack.js'
import { stackTemplate, synthStage, testApp, TEST_ACCOUNT, TEST_REGION } from './helpers/synth.js'

/** The ARN CloudFormation gives the global stack's WebACL: its logical ID plus a suffix. */
const OWN_WAF_ARN = `arn:aws:wafv2:us-east-1:${TEST_ACCOUNT}:global/webacl/WafWebAclBE24253C-GdD7BNBt8GNP/1d587e44-1a92-4d9a-a326-6fafb3d40aeb`
const EXTERNAL_WAF_ARN = `arn:aws:wafv2:us-east-1:${TEST_ACCOUNT}:global/webacl/corporate-edge/00000000-0000-0000-0000-000000000000`
const CERT_ARN = `arn:aws:acm:us-east-1:${TEST_ACCOUNT}:certificate/00000000-0000-0000-0000-000000000000`

/** The shape that lost its WAF logging: the WAF site pasted, a new site needing a certificate. */
const sites = (webAclArn: string): SiteConfig[] => [
  { name: 'main', domainName: 'catalog.example.jp', certificateArn: CERT_ARN, webAclArn },
  {
    name: 'newsite',
    enableWaf: false,
    domainName: 'new.example.jp',
    hostedZoneId: 'Z0000000000000000000',
    hostedZoneName: 'example.jp',
  },
  { name: 'aomori', enableWaf: false },
]

const globalOf = (webAclArn: string) =>
  stackTemplate(synthStage({ scale: 'medium', sites: sites(webAclArn) }), 'KukanGlobalStack')

describe('a pasted ARN of the global stack’s own WebACL', () => {
  const global = globalOf(OWN_WAF_ARN)

  it('keeps the WebACL in the global stack, under the logical ID it was created with', () => {
    expect(Object.keys(global.findResources('AWS::WAFv2::WebACL'))).toEqual([WEB_ACL_LOGICAL_ID])
    expect(WEB_ACL_LOGICAL_ID).toBe('WafWebAclBE24253C')
  })

  it('keeps its logging and the log bucket’s policy', () => {
    global.resourceCountIs('AWS::WAFv2::LoggingConfiguration', 1)
    global.resourceCountIs('AWS::S3::BucketPolicy', 1)
    global.resourceCountIs('AWS::S3::Bucket', 1)
  })
})

describe('a pasted ARN of a WebACL made elsewhere', () => {
  it('creates no WebACL, so none is billed unused', () => {
    const global = globalOf(EXTERNAL_WAF_ARN)
    global.resourceCountIs('AWS::WAFv2::WebACL', 0)
    global.resourceCountIs('AWS::WAFv2::LoggingConfiguration', 0)
  })
})

describe('the single-site shape', () => {
  const domain = {
    domainName: 'data.example.jp',
    hostedZoneId: 'Z0000000000000000000',
    hostedZoneName: 'example.jp',
  }

  it('keeps its own WebACL and logging beside a certificate it creates', () => {
    const global = stackTemplate(
      synthStage({ ...domain, webAclArn: OWN_WAF_ARN }),
      'KukanGlobalStack'
    )
    expect(Object.keys(global.findResources('AWS::WAFv2::WebACL'))).toEqual([WEB_ACL_LOGICAL_ID])
    global.resourceCountIs('AWS::WAFv2::LoggingConfiguration', 1)
    global.resourceCountIs('AWS::CertificateManager::Certificate', 1)
  })
})

describe('with nothing else for the global stack to create', () => {
  const pasted: SiteConfig[] = [{ name: 'main', webAclArn: OWN_WAF_ARN }]

  it('still has a global stack in a standalone synth, so deploying it reaches the rules', () => {
    const stage = synthStage({ scale: 'medium', sites: pasted })
    stackTemplate(stage, 'KukanGlobalStack').resourceCountIs('AWS::WAFv2::LoggingConfiguration', 1)
    // The site reads the pasted ARN, not the global stack's export
    stackTemplate(stage, 'KukanSiteStackMain').resourceCountIs('Custom::CrossRegionExportReader', 0)
  })

  it('has none in a pipeline, which cannot deploy it', () => {
    const app = testApp({ 'aws:cdk:bundling-stacks': [] })
    buildPipelines(app, {
      environments: {
        dev: { account: TEST_ACCOUNT, githubRepo: 'example/kukan', sites: pasted },
      },
      connectionArn: `arn:aws:codeconnections:${TEST_REGION}:${TEST_ACCOUNT}:connection/x`,
      credentialsAccount: TEST_ACCOUNT,
    })
    const stage = app.node.findChild('KukanPipeline').node.findChild('Dev') as KukanStage
    expect(stage.node.tryFindChild('KukanGlobalStack')).toBeUndefined()
  })

  it('has none for a WebACL made elsewhere', () => {
    const stage = synthStage({
      scale: 'medium',
      sites: [{ name: 'main', webAclArn: EXTERNAL_WAF_ARN }],
    })
    expect(stage.node.tryFindChild('KukanGlobalStack')).toBeUndefined()
  })
})
