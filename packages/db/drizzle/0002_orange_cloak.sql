-- Change account.id and session.id from uuid to text
ALTER TABLE "account" ALTER COLUMN "id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "id" DROP DEFAULT;
