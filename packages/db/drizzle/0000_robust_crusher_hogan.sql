CREATE TABLE "organization" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"title" text,
	"description" text,
	"image_url" text,
	"state" varchar(20) DEFAULT 'active',
	"extras" jsonb DEFAULT '{}'::jsonb,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"title" text,
	"description" text,
	"image_url" text,
	"state" varchar(20) DEFAULT 'active',
	"extras" jsonb DEFAULT '{}'::jsonb,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(200) NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"name" varchar(100) NOT NULL,
	"image" text,
	"display_name" text,
	"state" varchar(20) DEFAULT 'active',
	"sysadmin" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"expiresAt" timestamp with time zone,
	"password" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(200),
	"token_hash" text NOT NULL,
	"last_used" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "package" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"title" text,
	"notes" text,
	"url" text,
	"version" varchar(100),
	"license_id" varchar(100),
	"author" text,
	"author_email" text,
	"maintainer" text,
	"maintainer_email" text,
	"state" varchar(20) DEFAULT 'active',
	"type" varchar(100) DEFAULT 'dataset',
	"owner_org" uuid,
	"private" boolean DEFAULT false NOT NULL,
	"creator_user_id" uuid,
	"extras" jsonb DEFAULT '{}'::jsonb,
	"quality_score" text,
	"ai_summary" text,
	"ai_tags" text,
	"metadata_created" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata_modified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "package_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "resource" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" uuid NOT NULL,
	"url" text,
	"name" text,
	"description" text,
	"format" varchar(100),
	"mimetype" varchar(200),
	"size" bigint,
	"hash" text,
	"position" integer DEFAULT 0 NOT NULL,
	"state" varchar(20) DEFAULT 'active',
	"resource_type" varchar(50),
	"extras" jsonb DEFAULT '{}'::jsonb,
	"storage_key" text,
	"preview_key" text,
	"ingest_status" varchar(20) DEFAULT 'pending',
	"ingest_error" text,
	"ingest_metadata" jsonb,
	"ai_schema" jsonb,
	"pii_check" jsonb,
	"content_hash" text,
	"health_status" varchar(20) DEFAULT 'unknown',
	"health_checked_at" timestamp with time zone,
	"quality_issues" jsonb DEFAULT '[]'::jsonb,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL,
	"last_modified" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "package_tag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "uq_package_tag" UNIQUE("package_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"vocabulary_id" uuid,
	CONSTRAINT "uq_tag_name_vocabulary" UNIQUE("name","vocabulary_id")
);
--> statement-breakpoint
CREATE TABLE "vocabulary" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	CONSTRAINT "vocabulary_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "package_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	CONSTRAINT "uq_package_group" UNIQUE("package_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "user_group_membership" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"role" varchar(50) DEFAULT 'member' NOT NULL,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_user_group" UNIQUE("user_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "user_org_membership" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"role" varchar(50) DEFAULT 'member' NOT NULL,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_user_org" UNIQUE("user_id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" varchar(20) NOT NULL,
	"user_id" uuid,
	"changes" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"object_id" uuid NOT NULL,
	"object_type" varchar(50) NOT NULL,
	"activity_type" varchar(100) NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package" ADD CONSTRAINT "package_owner_org_organization_id_fk" FOREIGN KEY ("owner_org") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package" ADD CONSTRAINT "package_creator_user_id_user_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource" ADD CONSTRAINT "resource_package_id_package_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."package"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_tag" ADD CONSTRAINT "package_tag_package_id_package_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."package"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_tag" ADD CONSTRAINT "package_tag_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_vocabulary_id_vocabulary_id_fk" FOREIGN KEY ("vocabulary_id") REFERENCES "public"."vocabulary"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_group" ADD CONSTRAINT "package_group_package_id_package_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."package"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_group" ADD CONSTRAINT "package_group_group_id_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_group_membership" ADD CONSTRAINT "user_group_membership_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_group_membership" ADD CONSTRAINT "user_group_membership_group_id_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_org_membership" ADD CONSTRAINT "user_org_membership_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_org_membership" ADD CONSTRAINT "user_org_membership_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_organization_name" ON "organization" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_organization_state" ON "organization" USING btree ("state");--> statement-breakpoint
CREATE INDEX "idx_group_name" ON "group" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_group_state" ON "group" USING btree ("state");--> statement-breakpoint
CREATE INDEX "idx_user_email" ON "user" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_user_name" ON "user" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_user_state" ON "user" USING btree ("state");--> statement-breakpoint
CREATE INDEX "idx_package_name" ON "package" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_package_owner_org" ON "package" USING btree ("owner_org");--> statement-breakpoint
CREATE INDEX "idx_package_state" ON "package" USING btree ("state");--> statement-breakpoint
CREATE INDEX "idx_resource_package" ON "resource" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "idx_resource_format" ON "resource" USING btree ("format");--> statement-breakpoint
CREATE INDEX "idx_resource_ingest_status" ON "resource" USING btree ("ingest_status");--> statement-breakpoint
CREATE INDEX "idx_audit_entity" ON "audit_log" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_activity_object" ON "activity" USING btree ("object_type","object_id","created_at");