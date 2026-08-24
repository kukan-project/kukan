ALTER TABLE "account" ADD COLUMN "issuer" text;--> statement-breakpoint
-- Better Auth 1.7 account-identity backfill: every existing account is a
-- credential account, whose synthetic issuer is 'local:credential'. Rows with
-- any other providerId are left NULL so SET NOT NULL fails loudly instead of
-- guessing an issuer. The default is a transition shim for pre-1.7 processes
-- inserting accounts during a rolling deploy; the contract release drops it.
UPDATE "account" SET "issuer" = 'local:credential' WHERE "providerId" = 'credential';--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "issuer" SET DEFAULT 'local:credential';--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "accessTokenExpiresAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "refreshTokenExpiresAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "scope" text;--> statement-breakpoint
CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" USING btree ("issuer","accountId");--> statement-breakpoint
CREATE INDEX "idx_account_userId" ON "account" USING btree ("userId");