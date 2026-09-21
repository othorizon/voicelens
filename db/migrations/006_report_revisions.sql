-- =============================================================================
-- Keep the report's source, so a report can be revised instead of replaced.
-- =============================================================================
-- Until now a finished report was stored only as the composed document:
-- `analysis_tasks.report_html` / `task_reports.html`, which is the model's page
-- with the CSP, the VL runtime and the entire payload injected into its head.
-- That is the right thing to serve and the wrong thing to edit. Handing it back
-- to a model means paying for the whole dataset as prompt tokens and inviting it
-- to rewrite the injected runtime, and the page it wrote is not separable from
-- it afterwards with any confidence.
--
-- So the page is kept as the model wrote it, and a report becomes a chain:
--
--   page       the document before injection — what a revision starts from.
--   feedback   the note that asked for this version. Empty on a fresh one.
--   parent_id  the version this one was derived from.
--   engine     'page' (AI-designed) or 'spec' (the block renderer's fallback).
--   validation the browser's verdict, so the operator can see why a version
--              was accepted without re-rendering it.
--
-- Screenshots are deliberately NOT stored. They are derived from the page and
-- the payload, both of which are here, so a revision re-renders and re-shoots
-- in about two seconds — cheaper than carrying megabytes of JPEG per version
-- through backups forever.
--
-- `analysis_tasks.report_request` is how a revision is asked for. The report
-- rerun path already works by parking the task at `status = 'report_pending'`
-- for the Worker to claim, with nothing else to say; a revision needs to carry
-- the note and the version it applies to, and this is where it rides. The
-- Worker clears it when the job is done, so a leftover request can never be
-- silently reapplied to a later rerun.
-- =============================================================================

/* ------------------------------------------------------------ task reports */

alter table task_reports add column if not exists page       text;
alter table task_reports add column if not exists feedback   text not null default '';
alter table task_reports add column if not exists parent_id  uuid references task_reports (id) on delete set null;
alter table task_reports add column if not exists engine     text;
alter table task_reports add column if not exists validation jsonb not null default '{}'::jsonb;

-- A version number per task, so the UI can say v3 rather than a timestamp.
-- Ordered by creation, which is the order they were produced in.
alter table task_reports add column if not exists version integer;

create index if not exists idx_reports_task_version on task_reports (task_id, version desc);

-- Existing rows predate the column and have no page to revise; numbering them
-- still lets the history read correctly from whenever this migration landed.
with numbered as (
  select id, row_number() over (partition by task_id order by created_at, id) as n
  from task_reports
  where version is null
)
update task_reports r set version = numbered.n
from numbered where numbered.id = r.id;

-- The number is computed as max + 1 inside the insert, which under READ
-- COMMITTED does not stop two concurrent inserts from reading the same max.
-- In practice a task is claimed by one Worker at a time so it cannot happen,
-- but "cannot happen" is what a constraint is for: the loser gets a unique
-- violation and its job fails loudly instead of producing two v4s.
do $$
begin
  alter table task_reports add constraint task_reports_task_version_key unique (task_id, version);
exception
  when duplicate_table then null;   -- the constraint's index already exists
  when duplicate_object then null;  -- the constraint already exists
end $$;

/* ------------------------------------------------------------ the request */

-- { kind: 'regenerate' | 'revise', feedback, baseReportId, requestedBy }
alter table analysis_tasks add column if not exists report_request jsonb;

/* --------------------------------------------------------------- previews */

-- The preview side of the same thing. A preview already versions by row — a
-- report-only rerun inserts a new one and points at its source through
-- `params.sourcePreviewId` — so it needs no parent column, only the page to
-- revise and the note that asked for it.
alter table template_previews add column if not exists page            text;
alter table template_previews add column if not exists report_feedback text not null default '';
