/**
 * Custom Resource handler: one OpenSearch security role per site, mapped to
 * the site's web and worker task roles (ADR-069).
 *
 * Runs as the domain's master user. Create/Update put every listed role and
 * its mapping (PUT replaces, so a repeat is harmless), then delete those an
 * Update no longer lists, found from the old properties. Delete removes them
 * all, best effort: it only comes with the domain going away or a failed
 * create rolling back, and a refusal there would wedge the stack.
 */

import { signedRequest, sleep, type SignedResponse } from './transport.js'

export interface SiteSearchRole {
  /** OpenSearch role and role mapping name, e.g. `kukan-dev-citya`. */
  Name: string
  /** The role's definition, as the security API takes it. */
  Permissions: Record<string, unknown>
  /** IAM role ARNs mapped to it (the site's web and worker task roles). */
  BackendRoles: string[]
}

export interface SearchSecurityProperties {
  /** Domain endpoint hostname (no scheme). */
  Endpoint: string
  Roles: SiteSearchRole[]
}

interface CustomResourceEvent {
  RequestType: 'Create' | 'Update' | 'Delete'
  PhysicalResourceId?: string
  ResourceProperties: SearchSecurityProperties & { ServiceToken?: string }
  OldResourceProperties?: SearchSecurityProperties & { ServiceToken?: string }
}

const PHYSICAL_ID = 'kukan-search-site-roles'
const API = '/_plugins/_security/api'

/**
 * Enabling fine-grained access control on an existing domain maps every
 * principal the domain policy admits to this role, which would give each
 * site's task roles access beyond their own role. Removed on every Create and
 * Update, and the deploy fails if it cannot be: a resource that succeeded is
 * not run again until its properties change, so a mapping left now would stay.
 */
const DEFAULT_ROLE_MAPPING = `${API}/rolesmapping/default_role`

/**
 * How long to keep trying an unavailable security API. The domain resource
 * finishes before this runs, but the security index can lag the blue/green
 * cutover; within the 15-minute Lambda timeout, with room to report.
 */
const CONVERGE_BUDGET_MS = 12 * 60_000
const DELETE_BUDGET_MS = 2 * 60_000
const FIRST_BACKOFF_MS = 2_000
const MAX_BACKOFF_MS = 30_000

/** Names are interpolated into request paths made as master. */
function assertName(name: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error(`Unsafe OpenSearch role name: ${name}`)
  }
  return name
}

/** Not yet ready (FGAC still settling, nodes being replaced) rather than refused. */
function retryable(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status >= 500
}

async function call(
  endpoint: string,
  method: 'PUT' | 'DELETE',
  path: string,
  body: unknown,
  deadline: number,
  acceptNotFound = false
): Promise<void> {
  let failure = `${method} ${path} → out of time`
  for (let attempt = 0, backoff = FIRST_BACKOFF_MS; ; attempt++) {
    // Before sending, not only before retrying: each request can wait out its
    // own timeout, and a delete working through many roles must stop in time
    if (Date.now() >= deadline) throw new Error(failure)
    let res: SignedResponse | undefined
    try {
      res = await signedRequest(endpoint, method, path, body)
      if (res.status >= 200 && res.status < 300) return
      if (acceptNotFound && res.status === 404) return
      failure = `${method} ${path} → ${res.status} ${res.body}`
    } catch (err) {
      failure = `${method} ${path} → ${err instanceof Error ? err.message : String(err)}`
    }
    if ((res && !retryable(res.status)) || Date.now() + backoff > deadline) {
      throw new Error(failure)
    }
    console.log(`Retrying (attempt ${attempt + 1}): ${failure}`)
    await sleep(backoff)
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
  }
}

async function putRole(endpoint: string, role: SiteSearchRole, deadline: number) {
  const name = assertName(role.Name)
  await call(endpoint, 'PUT', `${API}/roles/${name}`, role.Permissions, deadline)
  await call(
    endpoint,
    'PUT',
    `${API}/rolesmapping/${name}`,
    { backend_roles: role.BackendRoles, hosts: [], users: [] },
    deadline
  )
}

async function deleteRole(endpoint: string, roleName: string, deadline: number) {
  const name = assertName(roleName)
  await call(endpoint, 'DELETE', `${API}/rolesmapping/${name}`, undefined, deadline, true)
  await call(endpoint, 'DELETE', `${API}/roles/${name}`, undefined, deadline, true)
}

export async function handler(event: CustomResourceEvent): Promise<{
  PhysicalResourceId: string
}> {
  const props = event.ResourceProperties
  const physicalId = event.PhysicalResourceId ?? PHYSICAL_ID

  if (event.RequestType === 'Delete') {
    const deadline = Date.now() + DELETE_BUDGET_MS
    for (const role of props.Roles) {
      await deleteRole(props.Endpoint, role.Name, deadline).catch((err: unknown) =>
        console.log(`Left role ${role.Name} in place: ${String(err)}`)
      )
    }
    return { PhysicalResourceId: physicalId }
  }

  const deadline = Date.now() + CONVERGE_BUDGET_MS
  for (const role of props.Roles) {
    await putRole(props.Endpoint, role, deadline)
  }
  const kept = new Set(props.Roles.map((role) => role.Name))
  for (const old of event.OldResourceProperties?.Roles ?? []) {
    if (!kept.has(old.Name)) await deleteRole(props.Endpoint, old.Name, deadline)
  }
  await call(props.Endpoint, 'DELETE', DEFAULT_ROLE_MAPPING, undefined, deadline, true)
  return { PhysicalResourceId: physicalId }
}
