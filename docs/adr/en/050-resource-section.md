> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/050-resource-section.md`](../jp/050-resource-section.md).

# ADR-050: Resource Sections (`position` Stays a Single Sequence, `section` Is a Display Label)

## Status

**Accepted** — implemented 2026-09-09.

Give a dataset that holds many resources a way to **present them grouped, folder-like**.
Hold no tree structure: add a single string label, `section`, to each resource and stop
there. The existing `position` (a per-dataset sequence) is the sole source of truth for
ordering, and `section` plays no part in it. Display lists resources in `position` order
and shows **each run of consecutive resources sharing a `section`** as one section. The
CKAN-compatible API's `resources` array (a flat array in `position` order) keeps both its
shape and its order, and how `position` is decided is untouched.

## Context

### Today

Resources are flat under a dataset, ordered only by `resource.position` (an integer,
numbered from 0 within the dataset). The only writer of `position` is
`PUT /api/v1/packages/:id/resources/reorder`, which takes a permutation of every active
resource ID and serializes under a per-dataset advisory lock. Neither the create nor the
update validator accepts `position`, and every CKAN-compatible route is read-only.

The public page lists resources vertically in `position` order, with no filter and no
search. The dashboard reorders the same list by drag and drop. Resource URLs are
ID-based — `/dataset/:name/resource/:id` — and independent of any classification.

The CKAN-derived `resource_type` column exists in the DB and API but appears in neither
the dashboard form nor the list. CKAN itself leaves this column as free text with no
defined vocabulary, and has the field commented out of its core input form (only
`listing` / `service` / `api` affect display). A "kind" axis exists, but its meaning is
KUKAN's to assign. This ADR leaves the column alone.

### Four kinds of "many resources"

"Many" hides different situations, each with a different right answer.

| Kind                       | Typical example                                   | Is a section the answer? | Existing home                                                                           |
| -------------------------- | ------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------- |
| Split by time              | 2020.csv … 2025.csv, monthly files                | No                       | Versions (ADR-043) for one series; per-year datasets plus a group otherwise             |
| Split by an axis           | 47 prefecture files, one per facility type        | **Yes**                  | None. Ideally one file with a category column, but the source's split often cannot move |
| Body plus supporting docs  | The data, a field dictionary, code tables, README | A kind field suffices    | `resource_type` (usable once KUKAN assigns a vocabulary; out of scope here)             |
| Same data, several formats | The same content as CSV / JSON / XLSX             | No                       | Parallel distributions, side by side                                                    |

Sections are the only answer for exactly one kind — "split by an axis". This ADR sets
the minimum price to pay for that one kind.

### External contracts

- CKAN's `package_show` returns `resources` as a flat array in `position` order. CKAN
  itself has no folder concept; its early `resource_group` was removed and it has been
  flat since. KUKAN's CKAN-compatible API returns this shape, and clients such as ckanapi
  rely on it
- CKAN stores unknown resource keys as resource extras. When KUKAN is harvested from
  CKAN, a scalar added to a resource survives as an extra
- Neither DCAT 3 nor DCAT-AP 3.0 has a term that groups distributions.
  `dcterms:hasPart` is defined on `dcat:Resource` (Dataset and the like); Distribution is
  not covered. What DCAT offers is vocabulary for **splitting the dataset**: nested
  datasets (`dcterms:hasPart`), `dcat:DatasetSeries`, and bundling into one
  distribution (`dcat:packageFormat`), which answer "split by an axis", "split by time"
  and "download it all" respectively

## Options Considered

### A) Filtering only (no DB change)

Add substring search on the name and a format filter to the resource list. Up to a few
dozen resources, "I want to group" usually means "I want to find", and this dissolves
many requests. It does not answer the "split by an axis" wish to **see them as a set**.
Can be done independently of this ADR.

### B) Automatic grouping by naming convention (no DB change)

Derive headings from a `/` in the resource name or a shared prefix. Holds no data, so it
is easy to retract, but the headings collapse the moment the convention is not followed,
and nobody detects the collapse. It imposes a convention on operators with no guarantee it
is honored.

### C) A single label column

Add one string label to each resource. Its relationship to ordering can go three ways.

**C-1) `position` restarts per section (rejected)** — ordering becomes two axes,
(section, position). The CKAN-compatible output's `position` reads `0, 1, 0, 1, …`, and
a client that sorts by `position` sees a broken order. A separate column for the
sections' own order becomes necessary too.

**C-2) `position` stays a single sequence, the label enforces contiguity (rejected)** —
hold "resources sharing a label are contiguous in `position`" as an invariant: reject
violating permutations on reorder, and on create and on a label change in update, move
the resource to the end of its section and renumber. This keeps the CKAN-compatible
order, but touches all three paths that write `position`, and sections behaving as "sets"
brings contracts of their own (permutations that get `400`, positions that move silently).

**C-3) `position` stays a single sequence, the label is display-only (adopted)** — the
label plays no part in ordering. Display lists in `position` order and shows each **run**
of consecutive resources sharing a label as one section. When a different label (or an
unclassified resource) sits in between, a section of the same name simply appears again.
A section is a "run", not a "set", and holds no state beyond each resource's label. The
only writer of `position` remains reorder, and create / update merely gain one column.

### D) A `resource_folder` table (rejected)

Holds a tree of arbitrary depth. All it buys is nested display; in exchange it carries:

- structure outside the `resources` array, which cannot keep the CKAN-compatible shape
- a lifecycle — empty folders, renames, dataset purge (ADR-028 / ADR-039) with CASCADE,
  exclusion during moves
- the moment folders appear as "things", per-folder publication control gets requested,
  and permissions are per dataset (so are drafts under ADR-039) — it does not exist in
  the current model

If real nesting is needed, read it as a signal to split the dataset. DCAT takes the same
position: when there are too many distributions to keep together, the standard's answer
is child datasets under `dcterms:hasPart`.

## Decision

Adopt C-3.

### The name is `section`, not `folder`

The request was for something "folder-like", but the field name and the UI wording are
**`section`**. `folder` evokes a container, a hierarchy and "putting things inside" —
precisely the folder-as-a-thing (nesting, per-folder permissions) this ADR rejects.
`section` means "a run delimited by a heading", which is exactly what C-3 is: the same
name may reappear, and it is not a set. No standard vocabulary has a term for a grouping
of distributions (see External contracts), so any name is site-local, and the choice is
made on fit with the design alone.

### Data model

- `resource.section TEXT NULL`. Null means unclassified
- **`/` is reserved as the hierarchy separator.** The public page draws it as nesting,
  three levels deep (see "Nesting on the public page"); the dashboard shows a name
  containing `/` as one heading, whole
- Normalization: split on `/`, trim each segment, drop empty segments (leading or
  trailing `/`, `//`), and rejoin with `/`. An empty result becomes null. The length cap
  follows `name` and is settled at implementation time
- **One invariant: a name labels one contiguous run and no more.** A write that would
  leave the same name on two separated runs is refused — reorder checks the resulting
  order with or without `sections`, create / update check a `section` string and a
  `null` clearing one alike. The difference from C-2 is that nothing is moved to repair it —
  the write is **stopped by validation**. The divider UI has no operation that splits a
  run, so the only way in is typing a name. The service layer holds the rule, checking
  under the position advisory lock; there is no DB constraint, since UNIQUE cannot say
  "contiguous" and a trigger falls outside what Drizzle manages
- Sections have no state of their own (no order, description, or ID)

### Display rule

The list is **a tree drawn as one column**: a resource is either at the dataset's root
(`section` null) or inside one section, and every resource inside a section **carries
its label**.

List in `position` order and draw as follows.

- When a resource's `section` is non-null and differs from the previous resource's, put a
  section heading before it
- **Indent** a resource that has a `section`; a root resource is not indented. With the
  levels drawn in one column, the indent is what says which level a row is on
- A resource whose `section` is null returns to the root indent, and the section before
  it closes there
- A name heads one section per dataset (the invariant above). Should the data hold a
  duplicate anyway (rows from before the check, or a direct edit), it is drawn as it is —
  two headings — rather than hidden

```
pos 0  section=null   addresses.csv
pos 1  section=docs   ── docs ──
                        field-dictionary.pdf
pos 2  section=docs     code-table.csv
pos 3  section=null   facilities.csv         ← the indent returns = root
pos 4  section=notes  ── notes ──            ← another section
                        README.md
```

### Nesting on the public page

The public page draws `/` as nesting. It is the display rule generalised: the path is
compared with the previous resource's from the front, and headings open from the first
depth that differs. Runs mean what they meant (`2024/Tokyo`, `2025/Tokyo`, `2024/Osaka`
in that order shows `2024` twice), and a resource is indented by its depth. When
`Section 1/Part 1` exists with no run of `Section 1` of its own, the parent heading
`Section 1` is synthesised from the child's path (it exists in no data). Heading
elements follow the depth — `h3`, `h4`, `h5` — so the document outline is the real thing
and no tree role is needed.

**The dashboard stays flat**, treating a name containing `/` as one heading. Nesting
the editing side would make the dividers multi-level and multiply the operations. The
display goes **three levels deep**; segments past the third are folded into the third
label, `/` and all (`a/b/c/d` shows as `a` › `b` › `c/d`). The data keeps the whole path
— only the drawing folds. Wanting a fourth level is read as the signal to split the
dataset (the same reason option D was rejected).

### Write paths

- **reorder**: positions are handled exactly as before; the contract gains an
  **optional `sections`**. A body carrying only `resourceIds` stays valid. When `sections`
  is given it names **every active resource exactly once** and is settled whole in the
  same transaction as the order (as a diff, two editors saving at once would win row by
  row and leave a split neither of them saw). They ride here for two reasons: `PUT /resources/{id}` re-enqueues the pipeline
  for a URL resource, and a heading is no reason to refetch someone else's site; and a
  run is decided by label and order together, so splitting them across two calls lets a
  read land between and show a resource under the wrong heading
- **create**: accept and store `section`; the position stays at the end
  (`MAX(position) + 1`) as today. Since that is the end, it is on the end's level, and
  the dashboard sends that level's label with the POST
- **update**: accept and store `section`; the position does not move. **Left out, the
  label is kept**; null clears it — a label is arranged from the reorder side and must not
  vanish as a side effect of an unrelated edit (the same treatment as `extras`). The form's edit
  goes through this path (it is editing the resource itself, so the pipeline re-enqueue
  happens as it always has)

### API

- REST: add `section` to the resource's input and output; accepted in the create /
  update body
- CKAN-compatible: place `section` on each resource as an additional field, verbatim.
  The array's shape and order are unchanged. Unknown fields are ignored client-side, or
  kept as resource extras when harvested into CKAN
- Neither the meaning nor the writers of `position` change

### Dashboard

Editing is done as **operations on dividers**, not as an attribute of a resource. "Add
section" sits beside "Add resource", and the per-resource form has no `section` field:
labelling rows one at a time makes it easy to leave a resource under a heading without
being in it, and "section" stops meaning what it says.

- **Add section**: naming one puts a heading below every row. From there it can be
  dragged to any place (like a row, it has no up/down buttons). More than one heading with
  no members may stand at a time
- **A clash is stopped at the name**: naming a new or renamed section after one that
  already exists shows "A section with this name already exists" and disables Save. It
  is the only way the divider UI can produce two runs of one name, so the server-side
  check is a backstop
- **Arrangement controls lock while a name is being edited**: the heading under edit is
  held by id rather than position, but rows moving under an open editor would leave no
  way to read which run the committed name belongs to
- **A heading set down claims the root resources below it**: the reading a heading has
  in a document — from the heading to the next section is its own. Only where no root
  resource follows (the end of the list, or directly above another section) does it stay
  a heading with no members. A section with no members is not saved (the data model has
  none): it is held in the browser and becomes real when a resource enters it
- **A heading is a divider, and moving it moves no row**: stepping it down hands the
  members it passed to the section above (to the root, when that is what stands above)
  — what is above a divider belongs to the heading above; stepping it up takes in the
  root rows it passed; setting it down takes everything below. All three are the one rule "from the divider
  to the next section is mine", and `position` never changes — only membership
- **Set down inside another section, it splits it there**: from the new place to the
  next heading becomes its own, and the upper half stays with the original section.
  **Set down on a heading it takes nothing** (an empty heading included) — a split only happens below a first row,
  so a section is never swallowed from above. Another section cannot empty it; only its
  own dissolve, or its own divider stepped past its last member, does
- **A heading that releases its last member is kept as an empty heading**: losing a
  name for one step too far would be unkind, so it returns to the unsaved empty state
- **New rows land on the level the end is on**: a resource created from the form, or a
  dropped file, inherits the last row's section (or a just-added heading standing there)
- **A dragged row takes the level of the row above**: dropped under a member it joins
  that section, under a root row it is at the root, at the top it is at the root — the
  sure way out of a section. **Dropped on a heading it becomes that section's first
  member**, the one thing the row above cannot say
- **To take a row out of a section**: step the heading down, or drag the row above the
  heading. There is no per-row "take out" button — taking out is easy, putting back is
  not, and the two would not pair
- **Rename and dissolve** rewrite the run under the heading. The same name standing
  elsewhere is left alone (a run, not a set)
- Every one of these edits is settled together by "Save order": one reorder carrying
  the order and the changed labels
- Every resource stays in the DOM even when collapsed (SSR / crawlers)
- Sections never enter the URL. Resource URLs stay ID-based

### Search and MCP

- A section name is a search term. The ADR-025 resource child document carries
  `section` (weighted below `name` / `description`), and so do the PostgreSQL
  fallback's ILIKE and the ADR-034 embedding text (the distinct labels on one line).
  A classifying word such as "by prefecture" or "minutes" is findable even when no
  resource name spells it. Child documents score with `score_mode: max`, so a name on
  every resource of a run counts once, not once per resource. On the search card the
  resources matched on their section alone fold into one row per section (the first
  resource plus "+N more"), and the rows are capped at five. Both adapters report what
  each hit was on (`matchedOn`) and how many matched in all (`matchedResourcesCount`, a floor when it could not be settled);
  what the adapter did not carry counts among the hidden (a hidden folded row counts all
  it stood for), and when the total could not be settled — hits went uncarried, content hits
  reached the cap, or a content hit could not be told apart from an uncarried metadata
  hit — every count is shown as a floor
- An index created before `section` gets it mapped before the process's first write
  (additive, so idempotent; a refusal is logged and the write goes ahead). The search
  path never touches the mapping. Rebuilding the index also enqueues re-embedding
- MCP draws the public page's headings in `get_dataset` (`/` nesting at the same depth,
  up to three levels) with indentation, and a `Section:` line in `get_resource`. Both
  read the headings off the same `@kukan/shared` functions as the page — two renderings
  of one definition

### Out of scope

- No facet or filter by section. It counts as a search term only, never as a
  condition that cuts one section out
- No per-section permission or publication control. The UI wording says "a display
  divider" from the outset
- `section` is not frozen into versions (`resource_version`). It is an attribute of the
  resource, not of its content
- `resource_type` is untouched. Should KUKAN assign it a vocabulary later, the roles
  divide cleanly — kind (data / document / API) is `resource_type`, grouping (by
  prefecture, by year) is `section` — and both can be used at once

## Trade-offs

- **A name cannot stand in two separated places.** Where the same word is wanted twice
  ("references" above and below), the names have to differ. Under `/` nesting,
  `2024/Tokyo` and `2024/Osaka` are different names, so placed apart they show the parent
  heading `2024` twice on the public page — a limit of checking exact names only; parent
  uniqueness is an open item
- **Dropped by DCAT.** `section` is site-local display information and does not appear
  in DCAT output. This holds for any name; it is a limit of the standard. Should DCAT
  export be taken seriously later, a natural mapping gathers the distributions sharing a
  `section` into one child Dataset hung from the parent with `dcterms:hasPart` (the `/`
  hierarchy becomes a chain of `hasPart`). Harvesting into CKAN keeps it as an extra
- **`/` is unavailable.** A section name that wants a literal `/` gets it read as a
  separator. Not reserving it was an option, but reserving it later would change the
  meaning of existing data, so it is reserved from the start
- **Not searchable by section.** An intended limit, compensated by option A's filtering

## Impact (what implementation touches)

- `packages/db/src/schema/resource.ts`: the `section` column and migration
- `packages/shared/src/validators/resource.ts`: `section` on create / update, including
  normalization, plus reorder's optional `sections`
- `packages/api/src/services/resource-service.ts`: storing on create / update, and
  relabelling within reorder. Position logic is unchanged
- `packages/api/src/routes/packages.ts`: pass `sections` on from the reorder route
- `packages/api/src/routes/ckan-compat.ts`: no change (`section` is not renamed, so the
  spread passes it through; pinned by an integration test)
- `apps/web/src/lib/resource-sections.ts`: the display rule, the drop level and the
  divider placement (new)
- `apps/web/src/components/resource-explorer.tsx`: headings and indentation per depth
- `apps/web/src/components/dashboard/dataset/resource-list.tsx`: heading rows and their
  operations, "Add section", divider placement on drag and buttons, the end level for
  new rows
- `site/src/content/docs/{ja,en}/api/rest.mdx`: the sections section; `ckan.mdx` gains
  only a pass-through note

## Open Items

1. **Whether option A (filtering) goes first or together.** It is independent of this
   ADR and cheap. Shipping it first and watching whether the request survives is the
   natural order; if the kind is already known to be "split by an axis", shipping
   together is fine
2. **Scope of section-name normalization.** Splitting on `/` and trimming are in the
   decision. Whether case and full-/half-width variants are treated as the same is
   decided at implementation time after looking at existing data
3. **No operation carries a whole section elsewhere.** A heading is a divider, so
   reordering a large section means moving its rows one by one. If multi-row selection
   and a bulk move are added, they are a row operation independent of headings
4. **Nesting in the dashboard.** The public page nests; the dashboard is flat and shows
   a name containing `/` as it is. Decide separately if a request to nest the editing
   operations appears
5. **Parent uniqueness.** Under `/` nesting, children of one parent placed apart show
   the parent heading twice, because only exact names are checked. Covering the prefix
   would need the rule defined first

## Related

- ADR-025 (OpenSearch parent-child) / ADR-034 (vector search): where a section name is
  indexed (the resource child document and the embedding text)
- ADR-017 (server-proxied download): "download the whole section" is a separate
  requirement, out of scope here
- ADR-028 / ADR-039 (purge, drafts): why permissions and publication are per dataset
- ADR-043 (resource versioning): the home for the "split by time" kind
