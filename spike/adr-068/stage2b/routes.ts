// ADR-068 stage 2b routes, mounted by ../stage2a/server.ts. With the revision
// on the DualStack connector, they check what §Decision 2 and 5 assume:
//   /secret   the DB password from Secrets Manager, over IPv6
//   /db       PostgreSQL in isolated subnets, through the connector
//   /egress   IPv6 destinations reachable, IPv4-only ones not
//   /bedrock  Bedrock Runtime through its interface endpoint
//   /migrate  KUKAN's migrations, for stage 2c's web (the worker that applies them is not deployed)
import { readFileSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { fileURLToPath } from 'node:url'

const secrets = new SecretsManagerClient({})
let dbPassword: Promise<string> | undefined

function password(): Promise<string> {
  dbPassword ??= secrets
    .send(new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN }))
    .then((r) => JSON.parse(r.SecretString ?? '{}').password as string)
  return dbPassword
}

async function resolve(host: string): Promise<string[] | string> {
  try {
    const all = await lookup(host, { all: true })
    return all.map((a) => `v${a.family} ${a.address}`)
  } catch (e) {
    return `!${(e as NodeJS.ErrnoException).code}`
  }
}

async function reach(host: string): Promise<unknown> {
  const t0 = Date.now()
  try {
    const r = await fetch(`https://${host}/`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    })
    return { dns: await resolve(host), status: r.status, ms: Date.now() - t0 }
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } }
    return { dns: await resolve(host), error: err.cause?.code ?? err.name, ms: Date.now() - t0 }
  }
}

// RDS for PostgreSQL 16 requires TLS; build.sh puts the Region's RDS CA bundle beside the server
async function dbClient(): Promise<pg.Client> {
  return new pg.Client({
    host: process.env.DB_HOST ?? '',
    user: 'kukan',
    database: 'kukan',
    password: await password(),
    ssl: { ca: readFileSync(new URL('./rds-ca.crt', import.meta.url), 'utf8') },
    connectionTimeoutMillis: 5000,
  })
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

export async function networkRoute(path: string): Promise<unknown | null> {
  switch (path) {
    case '/secret': {
      const t0 = Date.now()
      try {
        const p = await password()
        return { ok: true, passwordLength: p.length, ms: Date.now() - t0 }
      } catch (e) {
        return {
          ok: false,
          error: (e as Error).name,
          message: (e as Error).message,
          ms: Date.now() - t0,
        }
      }
    }
    case '/db': {
      const host = process.env.DB_HOST ?? ''
      const t0 = Date.now()
      const client = await dbClient()
      try {
        await client.connect()
        const connectMs = Date.now() - t0
        const rtts: number[] = []
        for (let i = 0; i < 20; i++) {
          const s = performance.now()
          await client.query('SELECT 1')
          rtts.push(performance.now() - s)
        }
        const v = await client.query('SELECT version() v, inet_client_addr()::text client')
        return {
          dns: await resolve(host),
          connectMs,
          select1Ms: { median: +median(rtts).toFixed(2), max: +Math.max(...rtts).toFixed(2) },
          ...v.rows[0],
        }
      } catch (e) {
        return { dns: await resolve(host), error: (e as Error).message, ms: Date.now() - t0 }
      } finally {
        await client.end().catch(() => {})
      }
    }
    case '/egress':
      return {
        // AAAA records: out over IPv6 through the internet gateway
        ipv6: {
          'analyticsdata.googleapis.com': await reach('analyticsdata.googleapis.com'),
          'oauth2.googleapis.com': await reach('oauth2.googleapis.com'),
          'api.openai.com': await reach('api.openai.com'),
          'secretsmanager.ap-northeast-1.amazonaws.com': await reach(
            'secretsmanager.ap-northeast-1.amazonaws.com'
          ),
        },
        // IPv4 only, no endpoint: expected not to be reached
        ipv4Only: {
          'github.com': await reach('github.com'),
          'bedrock.ap-northeast-1.amazonaws.com': await reach(
            'bedrock.ap-northeast-1.amazonaws.com'
          ),
        },
        // IPv4 only, through the gateway endpoint's route
        s3: await reach('s3.ap-northeast-1.amazonaws.com'),
      }
    case '/bedrock':
      // Private DNS on the endpoint: the name resolves to an address in the VPC
      return { 'bedrock-runtime': await reach('bedrock-runtime.ap-northeast-1.amazonaws.com') }
    case '/migrate': {
      const t0 = Date.now()
      const client = await dbClient()
      try {
        await client.connect()
        // As runMigrations does (packages/db/src/migrate.ts) before the first migration
        await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm')
        await migrate(drizzle(client), {
          migrationsFolder: fileURLToPath(new URL('./drizzle', import.meta.url)),
        })
        const r = await client.query(
          "SELECT count(*)::int tables FROM information_schema.tables WHERE table_schema = 'public'"
        )
        return { ok: true, ...r.rows[0], ms: Date.now() - t0 }
      } catch (e) {
        return { ok: false, error: (e as Error).message, ms: Date.now() - t0 }
      } finally {
        await client.end().catch(() => {})
      }
    }
    default:
      return null
  }
}
