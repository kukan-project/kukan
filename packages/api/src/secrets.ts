/**
 * Secrets the runtime did not put in the environment, read from Secrets
 * Manager when the web process starts (apps/web/src/instrumentation.ts),
 * before anything reads them.
 *
 * ECS injects them itself (the task definition's `secrets`). Lambda Web
 * Functions take plain environment variables only, and baking the values in
 * would mean a new revision every time a secret changes (ADR-068 §決定 5), so
 * there the deployment names where each one lives instead:
 *
 *   SECRET_ARNS={"POSTGRES_PASSWORD":"arn:aws:secretsmanager:…:secret:db-AbCdEf:password"}
 *
 * Each value is an ARN as ECS's `valueFrom` writes it, optionally followed by
 * the JSON key to take (not a version: the deployment reads the current one).
 * A variable already set wins, so the same deployment keeps working under ECS.
 * Without SECRET_ARNS (Fargate, Compose, the dev server) this does nothing and
 * loads no SDK.
 */

interface SecretRef {
  name: string
  arn: string
  jsonKey?: string
}

/** The `SECRET_ARNS` entries, refusing anything but `arn[:jsonKey[::]]`. */
export function parseSecretArns(raw: string): SecretRef[] {
  let entries: unknown
  try {
    entries = JSON.parse(raw)
  } catch {
    throw new Error('SECRET_ARNS is not JSON')
  }
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
    throw new Error('SECRET_ARNS must map variable names to secret ARNs')
  }
  return Object.entries(entries).map(([name, ref]) => {
    // arn:aws:secretsmanager:<region>:<account>:secret:<name>[:key[::]]
    const parts = typeof ref === 'string' ? ref.split(':') : []
    const isSecret =
      parts.length >= 7 &&
      parts[0] === 'arn' &&
      parts[2] === 'secretsmanager' &&
      parts[5] === 'secret' &&
      parts[6] !== ''
    if (!isSecret || parts.slice(8).some(Boolean)) {
      throw new Error(`SECRET_ARNS.${name} is not a Secrets Manager ARN with an optional JSON key`)
    }
    return { name, arn: parts.slice(0, 7).join(':'), jsonKey: parts[7] || undefined }
  })
}

export async function loadSecrets(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!env.SECRET_ARNS) return
  const missing = parseSecretArns(env.SECRET_ARNS).filter(({ name }) => !env[name])
  if (missing.length === 0) return

  const { SecretsManagerClient, GetSecretValueCommand } =
    await import('@aws-sdk/client-secrets-manager')
  const client = new SecretsManagerClient({})
  // One read per secret, however many variables take keys from it
  const arns = [...new Set(missing.map(({ arn }) => arn))]
  let secrets: Map<string, string>
  try {
    secrets = new Map(
      await Promise.all(
        arns.map(async (arn) => {
          const res = await client.send(new GetSecretValueCommand({ SecretId: arn }))
          if (res.SecretString === undefined) throw new Error(`Secret ${arn} has no SecretString`)
          return [arn, res.SecretString] as const
        })
      )
    )
  } finally {
    client.destroy()
  }

  for (const { name, arn, jsonKey } of missing) {
    const secret = secrets.get(arn)!
    const value = jsonKey ? jsonObject(arn, secret)[jsonKey] : secret
    if (typeof value !== 'string') throw new Error(`Secret ${arn} has no string "${jsonKey}"`)
    env[name] = value
  }
}

/** The secret as an object, failing without the value: V8's parse error quotes its input. */
function jsonObject(arn: string, value: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`Secret ${arn} is not JSON, but SECRET_ARNS takes a key from it`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Secret ${arn} is not a JSON object, but SECRET_ARNS takes a key from it`)
  }
  return parsed as Record<string, unknown>
}
