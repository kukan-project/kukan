import { beforeEach, describe, expect, it, vi } from 'vitest'

const sent = vi.hoisted(() => [] as string[])
const stored = vi.hoisted(() => new Map<string, string | undefined>())
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    destroy() {}
    async send({ input }: { input: { SecretId: string } }) {
      sent.push(input.SecretId)
      if (!stored.has(input.SecretId)) throw new Error('ResourceNotFoundException')
      return { SecretString: stored.get(input.SecretId) }
    }
  },
  GetSecretValueCommand: class {
    constructor(readonly input: { SecretId: string }) {}
  },
}))

const { loadSecrets, parseSecretArns } = await import('../secrets')

const DB = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:db-AbCdEf'
const AUTH = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:auth-GhIjKl'

beforeEach(() => {
  sent.length = 0
  stored.clear()
  stored.set(DB, JSON.stringify({ username: 'kukan_main', password: 'p@ss' }))
  stored.set(AUTH, 'a'.repeat(48))
})

describe('loadSecrets', () => {
  it('does nothing without SECRET_ARNS', async () => {
    const env = { POSTGRES_HOST: 'db' }

    await loadSecrets(env)

    expect(env).toEqual({ POSTGRES_HOST: 'db' })
    expect(sent).toEqual([])
  })

  it('fills what is missing, a JSON key or the whole string, reading each secret once', async () => {
    const env: NodeJS.ProcessEnv = {
      SECRET_ARNS: JSON.stringify({
        POSTGRES_USER: `${DB}:username::`,
        POSTGRES_PASSWORD: `${DB}:password`,
        BETTER_AUTH_SECRET: AUTH,
      }),
    }

    await loadSecrets(env)

    expect(env.POSTGRES_USER).toBe('kukan_main')
    expect(env.POSTGRES_PASSWORD).toBe('p@ss')
    expect(env.BETTER_AUTH_SECRET).toBe('a'.repeat(48))
    expect([...sent].sort()).toEqual([AUTH, DB])
  })

  it('leaves what the runtime already injected', async () => {
    const env: NodeJS.ProcessEnv = {
      SECRET_ARNS: JSON.stringify({ POSTGRES_PASSWORD: `${DB}:password` }),
      POSTGRES_PASSWORD: 'from-ecs',
    }

    await loadSecrets(env)

    expect(env.POSTGRES_PASSWORD).toBe('from-ecs')
    expect(sent).toEqual([])
  })

  it('fails startup on a key the secret does not have', async () => {
    const env = { SECRET_ARNS: JSON.stringify({ POSTGRES_PASSWORD: `${DB}:pasword` }) }

    await expect(loadSecrets(env)).rejects.toThrow('has no string "pasword"')
  })

  it('fails without quoting a secret that is not the JSON a key was asked of', async () => {
    const env = { SECRET_ARNS: JSON.stringify({ BETTER_AUTH_SECRET: `${AUTH}:value` }) }

    const error = await loadSecrets(env).catch((e: Error) => e)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('is not JSON')
    expect((error as Error).message).not.toContain('aaaa')
  })

  it('fails startup when a secret cannot be read', async () => {
    const missingArn = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:gone-MnOpQr'
    const env = { SECRET_ARNS: JSON.stringify({ GA4_PRIVATE_KEY: missingArn }) }

    await expect(loadSecrets(env)).rejects.toThrow('ResourceNotFoundException')
  })
})

describe('parseSecretArns', () => {
  it.each([
    ['not JSON', 'nope'],
    ['an array', '[]'],
    ['another service', JSON.stringify({ A: 'arn:aws:ssm:ap-northeast-1:1:parameter/x' })],
    ['a version stage', JSON.stringify({ A: `${DB}:password:AWSPREVIOUS:` })],
    ['a parameter, not a secret', JSON.stringify({ A: 'arn:aws:secretsmanager:r:1:parameter:x' })],
    ['no secret name', JSON.stringify({ A: 'arn:aws:secretsmanager:r:1:secret:' })],
  ])('refuses %s', (_, raw) => {
    expect(() => parseSecretArns(raw)).toThrow('SECRET_ARNS')
  })
})
