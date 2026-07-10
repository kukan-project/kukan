# ADR-037: Scale-Driven Backup Strategy (S3 Versioning + AWS Backup + DB Retention)

## Status

**Accepted**

## Context

Durability of uploaded files and availability are questions every data-catalog
adoption decision raises (in government and public-sector deployments in
particular, compliance with document-management rules is a precondition).
Data protection in the current AWS deployment has these gaps:

- **S3**: eleven-nines durability (replicated across 3+ AZs in-region), but
  **versioning is disabled**, so nothing protects against application-level or
  human deletion/overwrite. Strong against infrastructure failure, defenseless
  against operator mistakes — an asymmetry
- **RDS/Aurora**: automated backups are on, but retention is the **CDK default
  of 1 day**. A 1-day point-in-time-recovery (PITR) window cannot cover data
  corruption that is noticed late
- **No isolated backups**: every backup is tied to its source resource. There
  is no independent recovery path for incidents where the DB instance itself
  is deleted, or for broad in-account mis-operation or malicious action

Also, RDS/Aurora automated backups cap retention at **35 days** by AWS design,
so long-term generations (monthly × years) that government document-management
rules may require cannot be met with native features alone.

## Decision

### Two backup layers

Use two layers that defend against different threats.

| Layer                            | Mechanism                                   | Covers                                                                |
| -------------------------------- | ------------------------------------------- | --------------------------------------------------------------------- |
| Native (S3 versioning / PITR)    | Continuous, tied to the resource            | Immediate recovery from recent deletes/corruption (per-second/object) |
| AWS Backup (Backup Vault + Plan) | Daily/monthly snapshots in isolated storage | Resource-wide loss, generations beyond 35 days, isolated custody      |

Recent history exists in both layers. That overlap is intentional — a
"restore quickly" continuous backup and an "isolated escape copy" serve
different purposes (standard practice).

### Add a `backup` section to `ScaleComputed`

Backup settings become **part of the scale presets** rather than a standalone
field (riding ADR-031's "preset + deep-partial `overrides`" machinery). This
follows the precedent of `db.multiAz` / `opensearch.indexReplicas`:
availability and data-protection policy is defined by the scale, and
per-environment particulars are fine-tuned via `overrides`.

```ts
backup: {
  /** S3 versioning (protects against accidental delete/overwrite; required for AWS Backup on S3). */
  s3Versioning: boolean
  /** Days to keep noncurrent object versions (bounds versioning storage cost). */
  s3NoncurrentVersionExpirationDays: number
  /** RDS/Aurora automated backup retention = PITR window, days (1–35). */
  dbBackupRetentionDays: number
  /** AWS Backup plan. false = disabled. */
  awsBackup: false | { dailyRetentionDays: number; monthlyRetentionMonths: number }
}
```

### Per-scale defaults

| Setting                             | small | medium | large                    |
| ----------------------------------- | :---: | :----: | :----------------------- |
| `s3Versioning`                      | false |  true  | true                     |
| `s3NoncurrentVersionExpirationDays` |   —   |   30   | 30                       |
| `dbBackupRetentionDays`             |   7   |   14   | 35                       |
| `awsBackup`                         | false | false  | daily 35d + monthly 12mo |

- small also moves up from the CDK default (1 day) to **7 days**. Even for a
  dev environment a 1-day PITR window is a thin recovery margin, and the extra
  cost is negligible
- large expresses "availability- and durability-focused production". Monthly
  generation count is tuned via `overrides` to match the adopting
  organization's document-management rules

### Contradictory configs fail at synth time

AWS Backup for S3 **requires bucket versioning** (an AWS-side constraint).
`awsBackup` enabled with `s3Versioning: false` is rejected as an **error
during config resolution** instead of silently forcing versioning on. This
follows the same "explicit over implicit correction" stance as the
misdeployment guard (mandatory `account`, ADR-031).

### New construct `backup.ts`

One construct bundles the Backup Vault (KMS-encrypted), the Backup Plan
(daily/monthly rules), Backup Selections (S3 bucket and DB targeted by ARN,
not tags), and the service role. Environments with `awsBackup: false` create
none of it.

**Vault Lock (WORM) is not adopted at this point.** During the retention
period not even administrators can delete recovery points, so a retention
design mistake becomes a cost/compliance incident outright. It will be added
as an `overrides` extension when a requirement explicitly calls for it.

### The off flow and vault handling (RETAIN + fixed name)

AWS refuses to delete a Backup Vault that still holds recovery points, so a
naive implementation makes the CloudFormation update fail the moment an
environment is switched back to `awsBackup: false`. To avoid this:

- **The vault uses `RemovalPolicy.RETAIN`** — on disable it is orphaned, not
  deleted. The Plan/Selection are removed, so new backups stop immediately;
  existing recovery points expire on the lifecycle baked into each of them
  (e.g. daily 35d). Storage billing continues until then (only if cost must
  drop to zero immediately, empty the vault manually and delete it)
- **The vault name is fixed (`kukan-<env>-backup`); re-enable only after
  deleting the old vault** — CloudFormation makes `BackupVaultName`
  mandatory, so collision-free auto-naming is impossible (even a
  CDK-generated name is deterministic from the construct path). A switchable
  name would make the first and subsequent enables asymmetric, so the name
  stays fixed and the operational rule is to **delete the retained vault
  before re-enabling** (wait for the recovery points to age out and delete
  the empty vault, or delete the recovery points manually to re-enable
  immediately)

Disabling AWS Backup does not affect `s3Versioning`, which is an independent
field.

## Consequences

- Government requirements (recovery from operator error, isolated custody,
  long-term generations, auditable backups) are answered with one construct
  plus a scale choice
- Applying to existing environments is safe: enabling versioning and changing
  retention are both **in-place updates** (no resource replacement), and
  adding AWS Backup does not touch existing resources
- Cost impact: AWS Backup bills on stored volume (S3 backup ≈ 0.06 USD/GB-month;
  DB snapshots billed incrementally). Versioning adds S3 storage for noncurrent
  versions. Estimates should carry these as volume-based growing line items
- A `small` environment with `overrides: { backup: { awsBackup: { ... } } }`
  covers "small but strict durability requirements" deployments (e.g. small
  government offices)

## Related

- ADR-031: Multi-environment deploys (preset + overrides machinery, explicit-first stance)
- ADR-027: CloudFront reintroduction (secure-by-default precedent)
- Implementation: `infra/lib/config.ts` / `infra/lib/constructs/storage.ts` /
  `infra/lib/constructs/database.ts` / `infra/lib/constructs/backup.ts` (new)
