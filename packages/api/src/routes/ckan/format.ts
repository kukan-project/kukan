/**
 * KUKAN rows in the shapes CKAN 2.12 returns them in.
 *
 * Written field by field rather than renamed from KUKAN's own responses: a
 * column added to KUKAN must not reach a CKAN client until someone decides what
 * CKAN would call it. The exception is a resource's top level, which CKAN gives
 * to its extras — see {@link toCkanResource}.
 */

import { findLicense, isOpenLicense } from '@kukan/shared'
import { resourceDownloadPath } from '../../services/resource-service'

type Timestamp = Date | string | null | undefined

/**
 * CKAN's timestamp: UTC without an offset, to the microsecond
 * (`2024-01-02T03:04:05.678000`), as `datetime.isoformat()` writes a naive one.
 */
export function ckanTimestamp(value: Timestamp): string | null {
  if (value == null) return null
  return new Date(value).toISOString().replace(/\.(\d{3})Z$/, '.$1000')
}

/**
 * Extras as CKAN returns a dataset's, an organization's or a group's: a list of
 * pairs whose values are strings. KUKAN accepts any JSON value, so the rest are
 * given as their JSON text — what CKAN's own validator would have demanded.
 */
export function ckanExtrasList(
  extras: Record<string, unknown> | null | undefined
): { key: string; value: string }[] {
  return Object.entries(extras ?? {}).map(([key, value]) => ({
    key,
    value: typeof value === 'string' ? value : JSON.stringify(value),
  }))
}

export interface ResourceRow {
  id: string
  packageId: string
  url: string | null
  urlType: string | null
  name: string | null
  description: string | null
  format: string | null
  mimetype: string | null
  hash: string | null
  size: number | null
  position: number
  state: string | null
  resourceType: string | null
  section: string | null
  extras: Record<string, unknown> | null
  created: Timestamp
  updated: Timestamp
  lastModified: Timestamp
}

/**
 * A resource as `resource_show` returns it.
 *
 * CKAN keeps every key it does not define on a resource as an extra and returns
 * the extras at the top level, so whatever stands there besides the core fields
 * *is* an extra to a CKAN client — and to a CKAN harvesting this site, which
 * stores them as such. Only what a person put on the resource goes there: its
 * extras, and the section label (ADR-050). The pipeline's bookkeeping does not.
 *
 * The resource schema refuses an extra spelled like any of these, and the
 * order below keeps them winning over one stored before it did.
 *
 * An upload's `url` is its download address, as CKAN's is: the file name alone
 * leaves a CKAN client nothing to fetch.
 */
export function toCkanResource(res: ResourceRow, origin: string) {
  const url =
    res.urlType === 'upload' ? `${origin}${resourceDownloadPath(res.id)}` : (res.url ?? '')
  return {
    ...res.extras,
    ...(res.section != null && { section: res.section }),
    id: res.id,
    package_id: res.packageId,
    url,
    url_type: res.urlType,
    name: res.name,
    description: res.description,
    format: res.format,
    mimetype: res.mimetype,
    mimetype_inner: null,
    hash: res.hash,
    size: res.size,
    cache_url: null,
    cache_last_updated: null,
    created: ckanTimestamp(res.created),
    last_modified: ckanTimestamp(res.lastModified),
    metadata_modified: ckanTimestamp(res.updated),
    position: res.position,
    state: res.state,
    resource_type: res.resourceType,
  }
}

export interface GroupRow {
  id: string
  name: string
  title: string | null
  description: string | null
  imageUrl: string | null
  created: Timestamp
}

/**
 * The fields of CKAN's `group` table, which holds organizations too. CKAN has
 * no state but `active` to show here, and approves every organization.
 */
function groupTableDict(row: GroupRow, isOrganization: boolean) {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    type: isOrganization ? 'organization' : 'group',
    description: row.description,
    image_url: row.imageUrl,
    created: ckanTimestamp(row.created),
    is_organization: isOrganization,
    approval_status: 'approved',
    state: 'active',
  }
}

/**
 * An organization or group as a list of them returns it, and as the `groups`
 * of a dataset do. CKAN adds `member_count` here; KUKAN shows a membership
 * count only to members (`orgMemberCountSql`), so it is left out.
 */
export function toCkanGroupSummary(row: GroupRow, isOrganization: boolean, packageCount?: number) {
  return {
    ...groupTableDict(row, isOrganization),
    display_name: row.title || row.name,
    image_display_url: row.imageUrl,
    ...(packageCount !== undefined && { package_count: packageCount }),
  }
}

/**
 * `organization_show` / `group_show`. CKAN also lists the members (`users`);
 * KUKAN does not publish who belongs to an organization, so that field is
 * absent rather than empty — an empty list would claim there are none.
 */
export function toCkanGroup(
  row: GroupRow & { extras: Record<string, unknown> | null },
  isOrganization: boolean,
  packageCount: number
) {
  return {
    ...toCkanGroupSummary(row, isOrganization, packageCount),
    extras: ckanExtrasList(row.extras),
    groups: [],
    tags: [],
    num_followers: 0,
  }
}

export interface TagRow {
  id: string
  name: string
  vocabularyId?: string | null
}

export function toCkanTag(row: TagRow) {
  return {
    id: row.id,
    name: row.name,
    display_name: row.name,
    state: 'active',
    vocabulary_id: row.vocabularyId ?? null,
  }
}

export interface PackageRow {
  id: string
  name: string
  title: string | null
  notes: string | null
  url: string | null
  version: string | null
  licenseId: string | null
  author: string | null
  authorEmail: string | null
  maintainer: string | null
  maintainerEmail: string | null
  ownerOrg: string | null
  private: boolean | null
  type: string | null
  state: string | null
  extras: Record<string, unknown> | null
  creatorUserId: string | null
  created: Timestamp
  updated: Timestamp
  resources: ResourceRow[]
  tags: TagRow[]
  groups: GroupRow[]
  organization: GroupRow | null
}

/**
 * A dataset as `package_show` returns it.
 *
 * KUKAN's own dataset fields stay out — the AI-written ones especially: a client
 * that asked for CKAN's fields cannot tell a generated sentence in them from a
 * person's (ADR-053 §10.1). CKAN's relationships have no KUKAN counterpart and
 * are always empty.
 */
export function toCkanPackage(pkg: PackageRow, origin: string) {
  const license = pkg.licenseId ? findLicense(pkg.licenseId) : undefined
  return {
    author: pkg.author,
    author_email: pkg.authorEmail,
    creator_user_id: pkg.creatorUserId,
    id: pkg.id,
    isopen: license ? isOpenLicense(license) : false,
    license_id: pkg.licenseId,
    license_title: license ? license.title : pkg.licenseId,
    ...(license?.url && { license_url: license.url }),
    maintainer: pkg.maintainer,
    maintainer_email: pkg.maintainerEmail,
    metadata_created: ckanTimestamp(pkg.created),
    metadata_modified: ckanTimestamp(pkg.updated),
    name: pkg.name,
    notes: pkg.notes,
    num_resources: pkg.resources.length,
    num_tags: pkg.tags.length,
    organization: pkg.organization ? groupTableDict(pkg.organization, true) : null,
    owner_org: pkg.ownerOrg,
    private: pkg.private ?? false,
    state: pkg.state,
    title: pkg.title,
    type: pkg.type || 'dataset',
    url: pkg.url,
    version: pkg.version,
    extras: ckanExtrasList(pkg.extras),
    resources: pkg.resources.map((res) => toCkanResource(res, origin)),
    tags: pkg.tags.map(toCkanTag),
    groups: pkg.groups.map((g) => toCkanGroupSummary(g, false)),
    relationships_as_subject: [],
    relationships_as_object: [],
  }
}
