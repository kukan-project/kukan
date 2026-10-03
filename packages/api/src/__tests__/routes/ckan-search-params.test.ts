import { describe, it, expect } from 'vitest'
import {
  CkanValidationError,
  parseFacetFields,
  parseFq,
  parseSort,
} from '../../routes/ckan/search-params'
import { RESERVED_RESOURCE_EXTRAS_KEYS } from '@kukan/shared'
import { ckanExtrasList, ckanTimestamp, toCkanResource } from '../../routes/ckan/format'

describe('parseFq', () => {
  it('reads the terms the CKAN harvester sends', () => {
    const { filters, empty } = parseFq(
      '+organization:"city-hall" +groups:health metadata_modified:[2024-01-02T03:04:05.123456Z TO *]'
    )
    expect(empty).toBe(false)
    expect(filters).toEqual({
      organizations: ['city-hall'],
      groups: ['health'],
      updatedFrom: new Date('2024-01-02T03:04:05.123Z'),
    })
  })

  it('joins fq and fq_list, keeping the narrower end of two ranges', () => {
    const { filters } = parseFq('metadata_modified:[2024-01-01T00:00:00Z TO *]', [
      'metadata_modified:[2023-01-01T00:00:00Z TO 2025-01-01T00:00:00Z]',
      'tags:a',
    ])
    expect(filters).toEqual({
      updatedFrom: new Date('2024-01-01T00:00:00Z'),
      updatedTo: new Date('2025-01-01T00:00:00Z'),
      tags: ['a'],
    })
  })

  it('rounds an end finer than a millisecond outward, so the range loses nothing', () => {
    expect(
      parseFq('metadata_modified:[2024-01-01T00:00:00.123999Z TO 2024-01-02T00:00:00.123001Z]')
        .filters
    ).toEqual({
      updatedFrom: new Date('2024-01-01T00:00:00.123Z'),
      updatedTo: new Date('2024-01-02T00:00:00.124Z'),
    })
    // Zeros past the millisecond are the millisecond itself
    expect(parseFq('metadata_modified:[* TO 2024-01-02T00:00:00.123000Z]').filters).toEqual({
      updatedTo: new Date('2024-01-02T00:00:00.123Z'),
    })
  })

  it('matches nothing when a dataset would need two of what it has one of', () => {
    expect(parseFq('organization:a organization:b').empty).toBe(true)
    expect(parseFq('organization:a organization:a').empty).toBe(false)
    expect(parseFq('capacity:public capacity:private').empty).toBe(true)
    expect(parseFq('dataset_type:harvest').empty).toBe(true)
    expect(parseFq('state:draft').empty).toBe(true)
  })

  it('passes over what every KUKAN dataset already is', () => {
    expect(parseFq('*:* +dataset_type:dataset +state:active')).toEqual({
      filters: {},
      empty: false,
    })
    expect(parseFq('capacity:public').filters).toEqual({ isPrivate: false })
  })

  it.each([
    'tags:a OR tags:b',
    '-tags:a',
    'NOT tags:a',
    'tags:(a OR b)',
    '(tags:a)',
    'notes:x',
    'justaword',
    'metadata_modified:2024-01-01',
    'metadata_modified:[NOW-1DAY TO *]',
    // Solr reads only UTC; without a zone the server's would be used
    'metadata_modified:[2024-01-01T00:00:00 TO *]',
    'metadata_modified:[2024 TO *]',
    // Not a day, rather than March 2
    'metadata_modified:[2024-02-31T00:00:00Z TO *]',
    'tags:"unclosed',
    // No site identifier to compare against; accepting any would widen a scoped harvest
    'site_id:default',
  ])('refuses %s', (fq) => {
    expect(() => parseFq(fq)).toThrow(CkanValidationError)
  })
})

describe('parseSort', () => {
  it('reads score first as relevance while there is a query', () => {
    expect(parseSort('score desc, metadata_modified desc', true)).toEqual({})
    expect(parseSort('score desc', true)).toEqual({})
  })

  it('orders by the field after score when there is no query to rank by', () => {
    expect(parseSort('score desc, metadata_modified desc', false)).toEqual({
      sortBy: 'updated',
      sortOrder: 'desc',
    })
    expect(parseSort('score desc, name asc', false)).toEqual({ sortBy: 'name', sortOrder: 'asc' })
    expect(parseSort(undefined, true)).toEqual({})
  })

  it('maps the fields it can order by', () => {
    expect(parseSort('id asc', true)).toEqual({ sortBy: 'id', sortOrder: 'asc' })
    expect(parseSort('name', false)).toEqual({ sortBy: 'name', sortOrder: 'asc' })
  })

  it.each([
    'title_string asc',
    'name up',
    'name asc, id asc',
    'name asc extra',
    'score asc',
    // A tiebreak the ranking cannot take
    'score desc, name asc',
    // Nor relevance as a tiebreak after a field
    'metadata_created desc, score desc',
  ])('refuses %s with a query', (sort) => {
    expect(() => parseSort(sort, true)).toThrow(CkanValidationError)
  })
})

describe('parseFacetFields', () => {
  it('reads a JSON list over GET and a list in a body', () => {
    expect(parseFacetFields('["tags","res_format"]')).toEqual(['tags', 'res_format'])
    expect(parseFacetFields(['organization'])).toEqual(['organization'])
    expect(parseFacetFields(undefined)).toEqual([])
  })

  it.each(['tags', '["author"]', '{"a":1}', [1]])('refuses %j', (value) => {
    expect(() => parseFacetFields(value)).toThrow(CkanValidationError)
  })
})

describe('ckanTimestamp', () => {
  it('writes UTC without an offset, to the microsecond', () => {
    expect(ckanTimestamp(new Date('2024-01-02T03:04:05.678Z'))).toBe('2024-01-02T03:04:05.678000')
    expect(ckanTimestamp('2024-01-02T03:04:05.678+09:00')).toBe('2024-01-01T18:04:05.678000')
    expect(ckanTimestamp(null)).toBeNull()
  })
})

describe('ckanExtrasList', () => {
  it('gives values as strings, the rest as their JSON text', () => {
    expect(ckanExtrasList({ a: 'x', b: 2, c: { d: true }, e: null })).toEqual([
      { key: 'a', value: 'x' },
      { key: 'b', value: '2' },
      { key: 'c', value: '{"d":true}' },
      { key: 'e', value: 'null' },
    ])
    expect(ckanExtrasList(null)).toEqual([])
  })
})

describe('toCkanResource', () => {
  // An extra spelled like a field the projection writes would shadow it or be
  // shadowed — the resource schema refuses those keys, so they must be all of them
  it('writes no top-level field the resource schema lets an extra take', () => {
    const resource = toCkanResource(
      {
        id: 'r',
        packageId: 'p',
        url: null,
        urlType: null,
        name: null,
        description: null,
        format: null,
        mimetype: null,
        hash: null,
        size: null,
        position: 0,
        state: 'active',
        resourceType: null,
        section: 'Annual',
        extras: null,
        created: null,
        updated: null,
        lastModified: null,
      },
      'https://example.com'
    )
    expect(Object.keys(resource).filter((key) => !RESERVED_RESOURCE_EXTRAS_KEYS.has(key))).toEqual(
      []
    )
  })
})
