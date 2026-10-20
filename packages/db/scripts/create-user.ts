/**
 * KUKAN CLI: Create User
 * Run with: pnpm db:create-user --email <email> --name <name> [--role sysadmin]
 * The password is prompted for, or read from KUKAN_USER_PASSWORD.
 */

import { parseArgs } from 'node:util'
import { randomBytes, scrypt } from 'node:crypto'
import { config } from 'dotenv'
import { and, eq, or, count } from 'drizzle-orm'
import { loadEnv, checkPasswordGuessability, normalizePassword } from '@kukan/shared'
import { createUserSchema, userRoleSchema, type UserRole } from '@kukan/shared/validators/user'
import { createDb, closePool } from '../src/client'
import { user, account } from '../src/schema'
import { PASSWORD_ENV, PasswordInputError, promptHidden, readPassword } from './read-password'

const CREDENTIAL_PROVIDER_ID = 'credential'

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
Usage: pnpm db:create-user --email <email> --name <name> [--role sysadmin]

Options:
  --email     User email address (required)
  --name      Username, lowercase alphanumeric with hyphens/underscores/periods (required)
  --role      User role: 'user' or 'sysadmin' (default: 'user')
  --help      Show this help message

The password (minimum 15 characters and hard enough to guess) is prompted for
without echo. Without a terminal, it is read from ${PASSWORD_ENV}.

Examples:
  pnpm db:create-user --email admin@example.com --name admin --role sysadmin
  pnpm db:create-user --email user@example.com --name taro
`)
}

async function parseArguments(): Promise<CreateUserArgs> {
  const rawArgs = process.argv.slice(2).filter((a) => a !== '--')
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      // Still parsed, so that the old form gets an answer rather than a bare
      // "unknown option"
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

  if (values.password !== undefined) {
    console.error(
      `Error: --password is no longer accepted: a password on the command line stays in the shell history and shows in ps.\n` +
        `Leave it out to be prompted for it, or set ${PASSWORD_ENV} when there is no terminal.`
    )
    process.exit(1)
  }

  if (!values.email || !values.name) {
    console.error('Error: --email and --name are required.')
    printUsage()
    process.exit(1)
  }

  const roleResult = userRoleSchema.safeParse(values.role)
  if (!roleResult.success) {
    console.error("Error: Role must be 'user' or 'sysadmin'.")
    process.exit(1)
  }

  // Before the prompt, so a mistyped address does not cost the password typed twice
  const userResult = createUserSchema
    .pick({ email: true, name: true })
    .safeParse({ email: values.email, name: values.name })
  if (!userResult.success) exitWithIssues(userResult.error.issues)

  let password: string
  try {
    password = await readPassword({
      env: process.env,
      interactive: Boolean(process.stdin.isTTY),
      prompt: promptHidden,
    })
  } catch (err) {
    if (!(err instanceof PasswordInputError)) throw err
    console.error(`Error: ${err.message}`)
    process.exit(1)
  }
  const passwordResult = createUserSchema.shape.password.unwrap().safeParse(password)
  if (!passwordResult.success) exitWithIssues(passwordResult.error.issues, 'password')

  return { ...userResult.data, password: passwordResult.data, role: roleResult.data }
}

function exitWithIssues(issues: { path: PropertyKey[]; message: string }[], field?: string): never {
  for (const issue of issues) {
    console.error(`Error: ${field ?? issue.path.join('.')} — ${issue.message}`)
  }
  process.exit(1)
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
      normalizePassword(password),
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

/** Same policy the API enforces — this script writes the credential row directly. */
async function assertPasswordStrength(args: CreateUserArgs): Promise<void> {
  const strength = await checkPasswordGuessability(args.password, args)
  if (!strength || strength.acceptable) return
  console.error('Error: password is too easy to guess.')
  if (strength.warning) console.error(`  ${strength.warning}`)
  for (const suggestion of strength.suggestions) console.error(`  - ${suggestion}`)
  process.exit(1)
}

async function createUser(args: CreateUserArgs): Promise<void> {
  await assertPasswordStrength(args)
  const { DATABASE_URL } = loadEnv()
  const db = createDb(DATABASE_URL, { max: 1 })

  try {
    await db.transaction(async (tx) => {
      const existing = await tx
        .select({ email: user.email, name: user.name })
        .from(user)
        .where(or(eq(user.email, args.email), eq(user.name, args.name)))
      if (existing.length > 0) {
        if (existing[0].email === args.email) {
          throw new Error(`A user with email "${args.email}" already exists.`)
        }
        throw new Error(`A user with name "${args.name}" already exists.`)
      }

      const hashedPassword = await hashPassword(args.password)
      const userId = generateId()
      const accountId = generateId()

      await tx.insert(user).values({
        id: userId,
        email: args.email,
        emailVerified: true,
        name: args.name,
        role: args.role,
        state: 'active',
      })

      await tx.insert(account).values({
        id: accountId,
        userId: userId,
        // The key Better Auth's sign-in lookup uses: a mismatch here mints an
        // account it never finds
        accountId: userId,
        providerId: CREDENTIAL_PROVIDER_ID,
        password: hashedPassword,
      })
    })

    console.log(`✓ User created successfully:`)
    console.log(`  Name:  ${args.name}`)
    console.log(`  Email: ${args.email}`)
    console.log(`  Role:  ${args.role}`)

    if (args.role !== 'sysadmin') {
      try {
        const [result] = await db
          .select({ value: count() })
          .from(user)
          .where(and(eq(user.role, 'sysadmin'), eq(user.state, 'active')))
        if (result.value === 0) {
          console.log('')
          console.log('⚠ Warning: No sysadmin user exists. Create one with --role sysadmin')
        }
      } catch {
        // Non-critical: user was created successfully, just skip the warning
      }
    }
  } finally {
    await closePool()
  }
}

parseArguments()
  .then(createUser)
  .catch((err) => {
    console.error('Failed to create user:', err.message)
    process.exit(1)
  })
