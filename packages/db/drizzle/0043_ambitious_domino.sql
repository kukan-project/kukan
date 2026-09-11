-- Better Auth 1.7.3 keys accounts on (providerId, accountId) again and no
-- longer writes `issuer`, so its NOT NULL refuses every insert. Dropped rather
-- than left with a default: nothing reads it — not the core, not the OAuth
-- plugins, whose issuer is provider configuration — so a value kept here would
-- be one nobody could explain. An image from 1.7.0-1.7.2 cannot authenticate
-- against this; see the contract section in docs/specs/*/phase4-deploy.md.
-- The index goes first: MySQL would otherwise rebuild it on accountId alone.
DROP INDEX "account_issuer_accountId_uidx";--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "issuer";
