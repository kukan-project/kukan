import { describe, it, expect, vi, beforeEach } from 'vitest'

const queryMock = vi.fn()
const connectMock = vi.fn()
const endMock = vi.fn()

vi.mock('pg', () => ({
  default: {
    Client: class {
      connect = connectMock
      query = queryMock
      end = endMock
    },
  },
}))

const getSecretMock = vi.fn()
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    send = getSecretMock
  },
  GetSecretValueCommand: class {
    constructor(input: object) {
      Object.assign(this, input)
    }
  },
}))

const { handler } = await import('../index.js')

const PROPS = {
  MasterSecretArn: 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:master',
  SiteSecretArn: 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:site',
  DbHost: 'db.example.internal',
  DbPort: '5432',
  DbName: 'kukan_citya',
  RoleName: 'kukan_citya',
}

function event(requestType: 'Create' | 'Update' | 'Delete', props = PROPS) {
  return { RequestType: requestType, ResourceProperties: props }
}

beforeEach(() => {
  vi.clearAllMocks()
  getSecretMock.mockImplementation((input: { SecretId: string }) => ({
    SecretString: input.SecretId.endsWith('master')
      ? JSON.stringify({ username: 'postgres', password: 'master-pass' })
      : JSON.stringify({ username: 'kukan_citya', password: "site'pass" }),
  }))
})

describe('site-db-handler', () => {
  it('creates role and database when neither exists', async () => {
    queryMock.mockResolvedValue({ rowCount: 0 })

    const result = await handler(event('Create'))

    expect(result.PhysicalResourceId).toBe('db.example.internal/kukan_citya')
    const sql = queryMock.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(sql).toContain("CREATE ROLE kukan_citya WITH LOGIN PASSWORD 'site''pass'")
    expect(sql).toContain('CREATE DATABASE kukan_citya OWNER kukan_citya')
    expect(sql).toContain('REVOKE CONNECT ON DATABASE kukan_citya FROM PUBLIC')
    expect(sql).toContain('GRANT CONNECT ON DATABASE kukan_citya TO kukan_citya')
    expect(endMock).toHaveBeenCalled()
  })

  it('converges an existing role/database instead of failing (idempotent re-create)', async () => {
    queryMock.mockResolvedValue({ rowCount: 1 })

    await handler(event('Update'))

    const sql = queryMock.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(sql).toContain("ALTER ROLE kukan_citya WITH LOGIN PASSWORD 'site''pass'")
    expect(sql.some((s) => s.startsWith('CREATE DATABASE'))).toBe(false)
    expect(sql).toContain('GRANT CONNECT ON DATABASE kukan_citya TO kukan_citya')
  })

  it('retains the database on Delete (no SQL at all)', async () => {
    const result = await handler({
      ...event('Delete'),
      PhysicalResourceId: 'db.example.internal/kukan_citya',
    })

    expect(result.PhysicalResourceId).toBe('db.example.internal/kukan_citya')
    expect(connectMock).not.toHaveBeenCalled()
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('rejects unsafe identifiers before touching the database', async () => {
    await expect(
      handler(event('Create', { ...PROPS, DbName: 'kukan_citya; DROP TABLE x' }))
    ).rejects.toThrow(/Unsafe PostgreSQL identifier/)
    expect(connectMock).not.toHaveBeenCalled()
  })

  it('closes the connection even when a statement fails', async () => {
    queryMock.mockRejectedValue(new Error('boom'))

    await expect(handler(event('Create'))).rejects.toThrow('boom')
    expect(endMock).toHaveBeenCalled()
  })
})
