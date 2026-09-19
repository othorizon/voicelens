-- =============================================================================
-- VoiceLens initial schema.
-- =============================================================================
-- Ported from the project's original Supabase (PostgreSQL 17) schema, with the
-- Supabase-specific layers replaced:
--
--   * `auth.users` + the `register_user` RPC  ->  a plain `users` table, with
--     authentication handled in the application (argon2id + signed cookie).
--   * RLS policies + `anon`/`authenticated` grants  ->  nothing. There is no
--     PostgREST in front of the database any more, so the connection is trusted
--     and authorization lives in the app. The policies were `using (true)` for
--     every authenticated member anyway, which is the behaviour the app keeps:
--     one shared team workspace, `created_by` for attribution, no row-level
--     ownership.
--   * The `audio` storage bucket + its policy  ->  an S3-compatible private
--     bucket, configured through S3_* environment variables.
--
-- Everything else — all 15 tables, their constraints, the 7 analytics
-- functions, the updated_at triggers — matches the original.
-- =============================================================================

create extension if not exists "pgcrypto";

/* ------------------------------------------------------------------ members */

-- Replaces auth.users. `profiles` below is the view the rest of the schema and
-- the application join against.
create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text        not null,
  password_hash text        not null,
  display_name  text,
  avatar_color  text,
  role          text        not null default 'member',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Case-insensitive uniqueness without requiring the citext extension.
create unique index users_email_key on users (lower(email));

-- Every author join reads this view, so a credential column can never be
-- selected by accident.
create view profiles as
  select id, email, display_name, avatar_color, role, created_at
  from users;

/* -------------------------------------------------------------- data sources */

-- description  = 业务描述提示词，会进入 AI 规划与报告生成
-- extra_schema = extra 字段的手工 schema 配置
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

-- 一次 zip 上传 = 一个批次，支持多次多批追加
create table import_batches (
  id               uuid primary key default gen_random_uuid(),
  data_source_id   uuid        not null references data_sources (id) on delete cascade,
  file_name        text,
  origin           text        not null default 'upload',
  status           text        not null default 'pending',  -- pending|processing|completed|failed
  total_entries    integer     not null default 0,
  created_sessions integer     not null default 0,
  created_messages integer     not null default 0,
  uploaded_audios  integer     not null default 0,
  failed_audios    integer     not null default 0,
  skipped          integer     not null default 0,
  error            text,
  notes            text,
  progress_detail  jsonb       not null default '{}'::jsonb,
  created_by       uuid        references users (id) on delete set null,
  created_at       timestamptz not null default now(),
  finished_at      timestamptz
);

/* ------------------------------------------------------- sessions & messages */

-- 三层分层的第二层
-- digest = 供上层分析使用的紧凑转录文本；多批导入时按顺序拼接
create table sessions (
  id                   uuid primary key default gen_random_uuid(),
  data_source_id       uuid        not null references data_sources (id) on delete cascade,
  session_key          text        not null,                     -- 原始 sessionId
  user_key             text        not null default 'anonymous', -- 原始 userId
  started_at           timestamptz,
  ended_at             timestamptz,
  turn_count           integer     not null default 0,
  human_turn_count     integer     not null default 0,
  ai_turn_count        integer     not null default 0,
  audio_count          integer     not null default 0,
  char_count           integer     not null default 0,
  extra                jsonb       not null default '{}'::jsonb,
  digest               text,
  last_import_batch_id uuid        references import_batches (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (data_source_id, session_key)                           -- 多批导入按此归并
);

-- 三层分层的第一层
-- content 保留 OpenAI 范式原值（字符串或 content parts 数组），content_text 是抽取出的纯文本
-- audio_path 指向对象存储私有桶中的路径；音频字节不入库
create table messages (
  id                bigint generated always as identity primary key,
  data_source_id    uuid        not null references data_sources (id) on delete cascade,
  session_id        uuid        not null references sessions (id) on delete cascade,
  seq               integer     not null,                    -- 会话内序号，多批导入时续号
  role              text        not null,
  content           jsonb       not null,
  content_text      text        not null default '',
  occurred_at       timestamptz,                             -- 原始 timestamp
  audio_path        text,
  audio_format      text,
  audio_size        bigint,
  audio_duration_ms integer,
  extra             jsonb       not null default '{}'::jsonb,
  import_batch_id   uuid        references import_batches (id) on delete set null,
  created_at        timestamptz not null default now(),
  unique (session_id, seq)
);

/* -------------------------------------------------------- workflows & plans */

-- graph = React Flow 图，config = 解析后的执行配置
create table workflows (
  id             uuid primary key default gen_random_uuid(),
  data_source_id uuid        not null references data_sources (id) on delete cascade,
  name           text        not null,
  graph          jsonb       not null default '{"nodes":[],"edges":[]}'::jsonb,
  config         jsonb       not null default '{}'::jsonb,
  is_active      boolean     not null default true,
  created_by     uuid        references users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- 规划产出的四段提示词，按 version 版本化
-- status: draft(规划产生) → confirmed(用户确认为执行模板) → archived(被新版本取代)
create table analysis_templates (
  id             uuid primary key default gen_random_uuid(),
  data_source_id uuid        not null references data_sources (id) on delete cascade,
  workflow_id    uuid        references workflows (id) on delete set null,
  version        integer     not null,
  status         text        not null default 'draft',
  session_prompt text        not null default '',           -- 会话层分析提示词
  user_prompt    text        not null default '',           -- 用户层汇总提示词
  global_prompt  text        not null default '',           -- 全局层汇总提示词
  metric_schema  jsonb       not null default '{"session":[],"user":[],"global":[]}'::jsonb,
  report_prompt  text        not null default '',           -- 报告生成提示词
  report_spec    jsonb       not null default '{}'::jsonb,
  business_desc  text        not null default '',           -- 规划时的业务描述快照
  extra_schema   jsonb       not null default '[]'::jsonb,  -- 规划时的 extra schema 快照
  samples        jsonb       not null default '{}'::jsonb,  -- 抽样快照 + 音频试听结论
  rationale      text        not null default '',           -- 模型的规划说明
  feedback       text        not null default '',           -- 触发本版本的修改建议
  parent_id      uuid        references analysis_templates (id) on delete set null,
  created_by     uuid        references users (id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (data_source_id, version)
);

-- 模板 × 抽样数据 → 预览报告，供用户在生成前审阅
-- sessions / useAudio / concurrency 都在 params 里，不是独立列
create table template_previews (
  id              uuid primary key default gen_random_uuid(),
  template_id     uuid        not null references analysis_templates (id) on delete cascade,
  data_source_id  uuid        not null references data_sources (id) on delete cascade,
  status          text        not null default 'pending',   -- pending|running|completed|failed
  progress        jsonb       not null default '{}'::jsonb,
  params          jsonb       not null default '{}'::jsonb,
  session_results jsonb       not null default '[]'::jsonb,
  user_results    jsonb       not null default '[]'::jsonb,
  global_result   jsonb,
  report          jsonb,                                    -- 报告结构化 spec
  html            text,                                     -- 渲染出的单页报告
  feedback        text        not null default '',
  error           text,
  stats           jsonb       not null default '{}'::jsonb,
  created_by      uuid        references users (id) on delete set null,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz
);

-- Worker 消费，产出 analysis_templates 新版本
create table planning_jobs (
  id                 uuid primary key default gen_random_uuid(),
  data_source_id     uuid        not null references data_sources (id) on delete cascade,
  workflow_id        uuid        references workflows (id) on delete set null,
  kind               text        not null default 'create',  -- create|revise
  status             text        not null default 'pending', -- pending|running|completed|failed
  params             jsonb       not null default '{}'::jsonb,
  feedback           text        not null default '',
  parent_template_id uuid        references analysis_templates (id) on delete set null,
  template_id        uuid        references analysis_templates (id) on delete set null,
  progress           jsonb       not null default '{}'::jsonb,
  error              text,
  created_by         uuid        references users (id) on delete set null,
  created_at         timestamptz not null default now(),
  started_at         timestamptz,
  finished_at        timestamptz
);

/* ------------------------------------------------------------------- tasks */

create table analysis_tasks (
  id             uuid primary key default gen_random_uuid(),
  data_source_id uuid        not null references data_sources (id) on delete cascade,
  template_id    uuid        references analysis_templates (id) on delete set null,
  workflow_id    uuid        references workflows (id) on delete set null,
  name           text        not null,
  scope_type     text        not null default 'incremental', -- incremental|range
  range_start    timestamptz,
  range_end      timestamptz,
  status         text        not null default 'pending',     -- pending|running|completed|failed|cancelled
  stage          text        not null default 'queued',      -- collect|session_analysis|user_aggregation|global_aggregation|report_generation|done
  progress       jsonb       not null default '{}'::jsonb,
  config         jsonb       not null default '{}'::jsonb,   -- 工作流解析出的执行配置快照
  stats          jsonb       not null default '{}'::jsonb,   -- 含 tokens / 耗时 / metric_overrides
  report         jsonb,                                      -- 报告结构化 spec
  report_html    text,                                       -- 渲染出的单页报告（自带三层下探）
  error          text,
  created_by     uuid        references users (id) on delete set null,
  created_at     timestamptz not null default now(),
  started_at     timestamptz,
  heartbeat_at   timestamptz,                                -- Worker 心跳，用于孤儿作业回收
  finished_at    timestamptz
);

-- 每个任务 × 每个会话一行。这也是判定「增量未分析」的依据：
-- 只统计 completed 任务里 status=success 的行。
create table task_session_results (
  id          bigint generated always as identity primary key,
  task_id     uuid        not null references analysis_tasks (id) on delete cascade,
  session_pk  uuid        not null references sessions (id) on delete cascade,
  session_key text        not null,
  user_key    text        not null,
  status      text        not null default 'pending',        -- pending|success|failed
  result      jsonb,                                         -- SessionAnalysis
  error       text,
  tokens      integer     not null default 0,
  duration_ms integer     not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (task_id, session_pk)
);

create table task_user_results (
  id            bigint generated always as identity primary key,
  task_id       uuid        not null references analysis_tasks (id) on delete cascade,
  user_key      text        not null,
  session_count integer     not null default 0,
  status        text        not null default 'pending',      -- pending|success|degraded|failed
  result        jsonb,                                       -- UserAnalysis
  error         text,
  tokens        integer     not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (task_id, user_key)
);

create table task_global_result (
  task_id    uuid primary key references analysis_tasks (id) on delete cascade,
  status     text        not null default 'pending',
  result     jsonb,                                          -- GlobalAnalysis
  error      text,
  tokens     integer     not null default 0,
  updated_at timestamptz not null default now()
);

create table task_logs (
  id         bigint generated always as identity primary key,
  task_id    uuid        not null references analysis_tasks (id) on delete cascade,
  ref_kind   text        not null default 'task',
  level      text        not null default 'info',            -- info|warn|error
  stage      text,
  message    text        not null,
  payload    jsonb,
  created_at timestamptz not null default now()
);

create table task_reports (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid        not null references analysis_tasks (id) on delete cascade,
  kind       text        not null default 'final',
  title      text,
  report     jsonb,
  html       text,
  created_by uuid        references users (id) on delete set null,
  created_at timestamptz not null default now()
);

/* ----------------------------------------------------------------- indexes */

create index idx_messages_session     on messages (session_id, seq);
create index idx_messages_ds          on messages (data_source_id);
create index idx_messages_occurred    on messages (data_source_id, occurred_at);
create index idx_sessions_ds_user     on sessions (data_source_id, user_key);
create index idx_sessions_ds_started  on sessions (data_source_id, started_at);
create index idx_batches_ds           on import_batches (data_source_id, created_at desc);
create index idx_previews_template    on template_previews (template_id, created_at desc);
create index idx_planning_jobs_status on planning_jobs (status, created_at);
create index idx_tasks_ds             on analysis_tasks (data_source_id, created_at desc);
create index idx_tasks_status         on analysis_tasks (status, created_at);
create index idx_tsr_task_status      on task_session_results (task_id, status);
create index idx_tsr_task_user        on task_session_results (task_id, user_key);
create index idx_tur_task             on task_user_results (task_id, status);
create index idx_logs_task            on task_logs (task_id, id desc);
create index idx_reports_task         on task_reports (task_id, created_at desc);

-- Added for this port: the previews and previews/tasks queues are claimed by
-- (status, created_at), and unanalyzed_session_ids() probes results by session.
create index idx_previews_status      on template_previews (status, created_at);
create index idx_tsr_session          on task_session_results (session_pk, status);
create index idx_data_sources_created on data_sources (created_at desc);
create index idx_workflows_ds         on workflows (data_source_id, updated_at desc);
create index idx_templates_ds         on analysis_templates (data_source_id, version desc);
create index idx_planning_jobs_ds     on planning_jobs (data_source_id, created_at desc);
create index idx_previews_ds          on template_previews (data_source_id, created_at desc);
create index idx_messages_audio       on messages (session_id, seq) where audio_path is not null;

/* ---------------------------------------------------------------- triggers */

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger trg_users_touch before update on users
  for each row execute function touch_updated_at();
create trigger trg_data_sources_touch before update on data_sources
  for each row execute function touch_updated_at();
create trigger trg_sessions_touch before update on sessions
  for each row execute function touch_updated_at();
create trigger trg_workflows_touch before update on workflows
  for each row execute function touch_updated_at();

/* --------------------------------------------------------------- functions */

-- 撤销一个导入批次：删掉该批次写入的消息、只由该批次产生的会话，再删批次本身
create or replace function delete_import_batch(p_batch_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_ds uuid;
  v_msgs int;
  v_sessions int;
begin
  select data_source_id into v_ds from import_batches where id = p_batch_id;
  if v_ds is null then
    return jsonb_build_object('error', 'batch not found');
  end if;

  delete from messages where import_batch_id = p_batch_id;
  get diagnostics v_msgs = row_count;

  delete from sessions
  where data_source_id = v_ds
    and last_import_batch_id = p_batch_id
    and not exists (select 1 from messages m where m.session_id = sessions.id);
  get diagnostics v_sessions = row_count;

  delete from import_batches where id = p_batch_id;

  return jsonb_build_object('deleted_messages', v_msgs, 'deleted_sessions', v_sessions);
end $$;

-- 增量口径：尚未被任何「已完成任务的 success 会话结果」覆盖的会话
create or replace function unanalyzed_session_ids(p_data_source_id uuid, p_limit int default 500)
returns table (id uuid)
language sql
stable
as $$
  select s.id
  from sessions s
  where s.data_source_id = p_data_source_id
    and not exists (
      select 1 from task_session_results r
      join analysis_tasks t on t.id = r.task_id
      where r.session_pk = s.id and r.status = 'success' and t.status = 'completed'
    )
  order by s.started_at nulls first, s.created_at
  limit greatest(p_limit, 1);
$$;

-- 数据源总览：规模、时间范围、每日会话量、轮次分桶
create or replace function source_overview(p_data_source_id uuid)
returns jsonb
language sql
stable
as $$
with s as (
  select id, user_key, started_at, turn_count from sessions where data_source_id = p_data_source_id
),
m as (
  select audio_path from messages where data_source_id = p_data_source_id
),
daily as (
  select started_at::date as d, count(*)::int as c
  from s where started_at is not null group by 1
),
daily_top as (select d, c from daily order by d desc limit 90),
buckets as (
  select case
           when turn_count <= 4 then '1-4 轮'
           when turn_count <= 10 then '5-10 轮'
           when turn_count <= 20 then '11-20 轮'
           when turn_count <= 40 then '21-40 轮'
           else '40+ 轮' end as name,
         case
           when turn_count <= 4 then 1 when turn_count <= 10 then 2
           when turn_count <= 20 then 3 when turn_count <= 40 then 4 else 5 end as ord,
         count(*)::int as cnt
  from s group by 1, 2
)
select jsonb_build_object(
  'sessions', (select count(*)::int from s),
  'users', (select count(distinct user_key)::int from s),
  'messages', (select count(*)::int from m),
  'audios', (select count(*)::int from m where audio_path is not null),
  'first_seen', (select min(started_at) from s),
  'last_seen', (select max(started_at) from s),
  'avg_turns', (select coalesce(round(avg(turn_count)::numeric, 2), 0) from s),
  'batch_count', (select count(*)::int from import_batches where data_source_id = p_data_source_id),
  'daily', (select coalesce(jsonb_agg(jsonb_build_object('date', d, 'sessions', c) order by d), '[]'::jsonb) from daily_top),
  'turn_buckets', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', cnt) order by ord), '[]'::jsonb) from buckets)
);
$$;

-- extra 字段真实取值分布（整个数据源，只看 message 级 extra）
-- 分类值 → 计数排名；数值型 → 均值/中位数/P90/最大值/样本数
-- 用途：字段 Schema 页的「从数据推断」，以及报告的确定性分布
create or replace function extra_histogram(p_data_source_id uuid, p_max_values int default 24)
returns jsonb
language sql
stable
as $$
with flat as (
  select kv.key as key, kv.value as value
  from messages m
  cross join lateral jsonb_each(m.extra) as kv
  where m.data_source_id = p_data_source_id and jsonb_typeof(m.extra) = 'object'
),
cat_src as (
  select key,
         case
           when jsonb_typeof(value) = 'boolean' then value::text
           when jsonb_typeof(value) = 'string' then trim(both '"' from value::text)
         end as name
  from flat
),
cat_agg as (
  select key, name, count(*)::int as cnt
  from cat_src
  where name is not null and length(name) between 1 and 40
  group by key, name
),
cat_ranked as (
  select key, name, cnt, row_number() over (partition by key order by cnt desc, name) as rn
  from cat_agg
),
cat_json as (
  select key, jsonb_agg(jsonb_build_object('name', name, 'value', cnt) order by cnt desc) as items
  from cat_ranked
  where rn <= p_max_values
  group by key
),
num_long as (
  select key, '均值' as n, avg((value #>> '{}')::numeric)::numeric as v, 1 as ord
  from flat where jsonb_typeof(value) = 'number' group by key
  union all
  select key, '中位数', percentile_cont(0.5) within group (order by (value #>> '{}')::numeric)::numeric, 2
  from flat where jsonb_typeof(value) = 'number' group by key
  union all
  select key, 'P90', percentile_cont(0.9) within group (order by (value #>> '{}')::numeric)::numeric, 3
  from flat where jsonb_typeof(value) = 'number' group by key
  union all
  select key, '最大值', max((value #>> '{}')::numeric), 4
  from flat where jsonb_typeof(value) = 'number' group by key
  union all
  select key, '样本数', count(*)::numeric, 5
  from flat where jsonb_typeof(value) = 'number' group by key
),
num_json as (
  select key, jsonb_agg(jsonb_build_object('name', n, 'value', round(v, 4)) order by ord) as items
  from num_long group by key
),
combined as (
  select key, items from cat_json
  union all
  select key, items from num_json
)
select coalesce(jsonb_agg(jsonb_build_object('key', key, 'values', items) order by key), '[]'::jsonb)
from combined;
$$;

-- 同上，但只统计指定的会话集合。
-- 预览报告与任务报告的口径必须与「本次实际分析的样本」一致，否则会用全量分布去
-- 解释抽样子集。返回值多一个 kind 字段（1=分类分布，2=数值统计）。
create or replace function extra_histogram_for_sessions(p_session_ids uuid[], p_max_values int default 24)
returns jsonb
language sql
stable
as $$
with flat as (
  select kv.key as key, kv.value as value
  from messages m
  join unnest(p_session_ids) as s(sid) on s.sid = m.session_id
  cross join lateral jsonb_each(m.extra) as kv
  where jsonb_typeof(m.extra) = 'object'
),
cat_src as (
  select key,
         case
           when jsonb_typeof(value) = 'boolean' then value::text
           when jsonb_typeof(value) = 'string' then trim(both '"' from value::text)
         end as name
  from flat
),
cat_agg as (
  select key, name, count(*)::int as cnt
  from cat_src
  where name is not null and length(name) between 1 and 40
  group by key, name
),
cat_ranked as (
  select key, name, cnt, row_number() over (partition by key order by cnt desc, name) as rn
  from cat_agg
),
cat_json as (
  select key,
         jsonb_agg(jsonb_build_object('name', name, 'value', cnt) order by cnt desc) as items,
         1 as kind
  from cat_ranked
  where rn <= p_max_values
  group by key
),
num_long as (
  select key, '均值' as n, avg((value #>> '{}')::numeric)::numeric as v, 1 as ord
  from flat where jsonb_typeof(value) = 'number' group by key
  union all
  select key, '中位数', percentile_cont(0.5) within group (order by (value #>> '{}')::numeric)::numeric, 2
  from flat where jsonb_typeof(value) = 'number' group by key
  union all
  select key, 'P90', percentile_cont(0.9) within group (order by (value #>> '{}')::numeric)::numeric, 3
  from flat where jsonb_typeof(value) = 'number' group by key
  union all
  select key, '最大值', max((value #>> '{}')::numeric), 4
  from flat where jsonb_typeof(value) = 'number' group by key
  union all
  select key, '样本数', count(*)::numeric, 5
  from flat where jsonb_typeof(value) = 'number' group by key
),
num_json as (
  select key, jsonb_agg(jsonb_build_object('name', n, 'value', round(v, 4)) order by ord) as items, 2 as kind
  from num_long group by key
),
combined as (
  select key, items, kind from cat_json
  union all
  select key, items, kind from num_json
)
select coalesce(jsonb_agg(jsonb_build_object('key', key, 'values', items, 'kind', kind) order by key), '[]'::jsonb)
from combined;
$$;

-- 会话层结果聚合（Postgres 直算，不经模型）。
-- p_scope='all' 聚合整个任务；p_scope='user' 且给 p_user_key 时聚合单个用户，
-- 后者用于报告的用户下探面板。quality_score 的量纲是 0-100。
create or replace function task_session_stats(p_task_id uuid, p_scope text default 'all', p_user_key text default null)
returns jsonb
language sql
stable
as $$
with q as (
  select case when (r.result ->> 'quality_score') ~ '^-?[0-9]+(\.[0-9]+)?$'
              then (r.result ->> 'quality_score')::numeric end as score,
         coalesce(nullif(r.result ->> 'outcome', ''), 'unknown') as outcome,
         coalesce(nullif(r.result ->> 'sentiment', ''), 'unknown') as sentiment,
         coalesce(nullif(r.result ->> 'risk_level', ''), 'none') as risk,
         coalesce(nullif(r.result ->> 'intent', ''), '未标注') as intent,
         coalesce(r.result -> 'tags', '[]'::jsonb) as tags,
         coalesce(r.result -> 'problems', '[]'::jsonb) as problems,
         coalesce(r.result -> 'highlights', '[]'::jsonb) as highlights,
         coalesce(r.result -> 'metrics', '[]'::jsonb) as metrics,
         r.session_key, r.user_key
  from task_session_results r
  where r.task_id = p_task_id and r.status = 'success' and r.result is not null
    and (p_scope = 'all' or (p_scope = 'user' and r.user_key = p_user_key))
),
totals as (
  select count(*)::int as n,
         coalesce(round(avg(score)::numeric, 2), 0) as avg_quality,
         count(*) filter (where risk in ('medium','high'))::int as risky
  from q
),
buckets as (
  select case when score < 40 then '低 (<40)' when score < 60 then '偏低 (40-59)'
              when score < 80 then '良好 (60-79)' else '优秀 (80+)' end as name,
         case when score < 40 then 1 when score < 60 then 2 when score < 80 then 3 else 4 end as ord,
         count(*)::int as cnt
  from q where score is not null group by 1, 2
),
d_outcome as (select outcome as name, count(*)::int as value from q group by 1),
d_sentiment as (select sentiment as name, count(*)::int as value from q group by 1),
d_risk as (select risk as name, count(*)::int as value from q group by 1),
d_intent as (select intent as name, count(*)::int as value from q group by 1 order by value desc limit 15),
d_tags as (
  select trim(t.tag) as name, count(*)::int as value
  from q cross join lateral jsonb_array_elements_text(q.tags) as t(tag)
  where length(trim(t.tag)) > 0 group by 1 order by value desc limit 25
),
d_problems as (
  select trim(p.item) as name, count(*)::int as value
  from q cross join lateral jsonb_array_elements_text(q.problems) as p(item)
  where length(trim(p.item)) > 0 group by 1 order by value desc limit 30
),
d_highlights as (
  select trim(p.item) as name, count(*)::int as value
  from q cross join lateral jsonb_array_elements_text(q.highlights) as p(item)
  where length(trim(p.item)) > 0 group by 1 order by value desc limit 30
),
mets as (
  select (mm.item ->> 'key') as k,
         coalesce(nullif(mm.item ->> 'label', ''), mm.item ->> 'key') as label,
         (mm.item ->> 'value')::numeric as v,
         nullif(mm.item ->> 'unit', '') as unit
  from q cross join lateral jsonb_array_elements(q.metrics) as mm(item)
  where (mm.item ->> 'value') ~ '^-?[0-9]+(\.[0-9]+)?$'
    and coalesce(nullif(mm.item ->> 'key', ''), 'x') <> ''
),
mets_avg as (
  select k, max(label) as label, round(avg(v)::numeric, 4) as avg_v,
         round(sum(v)::numeric, 4) as sum_v, max(unit) as unit, count(*)::int as samples
  from mets group by k
)
select jsonb_build_object(
  'session_count', (select n from totals),
  'risky_count', (select risky from totals),
  'avg_quality', (select avg_quality from totals),
  'risky_ratio', (select case when n = 0 then null else round(risky::numeric / n * 100, 2) end from totals),
  'quality_buckets', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', cnt) order by ord), '[]'::jsonb) from buckets),
  'distributions', jsonb_build_object(
    'outcome', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', value) order by value desc), '[]'::jsonb) from d_outcome),
    'sentiment', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', value) order by value desc), '[]'::jsonb) from d_sentiment),
    'risk_level', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', value) order by value desc), '[]'::jsonb) from d_risk),
    'intent', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', value)), '[]'::jsonb) from d_intent),
    'tags', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', value)), '[]'::jsonb) from d_tags),
    'problems', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', value)), '[]'::jsonb) from d_problems),
    'highlights', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', value)), '[]'::jsonb) from d_highlights)
  ),
  'metrics', (select coalesce(jsonb_agg(jsonb_build_object('key', k, 'label', label, 'avg', avg_v, 'sum', sum_v, 'unit', unit, 'samples', samples) order by label), '[]'::jsonb) from mets_avg)
);
$$;

-- 用户层结果聚合：标签/诉求 Top、指标均值、persona 索引（供报告下探使用）
create or replace function task_user_stats(p_task_id uuid)
returns jsonb
language sql
stable
as $$
with u as (
  select r.user_key, r.session_count,
         case when (r.result ->> 'risk_level') in ('medium','high') then r.result ->> 'risk_level' end as risk,
         nullif(r.result ->> 'persona', '') as persona,
         r.result ->> 'summary' as summary
  from task_user_results r
  where r.task_id = p_task_id and r.status = 'success' and r.result is not null
),
agg_tags as (
  select trim(t.tag) as name, count(*)::int as value
  from task_user_results r
  cross join lateral jsonb_array_elements_text(coalesce(r.result -> 'tags', '[]'::jsonb)) as t(tag)
  where r.task_id = p_task_id and r.status = 'success' and length(trim(t.tag)) > 0
  group by 1 order by value desc limit 25
),
mets as (
  select (mm.item ->> 'key') as k,
         coalesce(nullif(mm.item ->> 'label', ''), mm.item ->> 'key') as label,
         (mm.item ->> 'value')::numeric as v,
         nullif(mm.item ->> 'unit', '') as unit
  from task_user_results r
  cross join lateral jsonb_array_elements(coalesce(r.result -> 'metrics', '[]'::jsonb)) as mm(item)
  where r.task_id = p_task_id and r.status = 'success'
    and (mm.item ->> 'value') ~ '^-?[0-9]+(\.[0-9]+)?$'
),
mets_avg as (
  select k, max(label) as label, round(avg(v)::numeric, 4) as avg_v,
         round(sum(v)::numeric, 4) as sum_v, max(unit) as unit, count(*)::int as samples
  from mets group by k
),
needs as (
  select trim(t.item) as name, count(*)::int as value
  from task_user_results r
  cross join lateral jsonb_array_elements_text(coalesce(r.result -> 'needs', '[]'::jsonb)) as t(item)
  where r.task_id = p_task_id and r.status = 'success' and length(trim(t.item)) > 0
  group by 1 order by value desc limit 25
)
select jsonb_build_object(
  'user_count', (select count(*)::int from u),
  'risk_count', (select count(*)::int from u where risk is not null),
  'top_tags', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', value)), '[]'::jsonb) from agg_tags),
  'top_needs', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', value)), '[]'::jsonb) from needs),
  'metrics', (select coalesce(jsonb_agg(jsonb_build_object('key', k, 'label', label, 'avg', avg_v, 'sum', sum_v, 'unit', unit, 'samples', samples) order by label), '[]'::jsonb) from mets_avg),
  'session_total', (select coalesce(sum(session_count), 0)::int from u),
  'persona_index', (select coalesce(jsonb_agg(jsonb_build_object('key', u2.user_key, 'label', coalesce(u2.persona, u2.user_key), 'summary', coalesce(u2.summary, ''))), '[]'::jsonb) from u u2)
);
$$;
