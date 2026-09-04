-- Contract phase: drops the shims that kept this table usable by 1.6 processes (see docs/specs/*/phase4-deploy.md).
ALTER TABLE "account" ALTER COLUMN "issuer" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "expiresAt";
