# ADR-035: Semantic Versioning and Release Notes

## Status

**Accepted**

## Context

KUKAN has not made an explicit release so far; there were no version tags and
no changelog (every package.json still carried the initial `0.1.0`). For the
first public release we need to decide:

1. How version numbers are assigned and how bumps are determined
2. How release notes are written and what quality bar they must meet
3. What the release artifacts are (tags, CHANGELOG, GitHub Releases)

Commit subjects are already enforced by CI to be Conventional Commits in
English (`feat` / `fix` / `docs` … plus the `!` marker for breaking changes),
so the mechanical inputs for version calculation and release notes exist.
However, a bare list of commit subjects does not tell users what changed in a
release and why it matters to them.

## Decision

### 1. Semantic versioning (single product-level version)

Follow [Semantic Versioning 2.0.0](https://semver.org/). KUKAN is deployed as
a single application, so there is **one version for the whole repository**,
tracked by the root `package.json` `version` field and git tags `vX.Y.Z`.
Workspace packages are private (not published to npm) and do not maintain
individual versions.

The bump is computed automatically from commit subjects (Conventional
Commits) since the previous tag, and the release manager can override it.

| Stage         | breaking (`!`) | `feat` | anything else |
| ------------- | :------------: | :----: | :-----------: |
| While 0.x     |     minor      | minor  |     patch     |
| 1.0.0 onwards |     major      | minor  |     patch     |

- With squash merges there is no commit body to carry a `BREAKING CHANGE:`
  footer, so **breaking changes are declared solely by the `!` marker in the
  subject**.
- `1.0.0` is reserved for the official GA (all phases complete, production
  track record). The first release is `v0.7.0`, reflecting how far the
  implementation has come.

### 2. Release notes: AI-drafted, human-reviewed, bilingual

Release notes are not a mechanical dump of commit subjects. **AI (Claude)
drafts them from the commit history and diffs, and a human reviews and edits
them in the release PR.**

- **English and Japanese side by side**, serving both domestic (Japanese
  municipal) users and the international OSS audience — consistent with the
  bilingual documentation site.
- Structure: Highlights (a readable summary) plus categorized lists
  (Features / Bug Fixes, with commit subject and PR number).
- AI drafts can contain factual errors, so **nothing is published without
  review**. Reviewing the release PR doubles as reviewing the release notes.

### 3. Release artifacts and flow

```
Release PR (version bump + CHANGELOG.md update, targeting develop)
  → review & merge
  → land on main + tag vX.Y.Z
  → create the GitHub Release for the tag (body = the matching CHANGELOG section)
```

- `CHANGELOG.md` lives at the repository root; each release prepends a
  section (a `## [X.Y.Z] - YYYY-MM-DD` heading, following
  [Keep a Changelog](https://keepachangelog.com/)). The history is complete
  inside the repository; the GitHub Release is a copy of it.
- The GitHub Release body is extracted automatically from the matching
  CHANGELOG section. Tags containing `-` (e.g. `v1.0.0-rc.1`) are created
  with the prerelease flag.

## Alternatives considered

### release-please (Google)

Fully automates creating and updating the release PR, but its release notes
are a mechanical list of commit subjects and miss our quality bar. Adapting
it to the develop/main two-branch fast-forward flow also requires significant
configuration and makes the behavior opaque. **Rejected.**

### semantic-release

Fully automatic push-triggered releases. Leaves no room for humans to shape
the version or the wording, which conflicts with the AI-draft-plus-review
policy. **Rejected.**

### changesets

Optimized for per-package independent versioning and npm publishing. KUKAN is
a single-version application with no npm publishing, so this is overkill.
**Rejected.**

### GitHub auto-generated release notes

No extra tooling, but the PR-based generation is low quality and leaves no
CHANGELOG.md behind. **Rejected.**

## Consequences

- Users can follow versions and changes through tags, GitHub Releases, and
  CHANGELOG.md.
- Version bumps are derived mechanically from Conventional Commits,
  eliminating arbitrariness (overrides are possible but their rationale is
  recorded in the release PR).
- AI drafting raises the quality of release notes while mandatory review
  before publication prevents factual errors from going out.
- The risk of missing a breaking change concentrates on forgetting the `!`
  marker in PR titles; reviewers need to stay alert to API and schema
  changes.
