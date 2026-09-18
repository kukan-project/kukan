/**
 * The deploy message is the whole of what anyone sees, and it is assembled from
 * things the pipeline happens to record — a commit subject, per-stack action
 * names. Pin the shapes so a change to either is noticed here.
 */

import { describe, it, expect } from 'vitest'

// The module reads its environment once, at load.
process.env.KUKAN_ENVIRONMENT = 'demo'
process.env.AWS_REGION = 'ap-northeast-1'
process.env.SITE_STACKS = JSON.stringify({
  KukanSiteStackMain: { label: 'main', url: 'https://demo.kukan.dev' },
  KukanSiteStackAomori: { label: 'aomori' },
  KukanStack: { label: 'demo', url: 'https://demo.kukan.dev' },
})
const { lastAttempts, releaseTag, message } = await import('../lambda/deploy-notification/index.js')

// `aomori` carries no url: a site without a custom domain is named, not linked.
const execution = {
  state: 'SUCCEEDED',
  pipeline: 'KukanPipeline',
  executionId: 'b0a1c2d3-4e5f-6789-abcd-ef0123456789',
  revision: { id: '9aa974f7', summary: 'chore(release): v0.30.3' },
  stacks: [
    { name: 'KukanSharedStack', status: 'Succeeded' },
    { name: 'KukanSiteStackMain', status: 'Succeeded' },
    { name: 'KukanSiteStackAomori', status: 'Succeeded' },
  ],
}

describe('releaseTag', () => {
  it('reads the version out of a release commit', () => {
    // A squashed release subject trails the PR number, which check-private-refs
    // forbids spelling out here; what matters is that the trailer is ignored.
    expect(releaseTag('chore(release): v0.30.3 (squashed)')).toBe('v0.30.3')
    expect(releaseTag('chore(release): v1.0.0')).toBe('v1.0.0')
  })

  it('has nothing to point at for a deploy that is not a release', () => {
    expect(releaseTag('feat(infra): notify Slack when a deploy finishes')).toBeNull()
    expect(releaseTag('Merge pull request #1 from x/y')).toBeNull()
    expect(releaseTag(undefined)).toBeNull()
  })
})

describe('message', () => {
  it('links the sites that have a domain, names the ones that do not', () => {
    expect(message(execution)).toMatchInlineSnapshot(`
      "✅ *demo* deploy succeeded
      • chore(release): v0.30.3 (\`9aa974f7\`)
      • sites: <https://demo.kukan.dev|main>, aomori
      • <https://github.com/kukan-project/kukan/releases/tag/v0.30.3|release notes v0.30.3>
      • <https://ap-northeast-1.console.aws.amazon.com/codesuite/codepipeline/pipelines/KukanPipeline/executions/b0a1c2d3-4e5f-6789-abcd-ef0123456789|pipeline execution>"
    `)
  })

  it('names the site that failed, and drops the notes a config change has none of', () => {
    expect(
      message({
        ...execution,
        state: 'FAILED',
        revision: { id: '1c2b3a49', summary: 'chore(infra): give aomori its own summary model' },
        stacks: [
          { name: 'KukanSharedStack', status: 'Succeeded' },
          { name: 'KukanSiteStackMain', status: 'Succeeded' },
          { name: 'KukanSiteStackAomori', status: 'Failed' },
        ],
      })
    ).toMatchInlineSnapshot(`
      "❌ *demo* deploy failed
      • chore(infra): give aomori its own summary model (\`1c2b3a49\`)
      • sites: <https://demo.kukan.dev|main>, aomori (Failed)
      • <https://ap-northeast-1.console.aws.amazon.com/codesuite/codepipeline/pipelines/KukanPipeline/executions/b0a1c2d3-4e5f-6789-abcd-ef0123456789|pipeline execution>"
    `)
  })
})

describe('lastAttempts', () => {
  const at = (iso: string) => new Date(iso)

  it('keeps the newest attempt when a failed stage is retried', () => {
    expect(
      lastAttempts([
        {
          actionName: 'KukanSiteStackMain.Deploy',
          status: 'Failed',
          startTime: at('2026-09-18T01:00:00Z'),
        },
        {
          actionName: 'KukanSiteStackMain.Deploy',
          status: 'Succeeded',
          startTime: at('2026-09-18T02:00:00Z'),
        },
      ])
    ).toEqual([{ name: 'KukanSiteStackMain', status: 'Succeeded' }])
  })

  it('ignores everything that is not a stack deploy', () => {
    expect(
      lastAttempts([
        { actionName: 'Source', status: 'Succeeded' },
        { actionName: 'KukanStack.Deploy', status: 'Succeeded' },
        { actionName: 'KukanStack.Prepare', status: 'Succeeded' },
      ])
    ).toEqual([{ name: 'KukanStack', status: 'Succeeded' }])
  })
})

describe('single-site environments', () => {
  it('names the all-in-one stack after the environment', () => {
    expect(
      message({
        ...execution,
        stacks: [{ name: 'KukanStack', status: 'Succeeded' }],
      })
    ).toContain('• sites: <https://demo.kukan.dev|demo>')
  })
})

describe('untrusted commit subjects', () => {
  it('cannot page the channel or plant a link through a commit subject', () => {
    const text = message({
      ...execution,
      revision: { id: 'deadbeef', summary: '<!channel> fix <https://evil.example|payroll> A&B' },
    })
    expect(text).toContain('• &lt;!channel&gt; fix &lt;https://evil.example|payroll&gt; A&amp;B')
  })

  it('still reads the release version off the unescaped subject', () => {
    expect(
      message({ ...execution, revision: { summary: 'chore(release): v9.9.9 & more' } })
    ).toContain('releases/tag/v9.9.9|release notes v9.9.9>')
  })
})
