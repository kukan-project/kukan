ALTER TABLE "resource_pipeline" ADD COLUMN "claim_owner" uuid;--> statement-breakpoint
ALTER TABLE "resource_pipeline" ADD COLUMN "claim_owner_at" timestamp with time zone;