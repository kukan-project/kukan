-- A volatile default defeats PostgreSQL's metadata-only ADD COLUMN, so this
-- rewrites the table under ACCESS EXCLUSIVE (measured: the filenode changes).
-- Every row needs its own value, so there is no default to avoid; `resource`
-- is small enough for that to be brief. A wide table would want
-- add-nullable -> backfill -> set-default+not-null instead.
ALTER TABLE "resource" ADD COLUMN "content_revision" uuid DEFAULT gen_random_uuid() NOT NULL;