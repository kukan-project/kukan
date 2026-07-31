-- Hand back what the pointers were holding, before the pointers go (ADR-046 §4).
--
-- While a version named a key, the orphan sweep read it as referenced and
-- dropped its ledger record (ADR-045 §3). Dropping the column on its own would
-- leave those objects with neither a pointer nor a record — the one state that
-- ledger exists to prevent — and nothing would ever collect them.
--
-- Done here rather than by requiring a deploy to land first: the sweep asks the
-- backend before deleting, so a key whose object is already gone costs one
-- question, and one something else still references is read as referenced and
-- left alone.
INSERT INTO orphaned_object (key, expires_at)
SELECT lake_source_key, NOW() + INTERVAL '1 hour'
FROM resource_version
WHERE lake_source_key IS NOT NULL
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint
DROP INDEX "idx_resource_version_lake_source_key";--> statement-breakpoint
ALTER TABLE "resource_version" DROP COLUMN "lake_source_key";
