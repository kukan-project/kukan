CREATE TABLE "resource_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"storage_key" text NOT NULL,
	"size" bigint,
	"hash" text,
	"origin" varchar(10) NOT NULL,
	"state" varchar(10) DEFAULT 'active' NOT NULL,
	"schema" jsonb,
	"purged_at" timestamp with time zone,
	"purged_by" text,
	"purge_reason" text,
	"created_by" text,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resource_version" ADD CONSTRAINT "resource_version_resource_id_resource_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resource"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_version" ADD CONSTRAINT "resource_version_purged_by_user_id_fk" FOREIGN KEY ("purged_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_version" ADD CONSTRAINT "resource_version_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_resource_version_res_ver" ON "resource_version" USING btree ("resource_id","version");--> statement-breakpoint
CREATE INDEX "idx_resource_version_state" ON "resource_version" USING btree ("state");