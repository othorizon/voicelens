-- VoiceLens initial schema.
--
-- Replaces the former Supabase-managed database: `users` takes over from
-- auth.users, and the seven helper functions are the ones the application
-- calls directly (they used to be Supabase RPCs).
--
-- Authorization is enforced in the application, not by row-level security:
-- every signed-in member shares one workspace and sees all of its data, which
-- is the behaviour the app had under its previous `authenticated`-only
-- policies.

create extension if not exists "pgcrypto";

/* ------------------------------------------------------------------ members */

create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text        not null,
  password_hash text        not null,
  display_name  text,
  avatar_color  text        not null default '#6366f1',
  role          text        not null default 'member',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Case-insensitive uniqueness without requiring the citext extension.
create unique index users_email_key on users (lower(email));

-- Everything that joins a row to its author reads this view, so a credential
-- column can never be selected by accident.
create view profiles as
  select id, email, display_name, avatar_color, role, created_at, updated_at
  from users;

/* -------------------------------------------------------------- data sources */

create table data_sources (
  id           uuid primary key default gen_random_uuid(),
  name         text        not null,
  description  text        not null default '',
  extra_schema jsonb       not null default '[]'::jsonb,
  status       text        not null default 'active',
  created_by   uuid        references users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index data_sources_created_at_idx on data_sources (created_at desc);

create table import_batches (
  id               uuid primary key default gen_random_uuid(),
  data_source_id   uuid        not null references data_sources (id) on delete cascade,
  file_name        text        not null default '',
  status           text        not null default 'processing',
  total_entries    integer     not null default 0,
  created_sessions integer     not null default 0,
  created_messages integer     not null default 0,
  uploaded_audios  integer     not null default 0,
  failed_audios    integer     not null default 0,
  skipped          integer     not null default 0,
  error            text,
  progress_detail  jsonb       not null default '{}'::jsonb,
  created_by       uuid        references users (id) on delete set null,
  created_at       timestamptz not null default now(),
  finished_at      timestamptz
);

create index import_batches_source_idx on import_batches (data_source_id, created_at desc);

/* ------------------------------------------------------- sessions & messages */

create table sessions (
  id                    uuid primary key default gen_random_uuid(),
  data_source_id        uuid        not null references data_sources (id) on delete cascade,
  session_key           text        not null,
  user_key              text        not null,
  started_at            timestamptz,
  ended_at              timestamptz,
  turn_count            integer     not null default 0,
  human_turn_count      integer     not null default 0,
  ai_turn_count         integer     not null default 0,
  audio_count           integer     not null default 0,
  char_count            integer     not null default 0,
  extra                 jsonb       not null default '{}'::jsonb,
  digest                text,
  last_import_batch_id  uuid        references import_batches (id) on delete set null,
  created_at            timestamptz not null default now()
);

-- Re-importing the same sessionId appends to the existing session, so the
-- (source, key) pair has to be unique for the lookup to be well defined.
create unique index sessions_source_key_uniq on sessions (data_source_id, session_key);
create index sessions_source_started_idx on sessions (data_source_id, started_at desc nulls last);
create index sessions_user_key_idx on sessions (data_source_id, user_key);
create index sessions_extra_idx on sessions using gin (extra);

create table messages (
  id              uuid primary key default gen_random_uuid(),
  data_source_id  uuid        not null references data_sources (id) on delete cascade,
  session_id      uuid        not null references sessions (id) on delete cascade,
  seq             integer     not null default 0,
  role            text        not null default 'user',
  content         jsonb,
  content_text    text        not null default '',
  occurred_at     timestamptz,
  audio_path      text,
  audio_format    text,
  audio_size      bigint,
  extra           jsonb       not null default '{}'::jsonb,
  import_batch_id uuid        references import_batches (id) on delete set null,
  created_at      timestamptz not null default now()
);

create index messages_session_seq_idx on messages (session_id, seq);
create index messages_source_idx on messages (data_source_id);
create index messages_batch_idx on messages (import_batch_id);
create index messages_extra_idx on messages using gin (extra);
-- Serves loadSessionAudio, which only ever wants rows that carry audio.
create index messages_audio_idx on messages (session_id, seq) where audio_path is not null;

/* -------------------------------------------------------- workflows & plans */

create table workflows (
  id             uuid primary key default gen_random_uuid(),
  data_source_id uuid        not null references data_sources (id) on delete cascade,
  name           text        not null default '',
  graph          jsonb       not null default '{}'::jsonb,
  config         jsonb       not null default '{}'::jsonb,
  is_active      boolean     not null default true,
  created_by     uuid        references users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index workflows_source_idx on workflows (data_source_id, updated_at desc);

create table analysis_templates (
  id                uuid primary key default gen_random_uuid(),
  data_source_id    uuid        not null references data_sources (id) on delete cascade,
  workflow_id       uuid        references workflows (id) on delete set null,
  version           integer     not null default 1,
  status            text        not null default 'draft',
  parent_id         uuid        references analysis_templates (id) on delete set null,
  session_prompt    text        not null default '',
  user_prompt       text        not null default '',
  global_prompt     text        not null default '',
  report_prompt     text        not null default '',
  metric_schema     jsonb       not null default '{}'::jsonb,
  samples           jsonb       not null default '{}'::jsonb,
  extra_schema      jsonb       not null default '[]'::jsonb,
  business_desc     text        not null default '',
  rationale         text        not null default '',
  feedback          text,
  created_by        uuid        references users (id) on delete set null,
  created_at        timestamptz not null default now()
);

create unique index analysis_templates_version_uniq on analysis_templates (data_source_id, version);
create index analysis_templates_source_idx on analysis_templates (data_source_id, version desc);

create table planning_jobs (
  id                 uuid primary key default gen_random_uuid(),
  data_source_id     uuid        not null references data_sources (id) on delete cascade,
  workflow_id        uuid        references workflows (id) on delete set null,
  kind               text        not null default 'plan',
  status             text        not null default 'pending',
  params             jsonb       not null default '{}'::jsonb,
  focus              text,
  feedback           text,
  progress           jsonb       not null default '{}'::jsonb,
  error              text,
  template_id        uuid        references analysis_templates (id) on delete set null,
  parent_template_id uuid        references analysis_templates (id) on delete set null,
  created_by         uuid        references users (id) on delete set null,
  created_at         timestamptz not null default now(),
  started_at         timestamptz,
  finished_at        timestamptz
);

-- The worker claims the oldest pending job, so it scans on (status, created_at).
create index planning_jobs_claim_idx on planning_jobs (status, created_at);
create index planning_jobs_source_idx on planning_jobs (data_source_id, created_at desc);

create table template_previews (
  id              uuid primary key default gen_random_uuid(),
  data_source_id  uuid        not null references data_sources (id) on delete cascade,
  template_id     uuid        references analysis_templates (id) on delete cascade,
  status          text        not null default 'pending',
  params          jsonb       not null default '{}'::jsonb,
  progress        jsonb       not null default '{}'::jsonb,
  sessions        integer     not null default 0,
  concurrency     integer     not null default 2,
  session_results jsonb       not null default '[]'::jsonb,
  user_results    jsonb       not null default '[]'::jsonb,
  global_result   jsonb,
  report          jsonb,
  html            text,
  stats           jsonb       not null default '{}'::jsonb,
  error           text,
  created_by      uuid        references users (id) on delete set null,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz
);

create index template_previews_claim_idx on template_previews (status, created_at);
create index template_previews_source_idx on template_previews (data_source_id, created_at desc);

/* ------------------------------------------------------------------- tasks */

create table analysis_tasks (
  id             uuid primary key default gen_random_uuid(),
  data_source_id uuid        not null references data_sources (id) on delete cascade,
  template_id    uuid        references analysis_templates (id) on delete set null,
  workflow_id    uuid        references workflows (id) on delete set null,
  name           text        not null default '',
  scope_type     text        not null default 'incremental',
  range_start    timestamptz,
  range_end      timestamptz,
  status         text        not null default 'pending',
  stage          text        not null default 'queued',
  config         jsonb       not null default '{}'::jsonb,
  progress       jsonb       not null default '{}'::jsonb,
  stats          jsonb       not null default '{}'::jsonb,
  report         jsonb,
  report_html    text,
  error          text,
  created_by     uuid        references users (id) on delete set null,
  created_at     timestamptz not null default now(),
  started_at     timestamptz,
  finished_at    timestamptz,
  heartbeat_at   timestamptz
);

create index analysis_tasks_claim_idx on analysis_tasks (status, created_at);
create index analysis_tasks_source_idx on analysis_tasks (data_source_id, created_at desc);
create index analysis_tasks_created_idx on analysis_tasks (created_at desc);

create table task_logs (
  id         bigserial primary key,
  task_id    uuid        not null references analysis_tasks (id) on delete cascade,
  level      text        not null default 'info',
  stage      text,
  message    text        not null default '',
  payload    jsonb,
  created_at timestamptz not null default now()
);

create index task_logs_task_idx on task_logs (task_id, id desc);

create table task_session_results (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid        not null references analysis_tasks (id) on delete cascade,
  session_pk  uuid        not null references sessions (id) on delete cascade,
  session_key text        not null default '',
  user_key    text        not null default '',
  status      text        not null default 'pending',
  result      jsonb,
  error       text,
  tokens      integer     not null default 0,
  duration_ms integer,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Target of the executor's per-chunk upsert.
create unique index task_session_results_uniq on task_session_results (task_id, session_pk);
create index task_session_results_task_idx on task_session_results (task_id, session_key);
create index task_session_results_user_idx on task_session_results (task_id, user_key);
-- unanalyzed_session_ids() probes this from the sessions side.
create index task_session_results_session_idx on task_session_results (session_pk, status);

create table task_user_results (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid        not null references analysis_tasks (id) on delete cascade,
  user_key      text        not null,
  session_count integer     not null default 0,
  status        text        not null default 'pending',
  result        jsonb,
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index task_user_results_uniq on task_user_results (task_id, user_key);
create index task_user_results_task_idx on task_user_results (task_id, session_count desc);

create table task_global_result (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid        not null references analysis_tasks (id) on delete cascade,
  status     text        not null default 'pending',
  result     jsonb,
  error      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index task_global_result_uniq on task_global_result (task_id);

create table task_reports (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid        not null references analysis_tasks (id) on delete cascade,
  kind       text        not null default 'final',
  title      text        not null default '',
  report     jsonb,
  html       text,
  created_by uuid        references users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index task_reports_task_idx on task_reports (task_id, created_at desc);

/* --------------------------------------------------------------- functions */

-- Header counters for a data source.
create or replace function source_overview(p_data_source_id uuid)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'sessions',   (select count(*) from sessions where data_source_id = p_data_source_id),
    'users',      (select count(distinct user_key) from sessions where data_source_id = p_data_source_id),
    'messages',   (select count(*) from messages where data_source_id = p_data_source_id),
    'audios',     (select count(*) from messages where data_source_id = p_data_source_id and audio_path is not null),
    'first_seen', (select min(started_at) from sessions where data_source_id = p_data_source_id),
    'last_seen',  (select max(started_at) from sessions where data_source_id = p_data_source_id)
  );
$$;

-- Shared body behind the two histogram entry points. Exactly one of
-- p_data_source_id / p_session_ids is expected to be non-null.
--
-- A key whose values are >80% numbers is summarised statistically; anything
-- else is reported as a top-N value count. The five Chinese bucket names are
-- load-bearing: inferSchemaFromData() detects a numeric field by looking for
-- them.
create or replace function extra_histogram_core(
  p_data_source_id uuid,
  p_session_ids    uuid[],
  p_max_values     integer
)
returns jsonb
language sql
stable
as $$
  with raw as (
    select e.key, e.value
    from messages m
    cross join lateral jsonb_each(coalesce(m.extra, '{}'::jsonb)) as e(key, value)
    where (p_session_ids is null and m.data_source_id = p_data_source_id)
       or (p_session_ids is not null and m.session_id = any (p_session_ids))
    union all
    select e.key, e.value
    from sessions s
    cross join lateral jsonb_each(coalesce(s.extra, '{}'::jsonb)) as e(key, value)
    where (p_session_ids is null and s.data_source_id = p_data_source_id)
       or (p_session_ids is not null and s.id = any (p_session_ids))
  ),
  present as (
    select key, value from raw where jsonb_typeof(value) not in ('null', 'object', 'array')
  ),
  kinds as (
    select key,
           count(*) as n_all,
           count(*) filter (where jsonb_typeof(value) = 'number') as n_num
    from present
    group by key
  ),
  numeric_keys as (
    select key from kinds where n_all > 0 and n_num::numeric / n_all > 0.8
  ),
  numeric_stats as (
    select p.key,
           jsonb_build_array(
             jsonb_build_object('name', '样本数', 'value', count(*)),
             jsonb_build_object('name', '均值',   'value', round(avg((p.value #>> '{}')::numeric), 2)),
             jsonb_build_object('name', '中位数', 'value',
               round((percentile_cont(0.5) within group (order by (p.value #>> '{}')::numeric))::numeric, 2)),
             jsonb_build_object('name', 'P90',    'value',
               round((percentile_cont(0.9) within group (order by (p.value #>> '{}')::numeric))::numeric, 2)),
             jsonb_build_object('name', '最大值', 'value', round(max((p.value #>> '{}')::numeric), 2))
           ) as values
    from present p
    join numeric_keys n using (key)
    where jsonb_typeof(p.value) = 'number'
    group by p.key
  ),
  cat_counts as (
    select p.key, p.value #>> '{}' as name, count(*) as value
    from present p
    where p.key not in (select key from numeric_keys)
    group by 1, 2
  ),
  cat_ranked as (
    select key, name, value,
           row_number() over (partition by key order by value desc, name) as rn
    from cat_counts
  ),
  cat_stats as (
    select key,
           jsonb_agg(jsonb_build_object('name', name, 'value', value) order by value desc, name) as values
    from cat_ranked
    where rn <= greatest(coalesce(p_max_values, 20), 1)
    group by key
  )
  select coalesce(
    (select jsonb_agg(jsonb_build_object('key', key, 'values', values) order by key)
     from (select key, values from numeric_stats
           union all
           select key, values from cat_stats) merged),
    '[]'::jsonb
  );
$$;

create or replace function extra_histogram(p_data_source_id uuid, p_max_values integer default 20)
returns jsonb
language sql
stable
as $$
  select extra_histogram_core(p_data_source_id, null::uuid[], p_max_values);
$$;

create or replace function extra_histogram_for_sessions(p_session_ids uuid[], p_max_values integer default 16)
returns jsonb
language sql
stable
as $$
  select extra_histogram_core(null::uuid, coalesce(p_session_ids, '{}'::uuid[]), p_max_values);
$$;

-- Sessions never successfully analysed by a completed task: the incremental
-- scope.
create or replace function unanalyzed_session_ids(p_data_source_id uuid, p_limit integer default 100000)
returns table (id uuid)
language sql
stable
as $$
  select s.id
  from sessions s
  where s.data_source_id = p_data_source_id
    and not exists (
      select 1
      from task_session_results r
      join analysis_tasks t on t.id = r.task_id
      where r.session_pk = s.id
        and r.status = 'success'
        and t.status = 'completed'
    )
  order by s.started_at nulls last, s.session_key
  limit greatest(coalesce(p_limit, 100000), 1);
$$;

-- Session-layer rollup computed in Postgres rather than by the model, so the
-- report has a ground truth to be checked against.
create or replace function task_session_stats(
  p_task_id  uuid,
  p_scope    text default 'all',
  p_user_key text default null
)
returns jsonb
language sql
stable
as $$
  with rows_ as (
    select r.result
    from task_session_results r
    where r.task_id = p_task_id
      and r.status = 'success'
      and r.result is not null
      and (p_user_key is null or r.user_key = p_user_key)
  ),
  quality as (
    select (result ->> 'quality_score')::numeric as q
    from rows_
    where jsonb_typeof(result -> 'quality_score') = 'number'
  ),
  dist as (
    select field, value, count(*) as n
    from rows_,
         lateral (values ('outcome'), ('sentiment'), ('risk_level'), ('intent')) as f(field),
         lateral (select nullif(trim(result ->> f.field), '') as value) v
    where v.value is not null
    group by field, value
  ),
  dist_ranked as (
    select field, value, n, row_number() over (partition by field order by n desc, value) as rn
    from dist
  ),
  arrays as (
    select field, value, count(*) as n
    from rows_,
         lateral (values ('tags'), ('problems')) as f(field),
         lateral jsonb_array_elements_text(
           case when jsonb_typeof(result -> f.field) = 'array' then result -> f.field else '[]'::jsonb end
         ) as value
    where nullif(trim(value), '') is not null
    group by field, value
  ),
  arrays_ranked as (
    select field, value, n, row_number() over (partition by field order by n desc, value) as rn
    from arrays
  ),
  metrics as (
    select m ->> 'key' as key,
           max(m ->> 'label') as label,
           max(m ->> 'unit') as unit,
           round(avg((m ->> 'value')::numeric), 2) as avg
    from rows_,
         lateral jsonb_array_elements(
           case when jsonb_typeof(result -> 'metrics') = 'array' then result -> 'metrics' else '[]'::jsonb end
         ) as m
    where jsonb_typeof(m -> 'value') = 'number'
      and nullif(m ->> 'key', '') is not null
    group by m ->> 'key'
  ),
  buckets as (
    select b.name, count(q.q) as value
    from (values ('0-2', 0, 2), ('2-4', 2, 4), ('4-6', 4, 6), ('6-8', 6, 8), ('8-10', 8, 10.0001)) as b(name, lo, hi)
    left join quality q on q.q >= b.lo and q.q < b.hi
    group by b.name, b.lo
    order by b.lo
  )
  select jsonb_build_object(
    'session_count', (select count(*) from rows_),
    'avg_quality',   (select round(avg(q), 1) from quality),
    'risky_ratio',   coalesce((
      select round(100.0 * count(*) filter (where result ->> 'risk_level' in ('medium', 'high')) / nullif(count(*), 0), 1)
      from rows_
    ), 0),
    'quality_buckets', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'value', value)) from buckets), '[]'::jsonb),
    'metrics', coalesce((
      select jsonb_agg(jsonb_build_object('key', key, 'label', coalesce(label, key), 'avg', avg, 'unit', coalesce(unit, ''))
                       order by key)
      from metrics
    ), '[]'::jsonb),
    'distributions', jsonb_build_object(
      'outcome',    coalesce((select jsonb_agg(jsonb_build_object('name', value, 'value', n) order by n desc, value) from dist_ranked where field = 'outcome' and rn <= 16), '[]'::jsonb),
      'sentiment',  coalesce((select jsonb_agg(jsonb_build_object('name', value, 'value', n) order by n desc, value) from dist_ranked where field = 'sentiment' and rn <= 16), '[]'::jsonb),
      'risk_level', coalesce((select jsonb_agg(jsonb_build_object('name', value, 'value', n) order by n desc, value) from dist_ranked where field = 'risk_level' and rn <= 16), '[]'::jsonb),
      'intent',     coalesce((select jsonb_agg(jsonb_build_object('name', value, 'value', n) order by n desc, value) from dist_ranked where field = 'intent' and rn <= 16), '[]'::jsonb),
      'tags',       coalesce((select jsonb_agg(jsonb_build_object('name', value, 'value', n) order by n desc, value) from arrays_ranked where field = 'tags' and rn <= 20), '[]'::jsonb),
      'problems',   coalesce((select jsonb_agg(jsonb_build_object('name', value, 'value', n) order by n desc, value) from arrays_ranked where field = 'problems' and rn <= 20), '[]'::jsonb)
    ),
    'scope', coalesce(p_scope, 'all')
  );
$$;

-- User-layer rollup, same idea one level up.
create or replace function task_user_stats(p_task_id uuid)
returns jsonb
language sql
stable
as $$
  with rows_ as (
    select r.result
    from task_user_results r
    where r.task_id = p_task_id
      and r.status in ('success', 'degraded')
      and r.result is not null
  ),
  arrays as (
    select field, value, count(*) as n
    from rows_,
         lateral (values ('needs'), ('tags')) as f(field),
         lateral jsonb_array_elements_text(
           case when jsonb_typeof(result -> f.field) = 'array' then result -> f.field else '[]'::jsonb end
         ) as value
    where nullif(trim(value), '') is not null
    group by field, value
  ),
  arrays_ranked as (
    select field, value, n, row_number() over (partition by field order by n desc, value) as rn
    from arrays
  ),
  metrics as (
    select m ->> 'key' as key,
           max(m ->> 'label') as label,
           max(m ->> 'unit') as unit,
           round(avg((m ->> 'value')::numeric), 2) as avg
    from rows_,
         lateral jsonb_array_elements(
           case when jsonb_typeof(result -> 'metrics') = 'array' then result -> 'metrics' else '[]'::jsonb end
         ) as m
    where jsonb_typeof(m -> 'value') = 'number'
      and nullif(m ->> 'key', '') is not null
    group by m ->> 'key'
  )
  select jsonb_build_object(
    'user_count', (select count(*) from rows_),
    'risk_count', (select count(*) from rows_ where result ->> 'risk_level' in ('medium', 'high')),
    'top_needs',  coalesce((select jsonb_agg(jsonb_build_object('name', value, 'value', n) order by n desc, value) from arrays_ranked where field = 'needs' and rn <= 20), '[]'::jsonb),
    'top_tags',   coalesce((select jsonb_agg(jsonb_build_object('name', value, 'value', n) order by n desc, value) from arrays_ranked where field = 'tags' and rn <= 20), '[]'::jsonb),
    'metrics',    coalesce((
      select jsonb_agg(jsonb_build_object('key', key, 'label', coalesce(label, key), 'avg', avg, 'unit', coalesce(unit, ''))
                       order by key)
      from metrics
    ), '[]'::jsonb)
  );
$$;

-- Drop one import batch: its messages, then any session left with no messages
-- at all, then the batch row itself.
create or replace function delete_import_batch(p_batch_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_messages bigint := 0;
  v_sessions bigint := 0;
begin
  with gone as (
    delete from messages where import_batch_id = p_batch_id returning 1
  )
  select count(*) into v_messages from gone;

  with gone as (
    delete from sessions s
    where s.last_import_batch_id = p_batch_id
      and not exists (select 1 from messages m where m.session_id = s.id)
    returning 1
  )
  select count(*) into v_sessions from gone;

  delete from import_batches where id = p_batch_id;

  return jsonb_build_object('deleted_messages', v_messages, 'deleted_sessions', v_sessions);
end;
$$;
