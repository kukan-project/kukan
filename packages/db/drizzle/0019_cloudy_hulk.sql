CREATE TABLE "orphaned_object" (
	"key" text PRIMARY KEY NOT NULL,
	"orphaned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resource" ADD COLUMN "storage_key" text;--> statement-breakpoint
ALTER TABLE "resource" ADD COLUMN "pending_storage_key" text;--> statement-breakpoint
CREATE INDEX "idx_orphaned_object_at" ON "orphaned_object" USING btree ("orphaned_at");--> statement-breakpoint
-- Re-introduces the column 0009 dropped: the key stopped being derivable once
-- each run started writing one of its own (ADR-043).
-- Point existing rows at the key every reader used to derive.
-- Only rows that can actually have an object: a link-type resource that was
-- never fetched has nothing stored, and null is the truthful pointer for it.
-- The next run replaces whichever key is here with one of its own.
UPDATE "resource"
SET "storage_key" = 'resources/' || "package_id" || '/' || "id"
WHERE "storage_key" IS NULL
  AND ("url_type" = 'upload' OR "hash" IS NOT NULL OR "size" IS NOT NULL);--> statement-breakpoint
-- Previews parked under the old mechanism move to the table that replaced it;
-- nothing reads `supersededPreviews` any more, so leaving them there would
-- strand exactly the objects the sweep exists to reclaim.
INSERT INTO "orphaned_object" ("key", "orphaned_at")
SELECT e ->> 'key', to_timestamp(((e ->> 'at')::bigint) / 1000.0)
FROM "resource_pipeline",
     jsonb_array_elements(COALESCE("metadata" -> 'supersededPreviews', '[]'::jsonb)) e
WHERE e ->> 'key' IS NOT NULL
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
UPDATE "resource_pipeline"
SET "metadata" = "metadata" - 'supersededPreviews'
WHERE "metadata" ? 'supersededPreviews';