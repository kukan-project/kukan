/**
 * KUKAN CLI: Create User
 * Run with: pnpm db:create-user --email <email> --name <name> --password <password> [--role sysadmin]
 */

import { parseArgs } from 'node:util'
import { randomBytes, scrypt } from 'node:crypto'
import { config } from 'dotenv'
import { loadEnv } from '@kukan/shared'
import { createUserSchema, userRoleSchema, type UserRole } from '@kukan/shared/validators/user'
import { Client } from 'pg'

// Skip dotenv in production (env vars injected by container/ECS)
if (process.env.NODE_ENV !== 'production') {
  config({ path: '../../.env' })
}

interface CreateUserArgs {
  email: string
  name: string
  password: string
  role: UserRole
}

function printUsage(): void {
  console.log(`
Usage: pnpm db:create-user --email <email> --name <name> --password <password> [--role sysadmin]

Options:
  --email     User email address (required)
  --name      Username, lowercase alphanumeric with hyphens/underscores/periods (required)
  --password  Password, minimum 8 characters (required)
  --role      User role: 'user' or 'sysadmin' (default: 'user')
  --help      Show this help message

Examples:
  pnpm db:create-user --email admin@example.com --name admin --password secret123 --role sysadmin
  pnpm db:create-user --email user@example.com --name taro --password secret123
`)
}

function parseArguments(): CreateUserArgs {
  const rawArgs = process.argv.slice(2).filter((a) => a !== '--')
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      password: { type: 'string' },
      role: { type: 'string', default: 'user' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  })

  if (values.help) {
    printUsage()
    process.exit(0)
  }

  if (!values.email || !values.name || !values.password) {
    console.error('Error: --email, --name, and --password are required.')
    printUsage()
    process.exit(1)
  }

  const userResult = createUserSchema
    .extend({ password: createUserSchema.shape.password.unwrap() })
    .safeParse({ email: values.email, name: values.name, password: values.password })
  if (!userResult.success) {
    for (const issue of userResult.error.issues) {
      console.error(`Error: ${issue.path.join('.')} — ${issue.message}`)
    }
    process.exit(1)
  }

  const roleResult = userRoleSchema.safeParse(values.role)
  if (!roleResult.success) {
    console.error("Error: Role must be 'user' or 'sysadmin'.")
    process.exit(1)
  }

  return {
    email: userResult.data.email,
    name: userResult.data.name,
    password: userResult.data.password,
    role: roleResult.data,
  }
}

/** Generate a random alphanumeric ID (same format as Better Auth's generateId) */
function generateId(size = 32): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const bytes = randomBytes(size)
  let result = ''
  for (let i = 0; i < size; i++) {
    result += chars[bytes[i] % chars.length]
  }
  return result
}

/** Hash password using scrypt — must match Better Auth's parameters (N=16384, r=16, p=1, dkLen=64) */
function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16).toString('hex')
    scrypt(
      password.normalize('NFKC'),
      salt,
      64,
      { N: 16384, r: 16, p: 1, maxmem: 128 * 16384 * 16 * 2 },
      (err, key) => {
        if (err) return reject(err)
        resolve(`${salt}:${key.toString('hex')}`)
      }
    )
  })
}

async function createUser(args: CreateUserArgs): Promise<void> {
  const { DATABASE_URL } = loadEnv()
  const ssl = process.env.POSTGRES_SSLMODE === 'require' ? { rejectUnauthorized: false } : undefined
  const client = new Client({ connectionString: DATABASE_URL, ...(ssl && { ssl }) })
  await client.connect()

  try {
    await client.query('BEGIN')

    const existing = await client.query(
      'SELECT email, name FROM "user" WHERE email = $1 OR name = $2',
      [args.email, args.name]
    )
    if (existing.rows.length > 0) {
      const row = existing.rows[0]
      if (row.email === args.email) {
        throw new Error(`A user with email "${args.email}" already exists.`)
      }
      throw new Error(`A user with name "${args.name}" already exists.`)
    }

    const hashedPassword = await hashPassword(args.password)
    const now = new Date()
    const userId = generateId()
    const accountId = generateId()

    await client.query(
      `INSERT INTO "user" (id, email, "emailVerified", name, role, state, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, args.email, true, args.name, args.role, 'active', now, now]
    )

    await client.query(
      `INSERT INTO "account" (id, "userId", "accountId", "providerId", password, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [accountId, userId, userId, 'credential', hashedPassword, now, now]
    )

    await client.query('COMMIT')

    console.log(`✓ User created successfully:`)
    console.log(`  Name:  ${args.name}`)
    console.log(`  Email: ${args.email}`)
    console.log(`  Role:  ${args.role}`)

    if (args.role !== 'sysadmin') {
      const sysadminCount = await client.query(
        `SELECT COUNT(*) as count FROM "user" WHERE role = 'sysadmin' AND state = 'active'`
      )
      if (Number(sysadminCount.rows[0].count) === 0) {
        console.log('')
        console.log('⚠ Warning: No sysadmin user exists. Create one with --role sysadmin')
      }
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await client.end()
  }
}

const args = parseArguments()
createUser(args).catch((err) => {
  console.error('Failed to create user:', err.message)
  process.exit(1)
})
