/**
 * A site answering on more names than its domainName (`additionalDomainNames`).
 * An entry without them synthesizes as before — the golden snapshots of the
 * single- and multi-site tests are that guard.
 */

import { describe, it, expect } from 'vitest'
import { Match, type Template } from 'aws-cdk-lib/assertions'
import { resolveAdditionalDomainNames, type EnvironmentConfig, type SiteConfig } from '../config.js'
import { containerEnvs, stackTemplate, synthStage, TEST_ACCOUNT } from './helpers/synth.js'

const ZONE = { hostedZoneId: 'Z0000000000000000000', hostedZoneName: 'snow.example.org' }
const CERT_ARN = `arn:aws:acm:us-east-1:${TEST_ACCOUNT}:certificate/00000000-0000-0000-0000-000000000000`
/** The name of record, in the zone this account holds. */
const CURRENT = 'catalog.snow.example.org'
/** The name the site moves to, in another organization's DNS. */
const TARGET = 'opendata.city.example.jp'

const site = (fields: Partial<SiteConfig>): SiteConfig => ({
  name: 'main',
  enableWaf: false,
  ...ZONE,
  ...fields,
})

/** The smallest environment holding the site; nothing here reads the Lambda bundles. */
const stage = (sites: SiteConfig[], env: Partial<EnvironmentConfig> = {}) =>
  synthStage({ scale: 'small', ...env, sites }, { 'aws:cdk:bundling-stacks': [] })

const siteTemplate = (fields: Partial<SiteConfig>, env: Partial<EnvironmentConfig> = {}) =>
  stackTemplate(stage([site(fields)], env), 'KukanSiteStackMain')

/** The site of record CURRENT, TARGET beside it, as the pasted certificate holds both. */
const MOVING = { domainName: CURRENT, additionalDomainNames: [TARGET], certificateArn: CERT_ARN }

/** The A records of `template`, by name. */
const aRecords = (template: Template) =>
  Object.values(template.findResources('AWS::Route53::RecordSet', { Properties: { Type: 'A' } }))
    .map((r) => (r.Properties as { Name: string }).Name)
    .sort()

const moving = siteTemplate(MOVING)

describe('a site with an additional name outside its zone (pasted certificate)', () => {
  const template = moving

  it('answers on every name, the name of record first', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ Aliases: [CURRENT, TARGET] }),
    })
  })

  it('records the names under its zone alone', () => {
    expect(aRecords(template)).toEqual([`${CURRENT}.`])
  })

  it('lets sign-in and uploads come from every name, its URLs naming the one of record', () => {
    expect(containerEnvs(template).Web).toMatchObject({
      BETTER_AUTH_URL: `https://${CURRENT}`,
      TRUSTED_ORIGINS: `https://${TARGET}`,
    })
    template.hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: {
        CorsRules: [
          Match.objectLike({ AllowedOrigins: [`https://${CURRENT}`, `https://${TARGET}`] }),
        ],
      },
    })
  })
})

describe('swapping the name of record with an additional one', () => {
  // Moving to the new name: it becomes the name of record and the old one an
  // additional name. The certificate holds both either way.
  type Resources = Record<string, { Type: string; Properties?: unknown }>
  const before = moving.toJSON().Resources as Resources
  const after = siteTemplate({
    ...MOVING,
    domainName: TARGET,
    additionalDomainNames: [CURRENT],
  }).toJSON().Resources as Resources

  it('replaces nothing: the same resources under the same logical IDs', () => {
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
  })

  it('changes only the aliases, the CORS origins and the web environment', () => {
    const changed = Object.keys(before)
      .filter((id) => JSON.stringify(before[id]) !== JSON.stringify(after[id]))
      .map((id) => before[id].Type)
      .sort()
    expect(changed).toEqual([
      'AWS::CloudFront::Distribution',
      'AWS::ECS::TaskDefinition',
      'AWS::S3::Bucket',
    ])
  })
})

describe('the certificate the global stack creates', () => {
  const global = (additionalDomainNames: string[]) =>
    stackTemplate(stage([site({ domainName: CURRENT, additionalDomainNames })]), 'KukanGlobalStack')

  it('holds the additional names under the zone as SANs, validated in it', () => {
    global([`www.${ZONE.hostedZoneName}`]).hasResourceProperties(
      'AWS::CertificateManager::Certificate',
      {
        DomainName: CURRENT,
        SubjectAlternativeNames: [`www.${ZONE.hostedZoneName}`],
        DomainValidationOptions: Match.arrayWith([
          { DomainName: `www.${ZONE.hostedZoneName}`, HostedZoneId: ZONE.hostedZoneId },
        ]),
      }
    )
  })

  it('refuses a name outside the zone, asking for a pasted certificate', () => {
    expect(() => global([TARGET])).toThrow(
      /not under the hosted zone.*paste its ARN as certificateArn/
    )
  })
})

describe('additionalDomainNames checks', () => {
  const check = (fields: Partial<SiteConfig>) =>
    resolveAdditionalDomainNames({ ...ZONE, certificateArn: CERT_ARN, ...fields }, 'Site "main"')

  it('refuses them without a domainName', () => {
    expect(() => check({ additionalDomainNames: [TARGET] })).toThrow(/without domainName/)
  })

  it('refuses a name twice, the name of record among them', () => {
    expect(() => check({ domainName: CURRENT, additionalDomainNames: [CURRENT] })).toThrow(
      /listed twice/
    )
  })

  it('refuses what is not a DNS name', () => {
    expect(() =>
      check({ domainName: CURRENT, additionalDomainNames: ['https://x.example.jp'] })
    ).toThrow(/not a DNS name/)
  })

  it('refuses a wildcard, saying so', () => {
    expect(() =>
      check({ domainName: CURRENT, additionalDomainNames: ['*.city.example.jp'] })
    ).toThrow(/wildcards are not supported/)
  })

  it('takes a name in capitals, as DNS does', () => {
    expect(
      check({ domainName: CURRENT, additionalDomainNames: ['OpenData.City.Example.JP'] })
    ).toEqual(['OpenData.City.Example.JP'])
  })

  it('belongs to a site in the multi-site shape', () => {
    expect(() => siteTemplate({}, { additionalDomainNames: [TARGET] })).toThrow(
      /additionalDomainNames/
    )
  })
})
