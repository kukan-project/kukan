ALTER TABLE "resource_version" ADD COLUMN "format" varchar(100);
-- Existing rows are left null on purpose. Copying the resource's current label
-- onto them would claim every version in the history was read under it, which
-- nothing establishes: the label is editable, and a version's stored schema was
-- produced under whatever it said at the time. Null says "not known", and the
-- capture gate treats it as a difference, so the next run settles those bytes
-- under a format of their own rather than inheriting an assumption.
