/**
 * EcrAssetRetentionConstruct restates the bootstrap template's own lifecycle
 * rules because PutLifecyclePolicy replaces the whole document. Pin them to
 * the installed CLI's template so an upstream change is caught here rather
 * than silently reverted on the next deploy.
 */

import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { STOCK_LIFECYCLE_RULES } from '../constructs/ecr-asset-retention.js'

// The CLI is a devDependency of infra; its template is not on the package's exports map.
const BOOTSTRAP_TEMPLATE = new URL(
  '../../node_modules/aws-cdk/lib/api/bootstrap/bootstrap-template.yaml',
  import.meta.url
)

describe('EcrAssetRetentionConstruct', () => {
  it('restates exactly the lifecycle rules of the installed CLI bootstrap template', () => {
    const template = readFileSync(BOOTSTRAP_TEMPLATE, 'utf8')
    const blocks = [...template.matchAll(/^ {8}LifecyclePolicyText: \|\n((?: {10}.*\n)+)/gm)]
    expect(blocks).toHaveLength(1)
    const stock = JSON.parse(blocks[0]![1]!.replace(/^ {10}/gm, '')) as { rules: unknown[] }
    expect(stock.rules).toEqual(STOCK_LIFECYCLE_RULES)
  })
})
