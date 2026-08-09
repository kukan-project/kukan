-- At most one version of a resource may be being purged at a time. A live purge
-- restores the pointer onto the newest version left standing, moves layer 2 onto
-- the same one, and asks for the derivatives to be rebuilt from it — all naming a
-- version another purge could be taking away underneath them.
CREATE UNIQUE INDEX "idx_resource_version_one_purging" ON "resource_version" USING btree ("resource_id") WHERE "resource_version"."state" = 'purging';
