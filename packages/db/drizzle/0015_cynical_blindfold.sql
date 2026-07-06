CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
ALTER TABLE "package" ADD COLUMN "embedding" vector;--> statement-breakpoint
ALTER TABLE "package" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "package" ADD COLUMN "embedding_hash" text;
