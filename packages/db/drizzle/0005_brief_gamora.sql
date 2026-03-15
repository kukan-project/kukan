ALTER TABLE "package" RENAME COLUMN "metadata_created" TO "created";--> statement-breakpoint
ALTER TABLE "package" RENAME COLUMN "metadata_modified" TO "updated";--> statement-breakpoint
CREATE INDEX "idx_api_token_token_hash" ON "api_token" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_api_token_user_id" ON "api_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_package_creator_user_id" ON "package" USING btree ("creator_user_id");--> statement-breakpoint
CREATE INDEX "idx_package_tag_package_id" ON "package_tag" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "idx_tag_name" ON "tag" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_package_group_package_id" ON "package_group" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "idx_user_group_membership_user_id" ON "user_group_membership" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_org_membership_user_id" ON "user_org_membership" USING btree ("user_id");