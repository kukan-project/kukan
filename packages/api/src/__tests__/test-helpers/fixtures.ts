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
