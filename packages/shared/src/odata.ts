/**
 * Where a resource's OData feed lives, and what its one entity set is called
 * (ADR-055).
 *
 * In `@kukan/shared` because four callers in three packages need the same
 * answer — the route that serves the feed, the app that mounts it, the MCP tool
 * that hands an agent a URL, and the dialog that shows a publisher one to copy.
 * A second spelling of either is a link that 404s, with nothing to compare it
 * against; the refusal vocabulary next door is here for the same reason.
 */

import { publicOrigin, type Env } from './env'

export const ODATA_BASE_PATH = '/odata/v1/resources'

/** The single entity set every feed publishes — one table per resource. */
export const ODATA_ENTITY_SET = 'Rows'

/** Path of one resource's service root, relative to the site's origin. */
export function odataFeedPath(id: string): string {
  return `${ODATA_BASE_PATH}/${encodeURIComponent(id)}`
}

/**
 * Absolute URL of this resource's service root, which every context URL and
 * next link is built from.
 *
 * **Taken from the deployment's public origin, not from the request.**
 * CloudFront forwards every viewer header except Host, so what reaches the
 * container is the load balancer's name: a next link built from the request
 * would send the BI tool into the VPC, where it resolves to nothing.
 */
export function feedServiceRoot(env: Env, id: string): string {
  return `${publicOrigin(env)}${odataFeedPath(id)}`
}
