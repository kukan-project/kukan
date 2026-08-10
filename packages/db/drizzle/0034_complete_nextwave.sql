--> One version per object, since a purge destroys the bytes its version names (ADR-046 §3).
CREATE UNIQUE INDEX "idx_resource_version_owns_object" ON "resource_version" USING btree ("storage_key") WHERE "resource_version"."state" <> 'purged';
