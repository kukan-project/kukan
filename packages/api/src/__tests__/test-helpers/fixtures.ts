import { Readable } from 'node:stream'
import { vi } from 'vitest'
import type { LakeConfig } from '@kukan/lake'
import { randomUUID } from 'crypto'

export function createPackageFixture(overrides?: Record<string, unknown>) {
  return {
    id: randomUUID(),
    name: 'test-package',
    title: 'Test Package',
    notes: 'A test package description',
    url: null,
    version: null,
    licenseId: null,
    author: null,
    authorEmail: null,
    maintainer: null,
    maintainerEmail: null,
    state: 'active',
    type: 'dataset',
    ownerOrg: null,
    private: false,
    creatorUserId: null,
    extras: {},
    qualityScore: null,
    aiSummary: null,
    aiTags: null,
    created: new Date(),
    updated: new Date(),
    ...overrides,
  }
}

export function createOrganizationFixture(overrides?: Record<string, unknown>) {
  return {
    id: randomUUID(),
    name: 'test-org',
    title: 'Test Organization',
    description: null,
    imageUrl: null,
    state: 'active',
    extras: {},
    created: new Date(),
    updated: new Date(),
    ...overrides,
  }
}

export function createGroupFixture(overrides?: Record<string, unknown>) {
  return {
    id: randomUUID(),
    name: 'test-group',
    title: 'Test Group',
    description: null,
    imageUrl: null,
    state: 'active',
    extras: {},
    created: new Date(),
    updated: new Date(),
    ...overrides,
  }
}

export function createResourceFixture(overrides?: Record<string, unknown>) {
  return {
    id: randomUUID(),
    packageId: randomUUID(),
    url: 'https://example.com/data.csv',
    urlType: null,
    name: 'Test Resource',
    description: null,
    format: 'CSV',
    mimetype: 'text/csv',
    size: null,
    hash: null,
    position: 0,
    resourceType: null,
    state: 'active',
    extras: {},
    created: new Date(),
    updated: new Date(),
    ...overrides,
  }
}

export function createTagFixture(overrides?: Record<string, unknown>) {
  return {
    id: randomUUID(),
    name: 'test-tag',
    vocabularyId: null,
    ...overrides,
  }
}

export function createAnnouncementFixture(overrides?: Record<string, unknown>) {
  return {
    id: randomUUID(),
    title: 'Test Announcement',
    category: 'info',
    link: null,
    publishedAt: new Date(),
    created: new Date(),
    updated: new Date(),
    ...overrides,
  }
}

/**
 * DuckLake config pointed at nothing reachable: a test that unexpectedly falls
 * through to the lake fails loudly instead of quietly depending on MinIO.
 */
export const unreachableLake: LakeConfig = {
  pgConnString: 'host=127.0.0.1 port=1 dbname=nope user=nope password=nope sslmode=disable',
  bucket: 'nope',
  region: 'us-east-1',
  s3UseSsl: false,
}

/**
 * Storage backed by a map, for tests that care what an object holds.
 *
 * The copy is the part worth having real: a version owns the object it names
 * (ADR-046 §3), so "was this copied or taken over" is a question about keys and
 * bytes, and a stub that forgets the bytes cannot answer it. Reading a key
 * nothing wrote throws rather than yielding empty, since a caller reaching for
 * an object that was never written is the bug under test.
 *
 * @param objects - the map to work in, so the test can seed and inspect it.
 */
export function mapStorage(objects: Map<string, Buffer>, overrides: Record<string, unknown> = {}) {
  return {
    copy: vi.fn(async (src: string, dest: string) => {
      const body = objects.get(src)
      if (!body) throw new Error(`missing object: ${src}`)
      objects.set(dest, body)
    }),
    download: vi.fn(async (key: string) => {
      const body = objects.get(key)
      if (!body) throw new Error(`missing object: ${key}`)
      return Readable.from(body)
    }),
    delete: vi.fn(async (key: string) => {
      objects.delete(key)
    }),
    ...overrides,
  } as never
}
