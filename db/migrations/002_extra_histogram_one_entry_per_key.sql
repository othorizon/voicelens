-- =============================================================================
-- extra_histogram: one entry per key.
-- =============================================================================
-- The ported implementation emitted a categorical entry AND a numeric entry for
-- the same key whenever a field's values were mixed-typed — e.g. an
-- `asr_confidence` that is a number on most messages but the string "N/A" on a
-- few, which is what real ASR exports look like. Two consumers break on that:
--
--   1. 字段 Schema 页的「从数据推断」 maps one histogram entry to one
--      ExtraFieldDef, so a duplicated key produced two fields with the same
--      name — and saveExtraSchema() rejects that with 「extra 字段名不可重复」.
--      The user could infer a schema but never save it.
--
--   2. deriveGroundTruth() walks the entries and routes each one by shape, so a
--      duplicated key landed in BOTH branches: four numeric metrics for the
--      field, plus a "distribution" in which "N/A" is an enum label. That
--      section of the report is presented as authoritative, Postgres-computed
--      ground truth and is what fixKpis() corrects the model against, so two
--      contradictory truths for one field is the worst possible outcome —
--      which one wins depends on array order.
--
-- The rule now, following the product's own principle that the declared schema
-- decides how a field is used:
--
--   * A field declared in data_sources.extra_schema is read the way it was
--     declared: kind='number' gets the numeric summary, anything else
--     (enum/sentiment/boolean/text) gets value counts.
--   * An undeclared field falls back to its dominant observed type. This is
--     exactly the 「从数据推断」 bootstrap case, where no declaration exists yet.
--   * Values that do not fit the chosen branch are counted in `mixed_count`
--     rather than silently dropped, so dirty data stays visible.
--
-- Still message-level only, as before: sessions.extra is a shallow merge of
-- every message's extra (normalize.ts bundleSessions), so a message-level field
-- appears there as an arbitrary last-write-wins sample. It is not a
-- session-level fact table and must not be aggregated as one.
--
-- Both entry points now share one body, so a preview report and the full run it
-- previews cannot diverge in their 口径.
-- =============================================================================

drop function if exists extra_histogram(uuid, int);
drop function if exists extra_histogram_for_sessions(uuid[], int);

-- Shared body. Exactly one of p_data_source_id / p_session_ids is non-null.
create or replace function extra_histogram_core(
  p_data_source_id uuid,
  p_session_ids    uuid[],
  p_max_values     int
)
returns jsonb
language sql
stable
as $$
with scope as (
  -- Resolve the owning data source either way, so the declared schema can be
  -- consulted even when the caller only passed session ids.
  select coalesce(
    p_data_source_id,
    (select s.data_source_id from sessions s where s.id = any (p_session_ids) limit 1)
  ) as data_source_id
),
declared as (
  select elem ->> 'name' as key, nullif(elem ->> 'kind', '') as kind
  from scope
  cross join lateral jsonb_array_elements(
    coalesce((select d.extra_schema from data_sources d where d.id = scope.data_source_id), '[]'::jsonb)
  ) as elem
  where jsonb_typeof(elem) = 'object' and nullif(elem ->> 'name', '') is not null
),
flat as (
  select kv.key as key, kv.value as value
  from messages m
  cross join lateral jsonb_each(m.extra) as kv
  where jsonb_typeof(m.extra) = 'object'
    and (
      (p_session_ids is null and m.data_source_id = (select data_source_id from scope))
      or (p_session_ids is not null and m.session_id = any (p_session_ids))
    )
),
present as (
  select key, value from flat where jsonb_typeof(value) not in ('null', 'object', 'array')
),
-- One row per key: is it numeric, and how many values disagree with that call?
classified as (
  select p.key,
         count(*) as n_all,
         count(*) filter (where jsonb_typeof(p.value) = 'number') as n_num,
         case
           -- A declaration wins outright.
           when max(d.kind) = 'number' then true
           when max(d.kind) is not null then false
           -- Otherwise the dominant observed type decides.
           else count(*) filter (where jsonb_typeof(p.value) = 'number') * 2 > count(*)
         end as is_numeric
  from present p
  left join declared d on d.key = p.key
  group by p.key
),
num_stats as (
  select p.key,
         jsonb_build_array(
           jsonb_build_object('name', '均值',   'value', round(avg((p.value #>> '{}')::numeric), 4)),
           jsonb_build_object('name', '中位数', 'value', round((percentile_cont(0.5) within group (order by (p.value #>> '{}')::numeric))::numeric, 4)),
           jsonb_build_object('name', 'P90',    'value', round((percentile_cont(0.9) within group (order by (p.value #>> '{}')::numeric))::numeric, 4)),
           jsonb_build_object('name', '最大值', 'value', round(max((p.value #>> '{}')::numeric), 4)),
           jsonb_build_object('name', '样本数', 'value', count(*))
         ) as items,
         2 as kind,
         -- Values of the wrong type for a numeric field.
         (select c.n_all - c.n_num from classified c where c.key = p.key) as mixed_count
  from present p
  join classified c2 on c2.key = p.key and c2.is_numeric
  where jsonb_typeof(p.value) = 'number'
  group by p.key
),
cat_counts as (
  select p.key,
         case when jsonb_typeof(p.value) = 'boolean' then p.value #>> '{}'
              else trim(p.value #>> '{}') end as name,
         count(*) as cnt
  from present p
  join classified c on c.key = p.key and not c.is_numeric
  where jsonb_typeof(p.value) in ('boolean', 'string')
    and length(trim(p.value #>> '{}')) between 1 and 40
  group by 1, 2
),
cat_ranked as (
  select key, name, cnt, row_number() over (partition by key order by cnt desc, name) as rn
  from cat_counts
),
cat_stats as (
  select r.key,
         jsonb_agg(jsonb_build_object('name', r.name, 'value', r.cnt) order by r.cnt desc, r.name) as items,
         1 as kind,
         -- Numbers, and strings outside the 1..40 length window, are not counted.
         (select c.n_all from classified c where c.key = r.key)
           - (select coalesce(sum(a.cnt), 0) from cat_counts a where a.key = r.key) as mixed_count
  from cat_ranked r
  where r.rn <= greatest(coalesce(p_max_values, 24), 1)
  group by r.key
),
combined as (
  select key, items, kind, mixed_count from num_stats
  union all
  select key, items, kind, mixed_count from cat_stats
)
select coalesce(
  jsonb_agg(
    jsonb_build_object('key', key, 'values', items, 'kind', kind)
      || case when coalesce(mixed_count, 0) > 0
              then jsonb_build_object('mixed_count', mixed_count)
              else '{}'::jsonb end
    order by key
  ),
  '[]'::jsonb
)
from combined;
$$;

create or replace function extra_histogram(p_data_source_id uuid, p_max_values int default 24)
returns jsonb
language sql
stable
as $$
  select extra_histogram_core(p_data_source_id, null::uuid[], p_max_values);
$$;

create or replace function extra_histogram_for_sessions(p_session_ids uuid[], p_max_values int default 24)
returns jsonb
language sql
stable
as $$
  select extra_histogram_core(null::uuid, coalesce(p_session_ids, '{}'::uuid[]), p_max_values);
$$;
