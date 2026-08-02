ALTER TABLE "resource_version" ADD COLUMN "format" varchar(100);--> statement-breakpoint
-- Existing versions were interpreted under the resource's current label, since
-- that is the only rule they were ever read by. Writing it onto the row records
-- what already happened rather than deciding anything new.
UPDATE "resource_version" rv
SET "format" = r."format"
FROM "resource" r
WHERE r."id" = rv."resource_id" AND rv."format" IS NULL;
