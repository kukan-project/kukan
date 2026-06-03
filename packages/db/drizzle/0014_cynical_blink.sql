CREATE TABLE "announcement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"category" varchar(20) DEFAULT 'info' NOT NULL,
	"link" text,
	"published_at" timestamp with time zone,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_announcement_published_at" ON "announcement" USING btree ("published_at");