CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"provider" varchar(20) NOT NULL,
	"model" varchar(200) NOT NULL,
	"purpose" varchar(40) NOT NULL,
	"resource_id" uuid,
	"calls" integer DEFAULT 1 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric(20, 10) DEFAULT 0 NOT NULL,
	"unpriced_calls" integer DEFAULT 0 NOT NULL,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_ai_usage_occurred_at" ON "ai_usage" USING btree ("occurred_at");