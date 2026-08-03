ALTER TABLE "resource_version" ALTER COLUMN "state" SET DATA TYPE varchar(20);--> statement-breakpoint
ALTER TABLE "resource_version" ALTER COLUMN "state" SET DEFAULT 'active';