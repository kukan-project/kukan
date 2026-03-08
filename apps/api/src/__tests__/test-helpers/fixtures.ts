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
    metadataCreated: new Date(),
    metadataModified: new Date(),
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
