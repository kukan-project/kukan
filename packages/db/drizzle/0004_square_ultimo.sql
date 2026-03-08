CREATE INDEX "idx_package_group_group_id" ON "package_group" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "idx_user_group_membership_group_id" ON "user_group_membership" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "idx_user_org_membership_org_id" ON "user_org_membership" USING btree ("organization_id");