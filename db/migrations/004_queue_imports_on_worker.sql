-- =============================================================================
-- Run imports on the Worker instead of inside the web request.
-- =============================================================================
-- The web process used to unpack an upload in the background of the request
-- that created it (`void importZip(...)`). The HTTP response was already sent,
-- so nothing owned the work: a deploy or a restart killed it mid-way and the
-- batch sat at 'processing' forever, with no way to tell a live import from a
-- dead one.
--
-- `import_batches` already had a 'pending' status and the Worker already had a
-- `for update skip locked` claim loop, so an import is now just another queued
-- job. Two columns make that work:
--
--   source_object  the archive's key in the bucket. The Worker reads the zip
--                  from there with ranged GETs, so the job is a pointer, not a
--                  payload, and a failed import can be retried against the
--                  same object rather than re-uploaded.
--
--   heartbeat_at   bumped as the import advances. A 'processing' batch whose
--                  heartbeat went quiet lost its Worker, and only then is it
--                  failed — which is what lets several Workers share the queue
--                  without one of them declaring another's live import dead.
-- =============================================================================

alter table import_batches
  add column if not exists source_object text,
  add column if not exists heartbeat_at  timestamptz;

-- The claim scans for queued work; keep it off a sequential scan as batches pile up.
create index if not exists import_batches_queue_idx
  on import_batches (status, created_at)
  where status in ('pending', 'processing');

-- Batches created before this migration ran in the web process and are done;
-- give the live ones a heartbeat so the stale sweep does not fail them all.
update import_batches set heartbeat_at = now()
where status = 'processing' and heartbeat_at is null;
