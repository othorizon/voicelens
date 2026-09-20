-- =============================================================================
-- Owner-configured model registry and per-source analysis mode.
-- =============================================================================
-- The engine used to read one model out of the environment (AI_BASE_URL /
-- AI_API_KEY / AI_MODEL), which meant a deploy could only ever talk to a single
-- endpoint and changing it required a restart. Models now live in the database,
-- configured by the owner, and come in two kinds:
--
--   multimodal  text + image. Used for every text-only call (user layer, global
--               layer, report writing) and for the non-audio half of the mixed
--               analysis modes.
--   omni        text + image + audio. The only kind that may receive an
--               `input_audio` part.
--
-- Which of the two runs a given call is decided by the analysis mode — see
-- src/lib/models/mode.ts, which owns the mapping and is the file to read before
-- changing anything here. The mode is chosen globally in `app_settings` and may
-- be overridden per data source in `data_sources.model_config`.
--
-- NOTE ON UPGRADES: nothing is migrated out of the environment. A database that
-- takes this migration comes up with an empty registry and no default models,
-- and planning/preview/analysis fail with an explicit "configure a model first"
-- message until the owner fills the settings page in. That is deliberate: the
-- API key now has to be re-entered through the UI so it can be stored
-- encrypted, and silently inheriting a key from the environment would leave a
-- plaintext credential as the real source of truth.
-- =============================================================================

/* ------------------------------------------------------------- ai models */

-- api_key_cipher holds AES-256-GCM ciphertext (see src/lib/models/secret.ts),
-- never the key itself. It is selected only by the code that is about to build
-- an OpenAI client; every other query, and every response that reaches a
-- browser, goes through the masked projection in src/lib/models/registry.ts.
create table ai_models (
  id              uuid primary key default gen_random_uuid(),
  name            text        not null,                  -- 显示名，owner 自己取
  kind            text        not null,                  -- multimodal|omni
  base_url        text        not null,                  -- OpenAI 兼容端点
  model           text        not null,                  -- 端点上的模型 id
  api_key_cipher  text        not null default '',
  enable_thinking boolean     not null default false,    -- 取代 AI_ENABLE_THINKING
  enabled         boolean     not null default true,
  note            text        not null default '',
  created_by      uuid        references users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint ai_models_kind_check check (kind in ('multimodal', 'omni'))
);

-- Names are how the data-source picker and the task stats refer to a model, so
-- two models sharing one name would make a report ambiguous about what ran it.
create unique index ai_models_name_key on ai_models (lower(name));

-- The picker lists usable models of one kind at a time.
create index ai_models_kind_idx on ai_models (kind, enabled, created_at);

create trigger trg_ai_models_touch before update on ai_models
  for each row execute function touch_updated_at();

/* ---------------------------------------------------------- app settings */

-- A tiny key/value table for workspace-wide configuration. Today it holds one
-- row, 'analysis_defaults'; it exists as a table rather than more columns on
-- some other object because the next such setting should not need a migration.
create table app_settings (
  key        text        primary key,
  value      jsonb       not null default '{}'::jsonb,
  updated_by uuid        references users (id) on delete set null,
  updated_at timestamptz not null default now()
);

-- The default every data source inherits until the owner picks models. The two
-- model ids stay null on purpose: an empty registry has nothing to point at,
-- and a null reads as "not configured yet" rather than as a dangling id.
insert into app_settings (key, value)
values (
  'analysis_defaults',
  '{"mode": "omni_for_audio", "omniModelId": null, "multimodalModelId": null}'::jsonb
)
on conflict (key) do nothing;

/* ------------------------------------------------- per-source override */

-- {"mode": …|null, "omniModelId": …|null, "multimodalModelId": …|null}
-- Each key is resolved independently, and a null (or an absent key) inherits
-- that one field from app_settings.analysis_defaults — so a source can pin a
-- mode while still following the workspace default models, or vice versa.
alter table data_sources
  add column if not exists model_config jsonb not null default '{}'::jsonb;
