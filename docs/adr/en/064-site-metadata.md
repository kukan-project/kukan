# ADR-064: Keep site-wide custom metadata as key-value pairs in runtime settings

## Status

**Accepted** — 2026-10-10 (proposed 2026-10-10)

Arbitrary values used across the site (population, households, reference dates, a tagline, ...) are
kept as flat **key → value** pairs in `system_setting` (ADR-036) and edited by a sysadmin from the
admin screen. A value is one of three kinds: a number, a string (including per-language strings) or
a date. They are served on
the public settings API, and both the core and brands read them through the same accessor. What a
key means is decided by the component that reads it.

## Context

### 1. Where this started

Municipal catalogs often show a row of figures that represent the site — population, households,
population change — on the top page.

| Population  | Households  | Population change (month on month) |
| ----------- | ----------- | ---------------------------------- |
| 123,456     | 123,456     | -12                                |
| 1 June 2026 | 1 June 2026 | 1 June 2026                        |

The values change **about once a month**. Beyond figures, there are other "site values" a brand
wants to drop into its design, such as a tagline or a contact phone number.

### 2. The existing places do not fit

- **Brand (ADR-023 / ADR-042)**: `brand-config.ts` is fixed at build time. Every corrected value
  means a build and a deploy. The person updating it is a municipal staff member, not someone who
  edits the fork's code
- **Announcements**: a list of titles and dates, not shaped for picking out individual values by name
- **Hard-coding in a brand component**: same as the brand config — an update becomes a deploy

ADR-036 decided that "content-type settings with no baseline live only in runtime settings", and
`search-example-queries` was already moved from the brand to the admin screen on that basis.

### 3. Do not fix the use in advance

The first use is the top page's figures, but which values a site wants, and how they combine,
differ from site to site. A type per use (a "highlight" = label, value, unit and reference date, and
so on) would need a core change for every new use. The store is generic; composition is left to the
reader.

## Options considered

### A) Put them in `brandConfig` — rejected

Updating a value becomes a build and a deploy (Context §2).

### B) A type per use (an array of "highlights": label, value, unit, reference date, source) — rejected

The core's standard component could render it directly, but it serves nothing other than the band
of figures. Values with no reference date, string values, or a reference date shared by several
figures would each need another type.

### C) Key-value with display attributes on the value (`{ value, label?, unit?, asOf? }`) — rejected

More general than B, but the choice of attributes leans toward the band of figures. Which attributes
are needed depends on the use, and in the end the reader decides. Keeping attributes as separate keys
is enough.

### D) Flat key-value with values only — adopted

One value per key, as in `population = 123456` and `population-as-of = "2026-06-01"`. Units and
reference dates, when needed, are separate keys too. Each entry carries its value kind (number,
string or date). Rides on the ADR-036 infrastructure as is
(registry, generic API, audit log, 30-second cache).

## Decision (proposed)

### 1. Setting key and value shape

The setting key is `site-metadata`. Its value is an array of entries, each holding a key, a value
kind and a value.

```typescript
// key: ^[a-z0-9][a-z0-9-]{0,63}$, unique within the list
type SiteMetadataEntry =
  | { key: string; type: 'number'; value: number }
  | { key: string; type: 'text'; value: LocalizedText } // string | { ja?: string; en?: string }
  | { key: string; type: 'date'; value: string } // YYYY-MM-DD
```

- The default is an empty array
- At most 100 entries. Strings are at most 1,000 characters per language. Numbers must be finite
- It is an array to keep the admin screen's order (a jsonb object does not keep key order). The order
  carries no meaning

**Each entry states its value kind.** JSON has no date type, so a date and a string cannot be told
apart by the value's shape. The kind chosen in the admin screen is stored as is, and on save the value
is validated against that kind's schema.

**Numbers and strings are kept apart.** A number lets the display apply the locale's digit grouping,
decimal places and sign. Entered as a string such as `"123,456"`, the English display could not change
the grouping, so values meant as numbers are entered as numbers.

**Dates are a kind of their own.** The value is an ISO 8601 date (`YYYY-MM-DD`), checked on save to
be a real date (`2026-6-1` and `2026-02-30` are refused). There is no time of day: a date is enough
for a monthly reference date, and a kind can be added when a date-time is needed. The display chooses the Japanese era or Gregorian calendar and formats it (§4).
Stored as the string "令和8年6月1日", it could not be shown in English or in the Gregorian calendar.

**Strings that change with the language can be held per language.**
`{ ja: '探す・見る・ダウンロードする', en: 'Find, view, download' }`. Values that do not change with
the language (a phone number and so on) can be plain strings.

### 2. The reader decides what a key means

The core gives keys no meaning. Which key is used for what is decided by the component that reads it
(a brand's `TopPage` and so on).

- There is no attribute saying where to display a value. The component selects values by key
- Changing or removing a key in the admin screen makes that value disappear from any display that
  reads it (not an error). The accessors return `undefined` when a key is absent or its type is not
  the one expected
- **Keys starting with `kukan-` are reserved for the core.** They are kept free for when the core
  gives a particular key a meaning (for instance, read by the standard top page). Brands and sites use
  any other key

### 3. Public accessor

Add `metadata` to the existing `GET /api/v1/site/settings`. In the response it is an object keyed by
key, for easy lookup, without the value kinds
(`{ "population": 123456, "population-as-of": "2026-06-01", ... }`). Dates are returned as ISO
strings. Returning the kinds would make brands unwrap each value. Whether to treat a value as a date is
the reader's call through `metadata.date(key)` (a value validated as a date on save always reads).

**Everything is public.** It is served on an API anyone can read, so only values fit to publish go
in. The admin card says so.

### 4. Web-side parts

These live in the core and are used by core pages and brands alike.

- **Accessor**: `getSiteMetadata()` for Server Components. It reads `site/settings` once per request
  (React `cache`), sharing the read the top page already makes
- **Typed getters**: `metadata.number(key)`, `metadata.text(key, locale)` (resolves per-language
  strings), `metadata.date(key)` (returns a value only when it is a real ISO date, by the same rule as the
  save-time check; an entry of the date kind always is)
- **Formatting parts**: `SiteNumber`, which renders a number for the locale (`signed`,
  `fractionDigits`), and `SiteDate`, which renders a date (`calendar`: `'japanese'` / `'gregory'`;
  the default is the Japanese era for the Japanese display and Gregorian for English, via
  `Intl.DateTimeFormat` with `ja-JP-u-ca-japanese`), and `SiteText`, which renders a text resolved for
  the display language. Each takes the key as `name` (`<SiteNumber name="population" />`; React
  reserves the `key` prop) and renders nothing when the value is absent or of another kind

The core's standard top page reads nothing for now. When the core decides on keys to read, it reads
them under `kukan-` (Open issues).

### 5. Editing

- Add one card to `/dashboard/admin/site`. Only a sysadmin can edit (ADR-036's generic API,
  `PUT /api/v1/admin/settings/site-metadata`)
- Each row takes a key, a value kind (number / string / per-language string / date) and the value.
  Dates are entered with a date field. Rows can be added, removed and reordered
- Changes are recorded in `audit_log` by the existing mechanism (`{ key, value, previous }`)

### 6. Delay before a change shows

No new measures. The current layers hold values for:

| Layer                             | Held for                                        |
| --------------------------------- | ----------------------------------------------- |
| Settings cache in the API process | 30 s (immediate on the task that took the save) |
| CloudFront HTML cache (AWS only)  | 60 s (bypassed while signed in)                 |

Anonymous visitors see a change within about 90 seconds on AWS and 30 seconds on Docker Compose —
short enough for monthly values. A sysadmin who looks right after saving bypasses CloudFront with the
session cookie and sees the new value, while anonymous visitors may still see the old one. The admin
card says so.

Reading them on every page still hits the 30-second cache, so using them in the header or footer adds
almost no load.

## Consequences

- One key in the `system_setting` registry, one field in the `site/settings` response, one card in the
  admin screen, and accessor and formatting parts in web. No new table and no migration
- Brands no longer need a rebuild to update the values
- Since the core gives keys no meaning, validation stops at value kind and length. Whether
  `population-as-of` was entered as a date is not checked (entered as a string holding a real ISO
  date, it still reads through `metadata.date(key)`; a string such as `2026-02-30` does not)
- Not exposed through MCP or the CKAN-compatible API. Decide separately if needed

## Open issues

1. **Keys the core gives meaning to** (the `kukan-` prefix). For when the core decides the keys and
   shape it reads, such as a band of figures on the standard top page
2. **Read values from the catalog's resources.** The population statistics are usually published as a
   dataset on the same site, and hand-entered values will drift from the published data. Through the
   ADR-032 query infrastructure, take the latest row of a given resource and column and replace the
   key's value. Table shapes differ from site to site, so decide how to specify this and what to do
   when it cannot be read first
3. **A date-time kind.** Add a `datetime` kind when a value needs a time of day

## Related

- ADR-023: Brand override layer
- ADR-026: API Cache-Control strategy
- ADR-027: CloudFront reintroduction
- ADR-032: MCP data query infrastructure (used by open issue 2)
- ADR-036: DB-backed runtime system settings
- ADR-042: Multi-brand build
