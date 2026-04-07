CREATE TABLE "fetch_rate_limit" (
	"fqdn" varchar(255) PRIMARY KEY NOT NULL,
	"last_fetched_at" timestamp with time zone NOT NULL
);
