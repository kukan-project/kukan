# Architecture Decision Records (ADR)

## Directory Structure

```
docs/adr/
├── jp/    # Japanese (authoritative / master)
└── en/    # English (machine-translated reference)
```

- **`jp/`** contains the authoritative versions of all ADRs, written and maintained in Japanese.
- **`en/`** contains machine-translated English versions provided for reference purposes only. In case of any discrepancy, the Japanese version in `jp/` takes precedence.

## Naming Convention

Files use a zero-padded sequential number prefix:

```
NNN-short-descriptive-name.md
```

## Format

Each ADR follows a consistent structure:

1. **Title** — `ADR-NNN: <title>`
2. **Status** — Accepted / Proposed / Superseded by ADR-NNN
3. **Context** — The problem or situation that motivated the decision
4. **Decision** — What was decided and why
5. **Consequences** — Trade-offs, risks, and follow-up actions
