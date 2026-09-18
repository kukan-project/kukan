/**
 * Posts the outcome of a pipeline execution to Slack (ADR-030 deployments).
 *
 * Subscribed to the CodeStar notification topic, which fires once per pipeline
 * execution state change. The event carries the execution id and little else,
 * so what the message is worth comes from asking CodePipeline afterwards: the
 * commit that was deployed, and which stacks the stage actually ran.
 */

import {
  CodePipelineClient,
  GetPipelineExecutionCommand,
  paginateListActionExecutions,
} from '@aws-sdk/client-codepipeline'
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'

const pipelineClient = new CodePipelineClient({})
const secrets = new SecretsManagerClient({})

const SECRET_ARN = process.env.WEBHOOK_SECRET_ARN
const ENVIRONMENT = process.env.KUKAN_ENVIRONMENT ?? 'unknown'
const CONSOLE_REGION = process.env.AWS_REGION ?? 'ap-northeast-1'

/** Where the release notes live — not where the pipeline deploys from: every
 *  environment builds from a private repository, while the notes are published
 *  on the public mirror, under the same tag. */
const RELEASE_REPO = 'kukan-project/kukan'

/** Site stacks by construct id, which is what the stage's deploy actions are
 *  named after. The construct fills this in from the environment's own site
 *  list, so nothing here has to invert the id back into a site name. */
const SITE_STACKS: Record<string, { label: string; url?: string }> = JSON.parse(
  process.env.SITE_STACKS ?? '{}'
)

/** A Slack incoming webhook, or null while the secret still holds the value it
 *  was generated with (see the construct) — the normal state between the deploy
 *  that adds notifications and the operator pasting the URL, not a failure. */
async function webhookUrl(): Promise<string | null> {
  const { SecretString } = await secrets.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }))
  const value = SecretString?.trim()
  return value?.startsWith('https://hooks.slack.com/') ? value : null
}

/** The stage's per-stack deploy actions, reduced to the last attempt of each.
 *
 *  A retried stage reuses the pipeline execution id, so the history holds every
 *  attempt and a stack that failed and then succeeded appears twice. Only the
 *  newest attempt is the outcome.
 *
 *  What this reports is which stacks the execution ran, not which ones changed:
 *  a deploy whose template is identical still succeeds here, and CodePipeline
 *  does not say so. */
export function lastAttempts(
  details: { actionName?: string; status?: string; startTime?: Date }[]
): { name: string; status: string }[] {
  const latest = new Map<string, { name: string; status: string; startTime: number }>()
  for (const a of details) {
    if (!a.actionName?.endsWith('.Deploy')) continue
    const name = a.actionName.replace(/\.Deploy$/, '')
    const startTime = a.startTime?.getTime() ?? 0
    const seen = latest.get(name)
    if (!seen || startTime >= seen.startTime) {
      latest.set(name, { name, status: a.status ?? 'Unknown', startTime })
    }
  }
  return [...latest.values()].map(({ name, status }) => ({ name, status }))
}

/** Paged, because one page holds 100 actions: an environment at the 50-site
 *  ceiling (ADR-049) spends two on every site before any retry history. */
async function deployedStacks(pipelineName: string, executionId: string) {
  const details = []
  for await (const page of paginateListActionExecutions(
    { client: pipelineClient },
    { pipelineName, filter: { pipelineExecutionId: executionId } }
  )) {
    details.push(...(page.actionExecutionDetails ?? []))
  }
  return lastAttempts(details)
}

/** The commit the execution built, which is the closest thing to a version:
 *  a release lands as `chore(release): vX.Y.Z (#nnn)` and says so in its summary. */
async function source(pipelineName: string, executionId: string) {
  const { pipelineExecution } = await pipelineClient.send(
    new GetPipelineExecutionCommand({ pipelineName, pipelineExecutionId: executionId })
  )
  const revision = pipelineExecution?.artifactRevisions?.[0]
  return {
    id: revision?.revisionId?.slice(0, 8),
    summary: revision?.revisionSummary?.split('\n')[0],
  }
}

/** The version a deploy carries, when it carries one.
 *
 *  Releases land as `chore(release): vX.Y.Z` (ADR-035). Anything else — a
 *  configuration-only change, a revert — deploys without a version, and then
 *  there are no notes to point at. */
export function releaseTag(summary: string | undefined): string | null {
  return summary?.match(/^chore\(release\): (v\d+\.\d+\.\d+)/)?.[1] ?? null
}

/** Slack reads `&`, `<` and `>` as markup, so a commit subject carrying them
 *  has to arrive as entities — `<!channel>` in a subject would otherwise page
 *  the channel, and `<url|text>` would render as someone else's link. Applied
 *  at display only: `releaseTag` still reads the subject as written. */
function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** The Slack message for one execution. */
export function message(execution: {
  state?: string
  pipeline: string
  executionId: string
  revision: { id?: string; summary?: string }
  stacks: { name: string; status: string }[]
}): string {
  const { state, pipeline, executionId, revision, stacks } = execution
  const succeeded = state === 'SUCCEEDED'
  const tag = releaseTag(revision.summary)
  const sites = stacks
    .flatMap((s) => {
      const site = SITE_STACKS[s.name]
      if (!site) return []
      const label = s.status === 'Succeeded' ? site.label : `${site.label} (${s.status})`
      return [site.url ? `<${site.url}|${label}>` : label]
    })
    .join(', ')

  return [
    `${succeeded ? '✅' : '❌'} *${ENVIRONMENT}* deploy ${succeeded ? 'succeeded' : 'failed'}`,
    revision.summary
      ? `• ${escape(revision.summary)}${revision.id ? ` (\`${revision.id}\`)` : ''}`
      : null,
    sites ? `• sites: ${sites}` : null,
    tag ? `• <https://github.com/${RELEASE_REPO}/releases/tag/${tag}|release notes ${tag}>` : null,
    `• <https://${CONSOLE_REGION}.console.aws.amazon.com/codesuite/codepipeline/pipelines/${pipeline}/executions/${executionId}|pipeline execution>`,
  ]
    .filter((line) => line !== null)
    .join('\n')
}

interface NotificationDetail {
  pipeline?: string
  'execution-id'?: string
  state?: string
}

export async function handler(event: {
  Records?: { Sns?: { Message?: string } }[]
}): Promise<void> {
  const url = await webhookUrl()
  if (!url) {
    console.info('No Slack webhook configured yet — nothing to post.')
    return
  }

  for (const record of event.Records ?? []) {
    const raw = record.Sns?.Message
    if (!raw) continue
    const detail = (JSON.parse(raw) as { detail?: NotificationDetail }).detail ?? {}
    const { pipeline, 'execution-id': executionId, state } = detail
    if (!pipeline || !executionId) continue

    const [stacks, revision] = await Promise.all([
      deployedStacks(pipeline, executionId),
      source(pipeline, executionId),
    ])

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: message({ state, pipeline, executionId, revision, stacks }) }),
    })
    // Slack answers `ok` in the body, not only in the status
    if (!response.ok) {
      throw new Error(`Slack rejected the message: ${response.status} ${await response.text()}`)
    }
  }
}
