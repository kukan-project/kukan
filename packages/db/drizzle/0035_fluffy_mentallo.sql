ALTER TABLE "resource" ADD COLUMN "health_check_state" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
-- Carried rather than dropped: absent `lastFullFetchAt` reads as overdue, so starting
-- empty would re-fetch the body of every header-less external URL in one tick.
UPDATE "resource" SET
  "health_check_state" = COALESCE((
    SELECT jsonb_object_agg(m.to_key, "extras" -> m.from_key)
      FROM (VALUES
        ('healthEtag', 'etag'),
        ('healthLastModified', 'lastModified'),
        ('healthError', 'error'),
        ('healthHttpStatus', 'httpStatus'),
        ('healthLastFullFetchAt', 'lastFullFetchAt')
      ) AS m(from_key, to_key)
     WHERE "extras" ? m.from_key
  ), '{}'::jsonb),
  "extras" = "extras" - ARRAY['healthEtag', 'healthLastModified', 'healthError',
                              'healthHttpStatus', 'healthLastFullFetchAt']::text[]
WHERE "extras" ?| ARRAY['healthEtag', 'healthLastModified', 'healthError',
                        'healthHttpStatus', 'healthLastFullFetchAt'];
