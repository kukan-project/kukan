# ADR-060: Bring the CKAN-compatible API's reads in line with CKAN 2.12

## Status

**Accepted** — 2026-10-03

The read actions under `/api/3/action/*` follow CKAN 2.12 in how they are called, the shapes they
return and the way they fail. A parameter that cannot be read is refused rather than ignored. Write
actions are outside this ADR.

## Context

The CKAN-compatible API was built in Phase 1 as a thin layer that renamed some of the REST API's
fields to snake_case. While making a resource's `extras` settable, it was checked against upstream
(CKAN 2.12's source, ckanapi and ckanext-harvest), which showed the following.

### 1. CKAN's own clients could not call it

- **It did not answer POST** (404). ckanapi's `RemoteCKAN` posts by default (`get_only=False`) and
  calls the unversioned `/api/action/`. The ckanapi example in the site documentation did not work
- Tokens were read only with `Bearer`. ckanapi sends `Authorization: <token>` and `X-CKAN-API-Key`
- `package_search` **silently ignored** `fq`, `sort`, `facet.*` and `include_private`.
  ckanext-harvest's CKAN harvester fetches changes with `fq=metadata_modified:[X TO *]` and pages
  with `sort=id asc`, so it was handed everything every time
- `package_list` was cut at 1000 by the search's limit

### 2. The shapes differed

- Missed renames (`author_email`, `maintainer_email`, `url_type`, `image_url`, …)
- Fields CKAN has were missing (`num_resources`, `num_tags`, `isopen`, `license_url`, a tag's
  `display_name`, …)
- `extras`: CKAN returns a dataset's, an organization's and a group's as `[{key, value}]` and spreads
  a resource's onto its top level. KUKAN returned all of them as objects
- An uploaded resource's `url` was its file name alone, which a CKAN client cannot fetch
- `__type` on a failure was always `Validation Error`

### 3. Internal values were showing

Resource responses carried `contentRevision`, `pendingStorageKeyAt`, `pipelineStatus` and others.
To CKAN, unknown top-level fields on a resource **are extras**: a CKAN harvesting KUKAN stores them
on its own site as such.

## Options considered

### A) Keep the thin layer and document the differences

The smallest change, but CKAN's clients would go on not working. The reason to have a compatible
API at all is that existing CKAN tools can read the site, which this does not serve.

### B) Bring the reads in line with CKAN — adopted

Fields are written out in CKAN's shape one by one (`packages/api/src/routes/ckan/format.ts`) instead
of being renamed from the REST response. A column added to KUKAN does not reach the compatible API
until someone decides what CKAN would call it.

### C) Include the writes

`package_create` / `resource_create` (multipart upload) / `*_update` / `*_patch` need to be matched
with drafts (ADR-039) and the shape of validation errors — a different scale of work, not taken up
here.

## Decision

### 1. Calling

- Every action answers GET (query string) and POST (JSON body or form)
- Mounted at both `/api/3/action` and `/api/action`
- Besides `Bearer`, tokens are read from `Authorization: <token>` and `X-CKAN-API-Key`, on
  `/api/(3/)action/` only. The REST API's contract (`Bearer` only) is unchanged
- A POST body is cut off at 1 MiB before it is read (413); read actions take no multipart
- Parameter defaults and caps follow CKAN (`package_search` `rows` 10 by default and at most 1000,
  `organization_list` by `title asc`, `limit` at most 25 with `all_fields`, …). `include_private` on
  `package_search` defaults to `false`, as in CKAN
- The counts and datasets of `organization_show` / `group_show`, and the datasets of `tag_show`, are
  under the caller's visibility, as the lists' counts are. `include_datasets` returns up to 10 for an
  organization and 1000 for a group, as in CKAN

### 2. Failing

As in CKAN's `views/api.py`: 404 with `Not Found Error`, 409 with `Validation Error` (a dict of
reasons by parameter) for bad parameters, 403 with `Authorization Error`. Unknown actions and
malformed JSON answer 400 with a bare string, no envelope. `help` is the `help_show` URL, and
`help_show` exists.

### 3. Refuse what cannot be read

`fq` is read only as AND-ed terms the KUKAN search can express (`organization`, `owner_org`,
`groups`, `tags`, `res_format`, `license_id`, `capacity`, a `metadata_modified` range, …). `OR`,
negation, parentheses and unknown fields are **refused with 409**, as is `site_id`, with no site
identifier to compare it with. So is a `sort` naming more than
the one field the search can order by (plus `score`). With `score` first and a `q`, results follow
the search's ranking, ties newest first; only `metadata_modified desc` may follow `score` then, and
anything else, which cannot be expressed, is refused. Without a `q` every score is equal, and the
following field orders the results, as in Solr. `score` after a field, a tiebreak the search cannot take, is refused. Dates are accepted only as UTC ending in `Z`, as
Solr requires; a time without a zone is not read in the server's.

Ignoring them returns more than was asked, with no way for the caller to notice — which is exactly
the harvester's fetch-everything found here.

For this the search adapters gained an `updated` range (`updatedFrom` / `updatedTo`) and ordering by
`id`.

### 4. A resource's top level carries only what a person put there

To CKAN, unknown top-level fields on a resource are extras. So besides CKAN's standard fields, only
**the resource's `extras` and `section` (ADR-050)** go there; the pipeline's and health check's
internal values do not.

Collisions:

- CKAN's standard field names and `section` are reserved `extras` keys, refused on write. Should a
  value stored before the reservation have one, the standard fields and `section` still win on
  output

### 5. Left out

- **Organization and group members (`users`) and `member_count`.** KUKAN shows membership counts to
  members only (`orgMemberCountSql`) and does not relax that for compatibility. The field is absent
  rather than an empty list, which would read as "no members"
- A dataset's AI-generated fields and quality score. AI-written text is not mixed into CKAN's
  fields (the reason of ADR-053 §10.1)
- Fields CKAN has with no KUKAN counterpart (`relationships_as_*`, …) are empty or 0

## Consequences

- **For current users of the CKAN-compatible API this is a breaking change**: the shape of `extras`,
  renamed fields, removed KUKAN fields, `package_search` defaults (`rows`, `include_private`) and the
  failure status (400 → 409). The release notes say so
- The REST API (`/api/v1`) only gains `description`, `imageUrl` and `created` on a dataset's groups
  and `created` on its organization
- Sorting by `name` on OpenSearch pointed at the analyzed text field and failed; it now uses
  `name.keyword` (which also fixes REST `sort_by=name`)

## Open items

- Write actions (option C)
- Solr syntax in `q` (`name:foo`, …) is not interpreted; `q` is read as keywords
- No tag vocabularies; `vocabulary_id` on `tag_list` is refused
- Actions not listed, such as `status_show`

## Related ADRs

- ADR-012: API as a library, single origin
- ADR-013: Search vs DB filtering
- ADR-017: Server-proxied downloads (an uploaded resource's `url`)
- ADR-039: Dataset drafts
- ADR-050: Resource sections
- ADR-053: AI-generated resource abstracts
