/**
 * Custom Resource handler: per-site PostgreSQL database + role (ADR-041).
 *
 * Create/Update converge to the desired state (idempotent — a rolled-back
 * create can safely run again). Delete is a deliberate no-op: the database may
 * hold site data and a failed first deploy triggers a rollback-delete; purge is
 * a documented manual step instead.
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import pg from 'pg'

interface SiteDbProperties {
  MasterSecretArn: string
  SiteSecretArn: string
  DbHost: string
  DbPort: string
  DbName: string
  RoleName: string
}

interface CustomResourceEvent {
  RequestType: 'Create' | 'Update' | 'Delete'
  PhysicalResourceId?: string
  ResourceProperties: SiteDbProperties & { ServiceToken?: string }
}

const secrets = new SecretsManagerClient({})

async function getSecret(arn: string): Promise<Record<string, string>> {
  const res = await secrets.send(new GetSecretValueCommand({ SecretId: arn }))
  if (!res.SecretString) throw new Error(`Secret ${arn} has no SecretString`)
  return JSON.parse(res.SecretString) as Record<string, string>
}

/** PostgreSQL identifiers come from the validated site name (^[a-z][a-z0-9]{1,15}$),
 *  but re-check here — this code runs with master credentials. */
function assertIdentifier(name: string): string {
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(name)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${name}`)
  }
  return name
}

/** Single-quoted SQL literal (for the password — identifiers are allowlisted). */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export async function handler(event: CustomResourceEvent): Promise<{
  PhysicalResourceId: string
}> {
  const props = event.ResourceProperties
  const physicalId = `${props.DbHost}/${props.DbName}`

  if (event.RequestType === 'Delete') {
    console.log(
      `Retaining database ${props.DbName} and role ${props.RoleName}. Manual purge (as master): ` +
        `DROP DATABASE ${props.DbName}; DROP ROLE ${props.RoleName};`
    )
    return { PhysicalResourceId: event.PhysicalResourceId ?? physicalId }
  }

  const dbName = assertIdentifier(props.DbName)
  const roleName = assertIdentifier(props.RoleName)
  const master = await getSecret(props.MasterSecretArn)
  const site = await getSecret(props.SiteSecretArn)
  if (!site.password) throw new Error('Site secret has no password field')

  const client = new pg.Client({
    host: props.DbHost,
    port: Number(props.DbPort),
    database: 'postgres',
    user: master.username,
    password: master.password,
    // Matches the app's POSTGRES_SSLMODE=require posture (packages/db client):
    // encrypted, no CA verification — VPC-internal traffic to RDS/Aurora
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
  })
  await client.connect()
  try {
    const role = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [roleName])
    if (role.rowCount === 0) {
      await client.query(`CREATE ROLE ${roleName} WITH LOGIN PASSWORD ${literal(site.password)}`)
    } else {
      // Converge the password so recreating the site secret stays consistent
      await client.query(`ALTER ROLE ${roleName} WITH LOGIN PASSWORD ${literal(site.password)}`)
    }

    const db = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])
    if (db.rowCount === 0) {
      // CREATE DATABASE cannot run inside a transaction; pg.Client sends
      // single statements unwrapped, so this is fine
      await client.query(`CREATE DATABASE ${dbName} OWNER ${roleName}`)
    }

    // Credential-level isolation: only the site role may connect to its database
    await client.query(`REVOKE CONNECT ON DATABASE ${dbName} FROM PUBLIC`)
    await client.query(`GRANT CONNECT ON DATABASE ${dbName} TO ${roleName}`)
  } finally {
    await client.end()
  }

  return { PhysicalResourceId: physicalId }
}
