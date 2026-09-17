ALTER TABLE "resource" ADD COLUMN "embedding" vector;--> statement-breakpoint
ALTER TABLE "resource" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "resource" ADD COLUMN "embedding_hash" text;--> statement-breakpoint
ALTER TABLE "package" DROP COLUMN "embedding";--> statement-breakpoint
ALTER TABLE "package" DROP COLUMN "embedding_model";--> statement-breakpoint
ALTER TABLE "package" DROP COLUMN "embedding_hash";