CREATE TABLE "resource_pipeline" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"error" text,
	"content_hash" text,
	"preview_key" text,
	"metadata" jsonb,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_pipeline_step" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"step_name" varchar(50) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX "idx_resource_ingest_status";--> statement-breakpoint
ALTER TABLE "resource_pipeline" ADD CONSTRAINT "resource_pipeline_resource_id_resource_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resource"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_pipeline_step" ADD CONSTRAINT "resource_pipeline_step_pipeline_id_resource_pipeline_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."resource_pipeline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_resource_pipeline_resource_id" ON "resource_pipeline" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "idx_resource_pipeline_status" ON "resource_pipeline" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_pipeline_step_pipeline_id" ON "resource_pipeline_step" USING btree ("pipeline_id");--> statement-breakpoint
ALTER TABLE "resource" DROP COLUMN "preview_key";--> statement-breakpoint
ALTER TABLE "resource" DROP COLUMN "ingest_status";--> statement-breakpoint
ALTER TABLE "resource" DROP COLUMN "ingest_error";--> statement-breakpoint
ALTER TABLE "resource" DROP COLUMN "ingest_metadata";--> statement-breakpoint
ALTER TABLE "resource" DROP COLUMN "ai_schema";--> statement-breakpoint
ALTER TABLE "resource" DROP COLUMN "pii_check";--> statement-breakpoint
ALTER TABLE "resource" DROP COLUMN "content_hash";