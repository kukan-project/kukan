ALTER TABLE "resource" ADD COLUMN "pending_storage_key_at" timestamp with time zone;--> statement-breakpoint
-- Pending keys minted before this column existed have no timestamp, so the
-- sweep would never see them. Date them now: an upload in flight gets the full
-- window, and one abandoned earlier is reclaimed a window from here.
UPDATE "resource" SET "pending_storage_key_at" = NOW() WHERE "pending_storage_key" IS NOT NULL;