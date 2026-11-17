> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/072-dashboard-mirrors-public-page.md`](../jp/072-dashboard-mirrors-public-page.md).

# ADR-072: Make the Dashboard's Dataset Editor a Mirror of the Public Page (Resource List on the Left, Tabs on the Right, Version-Creating Actions Kept Apart)

## Status

**Proposed** — 2026-11-11.

Give dataset editing the same skeleton as the public page: the dataset's contents (its
resource list) on the left, and the editor for whatever is selected (the dataset or a
resource) on the right, split into tabs. URLs pair with the public ones
(`/dataset/:name/resource/:id` ↔ `/dashboard/datasets/:id/resources/:id`), so either page
can move to the other while keeping the same resource open. While a dataset is open, the
dashboard sidebar is replaced by that list.

Saving is split into three kinds — "save without creating a version", "apply the columns",
and "save the order" — and each tab states which one it uses. Every decision a person makes
about columns (primary key, settled type, role override, and later column descriptions) is
gathered into a single "Table settings" tab and applied together, once. If the draft holds a
decision that changes how the bytes are read (key, settled type), that apply creates one
version (turning the constraint in spec `phase-versioning-2-ducklake.md` §6.5 directly into
the screen). A draft holding only decisions that do not change the reading, such as role
overrides, creates no version (ADR-063).

## Context

### Today

Resource editing lives inside the "Resources" card at `/dashboard/datasets/:name/edit`. A
row of the resource table expands, and four things are stacked inside its cell
(`resource-list.tsx`, 1441 lines):

1. Name, format, description, URL / upload, extras — "Save"
2. Primary key (with sample rows, a confirmation dialog and a rebuild button) — "Apply"
   creates a version
3. Column roles (ADR-063) — read-only
4. Version history and diffs — revert and purge take effect when pressed

**Three kinds of saving sit side by side with nothing to tell them apart.** 1 creates no
version, 2 creates one, 4 acts on press. Which is which can only be learned by reading each
panel's help text.

**The same list of columns appears twice.** Primary key and role are both per-column
information, yet they are in separate panels with separate orderings.

**Getting from the public page to the editor is a detour.** The public page has a pipeline
status dialog (⚙) shown only to people who can edit, with a link to `edit?resource=:id`.
Renaming, replacing the file or setting the key means opening that link and then finding the
row in the table.

### What is coming

Each of the following is a per-column setting decided by a person, and the only place for it
is next to 2 and 3 above.

| What                                        | Source                                    |
| ------------------------------------------- | ----------------------------------------- |
| Settled type                                | Spec §6.5, §8 (ii-c)                      |
| The choice when a type changes              | Spec §8 (ii-c)                            |
| AI suggestions for key and type             | Spec §14.1 item 4 (ii-c, extends ADR-040) |
| XLSX table range                            | ADR-057 Step 2 (depends on ii-c)          |
| Column role override                        | ADR-063, next step                        |
| Column description, alias, sensitivity flag | Spec §6.2 "later"                         |

Added in today's shape, four or five panels listing the same columns would pile up inside a
table cell. And per spec §6.5, a change of settled type is **one version plus one copy of the
same bytes per apply**. A UI that settles each column immediately is not an option; changes
across several columns must be applied together, once. With the panels kept apart, changing
the key and a type together would create two versions.

### Width

The dashboard puts a 224px sidebar inside a 1200px frame. The public page's resource list
is 320px on the left (`resource-explorer.tsx`). Placing the list beside the sidebar makes
three columns, leaving roughly 650px for the Table settings tab's table (name, inferred type,
settled type, key, role, and later a description).

## Options Considered

### A) Add to today's row expansion (rejected)

As described under "What is coming", panels pile up and there is no way to apply changes
together.

### B) Only add a page per resource (rejected)

Create `/dashboard/datasets/:name/resources/:id` and link to it from the dataset editor's
table. The editing area grows, but moving between resources means going back to the dataset
table each time, and reordering and sections (ADR-050) end up on a different screen from
editing an individual resource.

### C) Edit on the public page (rejected)

Put editing controls on the public page and change things in place. Not adopted because:

- **They show different things.** The public page shows the published result. Editing needs
  the working state: draft datasets (ADR-039), pipeline failures, version diffs / revert /
  purge, column settings. The public page does show version history, but as a list, not as
  operations.
- **They are built differently.** The public page is SSR for SEO and OGP, and a brand may
  replace its components (ADR-023 / ADR-042). The dashboard is CSR (per CLAUDE.md). Putting
  editing state and controls on the public side weighs down the bundle for people who only
  read, and tangles with brand-replaced public components.

CKAN does not edit on the public page either. "Manage" on a dataset page goes to
`/dataset/edit/:name`, and a resource page goes to `…/resource/:id/edit` — separate pages.

### D) An editor that mirrors the public page (adopted)

Pair the skeleton and the URLs with the public page and make only the contents editorial.
It keeps B's benefit (room to work), and since the list is always on the left, reordering
and individual editing share one screen. Unlike C, it does not touch how the public page is
built.

## Decision

### 1. Pair URLs with the public page

| Public                                    | Editor                                                 |
| ----------------------------------------- | ------------------------------------------------------ |
| `/dataset/:nameOrId`                      | `/dashboard/datasets/:packageId`                       |
| `/dataset/:nameOrId/resource/:resourceId` | `/dashboard/datasets/:packageId/resources/:resourceId` |

```
 Public page                                   Editor
┌──────────────────────────────┐            ┌──────────────────────────────┐
│ Ward population    [✎ Manage]│ ─────────▶ │ ← All datasets               │
│ ┌────────┐ ┌───────────────┐ │            │ ┌────────┐ ┌───────────────┐ │
│ │List    │ │2024 by ward   │ │            │ │List    │ │2024 by ward   │ │
│ │ ▸2024  │ │  preview      │ │ ◀───────── │ │ ▸2024  │ │ [Basic][Cols] │ │
│ │  2023  │ │               │ │  View      │ │  2023  │ │               │ │
│ └────────┘ └───────────────┘ │  public    │ └────────┘ └───────────────┘ │
└──────────────────────────────┘            └──────────────────────────────┘
   Both arrows keep the open resource
```

- **The editor addresses a dataset by its ID.** Datasets sit at the same level as
  `/dashboard/datasets/new` (creation), so addressing them by name would resolve a dataset
  named `new` (which `slugNameSchema` does not refuse) to the creation page. An ID cannot
  collide with it. Today's editor already rewrites the address bar to the ID after opening by
  name (`datasetEditPath`). The public side keeps addressing by name; what pairs is the URL
  structure, not the string that names the dataset
- Today's `/dashboard/datasets/:nameOrId/edit` redirects to `/dashboard/datasets/:packageId`,
  and `edit?resource=:id` to `…/resources/:id` (arriving by name, it looks up the ID first).
  `resourceEditPath` (`apps/web/src/lib/paths.ts`) has a single caller, which is changed
- `/dashboard/datasets/new` (creation) is outside this decision. Once creation finishes, it
  moves to the new URL

### 2. While a dataset is open, replace the sidebar with its contents

```
┌─ Header ───────────────────────────────────────────────────────────────┐
├────────────────────────┬───────────────────────────────────────────────┤
│ ← All datasets         │ 2024 by ward            ● Processed  v7       │
│                        │                         [View public page ↗]  │
│ Ward population        │ [Basic] [Columns 2] [Versions !] [Processing] │
│  Dataset details       ├───────────────────────────────────────────────┤
│                        │ (selected tab)                                │
│ Tables            ⋮⋮   │                                               │
│ ⋮⋮ CSV 2024 by ward   ●│                                               │
│ ⋮⋮ CSV 2023 by ward   ●│                                               │
│ ⋮⋮ XLSX By age group  ●│                                               │
│ References        ⋮⋮   │                                               │
│ ⋮⋮ PDF Survey form    ●│                                               │
│                        │                                               │
│ [+ Resource][+ Section]                                                │
│ [Save order] (only when changed)                                       │
└────────────────────────┴───────────────────────────────────────────────┘
  ● = processing state (table below)    ⋮⋮ = drag (ADR-050 rules)
```

Also compared: keeping the sidebar and placing the list beside it (three columns), and
collapsing the sidebar to an icon rail. Replacement is chosen because:

- **It is exactly the public page's two columns.** Decision 1's pairing holds visually, not
  just in URLs
- **It gives the Table settings tab's table the most width.**
- **While editing a dataset, people rarely jump to other screens such as user
  management.** Global navigation remains via "← All datasets" and the header

### 3. The left list uses ADR-050's dashboard rules unchanged

Headings move as dividers. Dropping onto a heading makes the resource first in that range.
Edits are committed together with "Save order". The resource form does not show `section`.
**The dashboard stays flat**, showing a name containing `/` as a single heading. All of this
is as ADR-050 decided; only the location changes (from inside the table to the left column).

The public list is nested and the editor's is flat, so the two are not identical. The editor
stays flat for ADR-050's reason (dividers would become multi-level and add operations).

Each row shows its processing state as a dot. Every distinction today's table makes with its
status badge (`pipeline-status-badge.tsx`) survives in the dot. Since the dots replace the
table, resources that need intervention must stay findable from the list.

| Dot state    | From                                                                                                                                                  | Shown as                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Processed    | `complete`, with a version created                                                                                                                    | Success colour                                                                                       |
| Unchanged    | `complete`, but the contents matched so no version was created (today's badge: `storedNoVersion`, "no new version because the contents are the same") | Fainter success colour; told apart by state name                                                     |
| Not started  | `pending` (a terminal state: a row exists, but nothing was queued or ran; ADR-044)                                                                    | Outline only (as today). Does not suggest reprocessing (why ADR-044 keeps it apart from `cancelled`) |
| Waiting      | `queued` (queued, waiting its turn)                                                                                                                   | Outline only (as today)                                                                              |
| Processing   | `processing`                                                                                                                                          | Primary colour, animated (as today)                                                                  |
| Failed       | `error`                                                                                                                                               | Destructive colour, as in today's table                                                              |
| Cancelled    | `cancelled`                                                                                                                                           | Warning colour; contents may have no matching derivative (as today)                                  |
| Needs review | A version whose type change needs checking (ii-c)                                                                                                     | Warning colour, weaker than failed or cancelled                                                      |

Colour is not the only cue: each dot carries its state name as a tooltip and for screen readers.

### 4. Split the right side into tabs, one kind of saving per tab

**When the dataset is selected**

| Tab         | Contents                                                                                                                                                                | Saving                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Basic       | Title, URL name, organization, description, tags, license, extras, AI suggestions. For a draft, "Save & publish" and the retry when search sync failed after publishing | Save, no version (a draft can also publish) |
| Danger zone | Delete, purge (today's Danger Zone). For a deleted dataset, restore and purge                                                                                           | Press and confirm                           |

For a draft (ADR-039), the Basic tab keeps today's "Save & publish" (`POST /api/v1/packages/:id/publish`), and keeps the
retry banner shown when only the search sync failed after publishing (today's `PublishSyncBanner`). Dropping
them would leave a new draft with no way to be published.

A deleted dataset (today's `?state=deleted` view) shows the Basic tab read-only and puts
"Restore" (`POST /api/v1/packages/:id/restore`, including the choice to restore it as private)
and purge on the Danger zone tab. Dropping restore would leave no way to bring a deleted
dataset back from the screen. Both need `admin` or higher in the organization, which the API
checks.

**In a deleted dataset, resources are read-only too.** The left list only shows the resources:
they cannot be selected, reordered or added. The right side shows only the dataset's Basic tab
(read-only) and the Danger zone; no resource tabs open. Most resource writes and reads pass
only while the parent dataset is active or a draft (`checkResourcePermission` looks up only
`active` and `draft`), so even if opened, saves, column changes, diffs, reprocessing and
deletion would all fail as not found. Today's deleted view likewise shows the resources as a
read-only list.

**When a resource is selected**

| Tab             | Contents                                                                                                                                                        | Saving                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Basic           | Name, format, description, source (URL / replace), extras. Below them, what the catalogue holds about the resource (read-only, with the AI abstract) and delete | Save, no version (except source and format, decision 6)          |
| Preview         | The public page's preview (for a draft or private dataset too)                                                                                                  | None                                                             |
| Table settings  | Every per-column decision in one table (decision 5). Only for formats read as tables                                                                            | Apply the columns (a version if the reading changes, decision 5) |
| Version history | History, diffs, revert, purge, type-change review                                                                                                               | Press and confirm                                                |
| Processing      | Per-step state, reprocess (re-fetches a URL only when chosen, decision 7)                                                                                       | Press and confirm                                                |

**The two tables above show where things go; they are not an inventory of operations.** Every operation
today's editor offers stays somewhere on the new screens, including ones not listed here. The Step 1
implementation PR checks them one by one against today's screens and decides where each one moves.

**Which saves create a version is made clear before the button.** Today identical-looking buttons
have different results. The Table settings tab says it in one line at the top ("Applying a change of
primary key creates one version"). On the Basic tab only a save that changes the source or format
creates one, so that save's confirmation says it (decision 6) and the top carries no line: most saves
create none, and a line shown every time goes unread.

The Table settings tab appears under the same condition as today's key picker,
`isTableSourceFormat` (judged on the stored format, so a format being typed does not make
it come and go).

### 5. The Table settings tab: one table of columns, changes held as a draft, applied once

```
 Saving: applying key and type changes creates one version
 [✦ Ask AI to suggest key and types]
┌──────────┬───────────────┬───────────────┬──────┬──────────┐
│ Column   │ Inferred      │ Settled       │ Key  │ Role     │
├──────────┼───────────────┼───────────────┼──────┼──────────┤
│ ward_code│ string        │ Follow infer ▾│ ☑    │ ID       │
│▌year  AI │ integer       │ Follow infer ▾│ ☑    │ Date     │ ← draft rows are tinted
│ male     │ integer       │ Follow infer ▾│ ☐    │ Quantity │
│▌rate  AI │ string ←float │ decimal      ▾│ n/a  │ Rate     │
└──────────┴───────────────┴───────────────┴──────┴──────────┘
┌──────────────────────────────────────────────────────────────┐
│ 2 changes (not applied)                    [Discard] [Apply…]│
│ Applying creates v8 and re-reads the same file this way      │
└──────────────────────────────────────────────────────────────┘
```

- **One row per column, with the person's decisions as columns.** Key, settled type and role,
  in separate panels today, go into one table. Later column descriptions, aliases and
  sensitivity flags are added here as columns. The XLSX table range (ADR-057) sits above the
  table and is part of the same apply
- **Changes are held as a draft.** Changed rows are tinted, and the count and the result of
  applying stay visible below. Nothing is saved until applied
- **What applying does depends on the draft.** Decisions on the Table settings tab either change how
  the bytes are read or do not.

  | Decision                               | Reading  | On apply                                                                     |
  | -------------------------------------- | -------- | ---------------------------------------------------------------------------- |
  | Key, settled type, XLSX range          | Changes  | One version is created (inputs to version identity, spec §6.4–§6.5, ADR-057) |
  | Role override                          | Does not | No version; the profile and index are rebuilt on the spot (ADR-063)          |
  | Column description, alias, sensitivity | Does not | No version                                                                   |

  If the draft holds even one decision that changes the reading, everything goes into one
  version, including the decisions that do not. A draft holding only decisions that do not
  change the reading creates no version. The bar below and the confirmation follow this
  ("Applying creates v8" or "No new version; the profile and index are rebuilt")

- **AI suggestions only fill the draft.** Suggested rows are marked, and a person presses
  apply (the same suggest-only stance as ADR-040)
- **Applying asks for confirmation first.**

```
┌─ Apply column settings and create v8 ──────────────────┐
│ • year: add to key                                     │
│ • rate: type inferred (string) → decimal               │
│ ┌────────────────────────────────────────────────────┐ │
│ │ The file's contents are unchanged. The same file   │ │
│ │ is read again this way and becomes a new version.  │ │
│ │ v7 stays and can be returned to at any time.       │ │
│ └────────────────────────────────────────────────────┘ │
│                                  [Back] [Create v8]    │
└────────────────────────────────────────────────────────┘
```

While the Table settings tab holds a draft, every way of leaving the editor asks whether to discard
it: switching tabs, selecting another resource or the dataset details, the "← All datasets",
public page and header links, browser Back and Forward, and reloading or closing the tab
(`beforeunload`). The draft lives only on the screen and is unsaved, so letting any one of these
through silently loses the work.

**This is not limited to the Columns draft.** Every unsaved change is treated the same way: a form
being filled in on the Basic tab (for the dataset and for a resource), and an order or section edit
not yet saved (the state before ADR-050's "Save order"). Today's editor locks row actions while a
form or an order is being edited. The new screen keeps the left list always visible, so instead of
locking, selecting something else asks whether to discard.

### 6. Source and format stay on the Basic tab, and saving shows that they create a version

Two things on the Basic tab bear on versions: the source and the format. **Saving runs the
pipeline only when one of these two changed.**

Today's `PUT /api/v1/resources/:id` does not work this way. A URL resource re-queues the
pipeline on every save, even one that only changes the name or description
(`settleResourceWrites` does not check whether the URL changed), so if the fetched contents
have changed, saving a name creates a version. Conversely, an uploaded resource does not queue
the pipeline when its format changes, so the format change does not reach a version until the
pipeline next runs. Both contradict the confirmation shown before saving. So this changes:

- Queue the pipeline only when the source (URL, type) or the format differs before and after
  the save. Also queue it when an uploaded resource's format changes
- Except for saves where a file arrives after the save (switching from a URL to an upload,
  replacing the file): the `PUT` does not queue. Today's save sends the `PUT` first and the file
  afterwards; queuing on the `PUT` would process the old contents under the new source or format
  before the file arrives, creating a needless version. In this case, as today, queue when the
  file's ingest finishes (the upload's promotion)
- ADR-050's "Write paths" is written on the premise that `PUT` re-runs a URL resource's pipeline
  every time. This decision changes that premise, so a note is added at that spot in ADR-050.
  ADR-050's choice to carry reordering on reorder rather than `PUT` still holds (changing a
  heading needs no processing)
- A save that only changes name, description or extras does not queue it (the search index is
  still updated as before). To re-fetch a URL, use reprocess on the Processing tab with "Fetch the file from its URL again" chosen (`POST /resources/:id/run-pipeline`)

| What changes     | Version                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| Replace the file | Created if the contents differ from the previous version (the version gate decides by hash)    |
| URL              | Created if the fetched contents differ from the previous version; unknown until the fetch ends |
| Format           | Created (an input to version identity, `sameVersionIdentity`; created even for the same bytes) |

Format is how the bytes are read, so there is a case for moving it to the Table settings tab. It
stays on Basic because it is also a label shown on the public page, and people decide it
alongside the source. The source sits next to name and description for the same reason.

In exchange, saving a changed source or format asks for confirmation. Format says "this
creates one version". For a replaced file or a URL, whether the contents match the previous
version is not known at save time, so the message is conditional — "this creates one version
if the contents have changed" — and whether a version was created is shown once processing
ends, on the Version history tab and by the list's dot.

### 7. The entry from the public page is a "Manage" icon in the heading

- Put a pencil icon beside the dataset's name and beside the open resource's name. "Manage" is
  its tooltip and accessible name, not shown as text, so the page does not look much different
  from what a reader sees. It moves to the editor in the same tab. Shown only to people
  who can write the dataset (`editor` or higher in its organization, sysadmins, and the creator
  of a draft — the same rule as the API's `packageWriteDenial`). Requests with a
  session bypass the CDN cache (the HTML behavior in `infra/lib/constructs/cdn.ts`), so showing
  it per viewer does not pollute the cache
- **The check is `canEditPackage` (`apps/web/src/lib/roles.ts`).** The original `canManage`
  only checked whether the organization appears in `/users/me/organizations`, which includes
  the read-only `member` role. Writes require `editor` or higher
  (`makePackageAuthorize(db, user, 'editor')`), so ⚙ was shown to people who could not save
  anything. This was put into today's public page and editor ahead of time, while this ADR was
  being proposed
- Keep the pipeline status dialog (⚙), shown under the same check as above. Drop the link to the
  editor it used to hold: it went where the heading's icon goes
- The dialog and the Processing tab have one reprocess button. It rebuilds from the file held
  (`rebuildOnly`), and only a URL resource offers "Fetch the file from its URL again". Not chosen
  by default, because fetching again undoes a revert (ADR-044 §4) — except when the resource holds no
  file (it was never fetched), where there is nothing to rebuild from. Whether it holds one comes from
  the processing status API (`has_content`), not from what this screen saw happen, so a reload or
  another admin gets the same default

### 8. On narrow screens the list stacks above

The dashboard sidebar is not shown below `md` (it moves to the header menu). The editor
switches to one column at the same breakpoint, with the list placed above the content in a
collapsible form.

## Consequences

| Where                                                                           | What changes                                                                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/app/dashboard/datasets/[nameOrId]/`                               | Add a layout, the dataset page and `resources/[resourceId]/`. Keep `edit/page.tsx` as a redirect only (decision 1) |
| `apps/web/src/app/dashboard/layout.tsx`, `components/layout/sidebar.tsx`        | Under a dataset, replace the sidebar with the list                                                                 |
| `components/dashboard/dataset/resource-list.tsx`                                | Split the table and row expansion into the left list and right tabs                                                |
| `primary-key-picker.tsx`, `column-roles.tsx`                                    | Merge into the Table settings tab's single table                                                                   |
| `resource-version-history.tsx`, `version-diff-panel.tsx`                        | Move to the Version history tab                                                                                    |
| `components/resource/resource-pipeline-preview.tsx` and other public components | "Manage" icon, drop the ⚙ link, one reprocess                                                                      |
| `components/dataset/dataset-detail-layout.tsx`                                  | (Done) Decide `canManage` with `canEditPackage`                                                                    |
| `apps/web/src/lib/paths.ts`                                                     | `resourceEditPath` to the new URL                                                                                  |
| E2E (`apps/web/src/__tests__/e2e/`)                                             | URLs and steps of tests that walk through editing                                                                  |

There are two API changes.

- Narrow when `PUT /api/v1/resources/:id` queues the pipeline to changes of source or format
  (decision 6, Step 1)
- Make role overrides writable (decision 5, Step 4). Roles are read-only today: there is only
  `GET /resources/:id/column-roles`, and the `column_settings` write (`columnSettingsBodySchema`)
  accepts only the primary key. Add roles to it, and on write rebuild the profile and update the
  index on the spot (ADR-063)

Applying settled types on the Table settings tab adds them to the same write that sets the key today
(decided in the ii-c spec).

## Steps

| Step   | Contents                                                                                                                                                                                                                 | Depends on |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| Step 1 | Move to the new URLs and two-column skeleton. Merge key and role into the Table settings tab's single table (roles still read-only), with draft → apply for the key. Narrow when saving queues the pipeline (decision 6) | none       |
| Step 2 | "Manage" icon on the public page; drop the ⚙ link; one reprocess                                                                                                                                                         | Step 1     |
| Step 3 | Put ii-c (settled types, type-change review, AI suggestions) on the Table settings and Version history tabs                                                                                                              | Step 1     |
| Step 4 | Role overrides (ADR-063, next step): a write that adds roles to `column_settings`, and rebuilding the profile and index. Make the Table settings tab's role column editable                                              | Step 1     |

Step 1 changes appearance and placement but adds no capability. Applying a key is already
"choose, then apply", so draft → apply does not change its meaning. Roles are listed read-only
as today; overrides arrive in Step 4. Narrowing when saving queues the pipeline removes a
behavior (saving a name no longer re-fetches the URL); re-fetching remains available through
reprocess on the Processing tab ("Fetch the file from its URL again").

## Trade-offs

- **Global dashboard navigation is one step further away while a dataset is open.** Judged
  sufficient with "← All datasets" and the header
- **No screen shows every resource's state in one table any more.** The list's dots stand in
  for it; the left list takes over scanning for reordering
- **The list nests differently on the public and editor sides** (decision 3)

## Open Issues

- Whether to bring dataset creation (`/new`) onto the same skeleton
- How type-change review appears on the Version history tab is decided in the ii-c spec (spec §8).
  Re-fetching a URL resource happens with nobody present, so asking at ingest time cannot
  work; review happens after ingest
- How to present the Table settings tab's table when it grows wide (once descriptions and the like
  are added)

## Related ADRs

- ADR-010 / ADR-023: Theming and brand overrides (one reason not to edit on the public side)
- ADR-026 / ADR-027: Cache-Control and CloudFront (requests with a session bypass the cache)
- ADR-039: Dataset drafts
- ADR-040: AI metadata suggestions (a person settles suggestions)
- ADR-043: Resource versioning (spec §6.5, "one apply, one version")
- ADR-050: Resource sections (rules for the left list)
- ADR-057: XLSX table range (applied together on the Table settings tab)
- ADR-063: Table profile (column roles)
