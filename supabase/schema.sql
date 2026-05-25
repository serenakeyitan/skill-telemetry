-- skill-telemetry schema
-- Run this in your Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Idempotent: safe to re-run.

-- ─── Main events table ──────────────────────────────────────
create table if not exists skill_events (
  id              bigint generated always as identity primary key,
  ts              timestamptz   not null,
  skill           text          not null,
  outcome         text,         -- success | error | abandoned | unknown
  duration_s      integer,
  error_detail    text,         -- DEPRECATED in v2; kept for backward compat
  step            text,         -- which step failed/completed
  session_id      text,
  installation_id uuid,         -- per-machine UUID
  received_at     timestamptz   default now()
);

-- ─── v0.2.0 schema additions (idempotent) ───────────────────
-- These columns are added by ALTER TABLE so existing pools upgrade
-- without losing data. Old clients that don't send these fields just
-- get NULLs — fully backward compatible.

alter table skill_events
  add column if not exists schema_version smallint default 1,
  add column if not exists os             text,         -- darwin | linux | ...
  add column if not exists arch           text,         -- arm64 | x86_64 | ...
  add column if not exists skill_version  text,         -- e.g. "0.1.55"
  add column if not exists error_class    text,         -- low-cardinality tag
  add column if not exists error_message  text,         -- high-cardinality detail
  -- v0.3.0 additions (gstack parity)
  add column if not exists event_type     text default 'skill_run',
                                                        -- skill_run | upgrade_prompted | consent_prompted | ...
  add column if not exists sessions       smallint,     -- concurrent active sessions at event time
  add column if not exists source         text default 'live';
                                                        -- live | replay (telemetry-sync replays)

-- For existing pools where error_detail was used as a combined field,
-- migrate it into error_message so dashboards keep working.
update skill_events
   set error_message = error_detail
 where error_message is null
   and error_detail is not null;

-- ─── Indexes you'll actually use ────────────────────────────
create index if not exists skill_events_skill_ts
  on skill_events (skill, ts desc);

create index if not exists skill_events_outcome
  on skill_events (outcome) where outcome is not null;

create index if not exists skill_events_install
  on skill_events (installation_id, ts desc);

create index if not exists skill_events_error_class
  on skill_events (error_class) where error_class is not null;

create index if not exists skill_events_skill_version
  on skill_events (skill, skill_version);

create index if not exists skill_events_event_type
  on skill_events (skill, event_type, ts desc);

-- ─── Row-level security ─────────────────────────────────────
-- The anon key is PUBLIC (committed in skill code). RLS denies all
-- direct access to it. Inserts happen through the edge function using
-- the service role key, which lives in Supabase secrets and never
-- leaves the server.
alter table skill_events enable row level security;

-- No policies = no access. anon role gets nothing. (Service role used
-- by the edge function bypasses RLS.)

-- ─── Useful views for your dashboards ───────────────────────

-- Overall usage by skill — total events / users / sessions / outcomes
create or replace view skill_usage_summary as
select
  skill,
  count(*) as total_events,
  count(distinct installation_id) as users,
  count(distinct session_id) as sessions,
  count(*) filter (where outcome = 'success') as successes,
  count(*) filter (where outcome = 'error') as errors,
  count(*) filter (where outcome = 'abandoned') as abandoned,
  round(100.0 * count(*) filter (where outcome = 'success') / nullif(count(*), 0), 1) as success_rate_pct,
  round(avg(duration_s)::numeric, 1) as avg_duration_s,
  max(ts) as last_seen
from skill_events
group by skill
order by total_events desc;

-- Daily active users + sessions per skill
create or replace view skill_dau as
select
  skill,
  date_trunc('day', ts at time zone 'America/Los_Angeles')::date as day,
  count(distinct installation_id) as dau,
  count(distinct session_id) as sessions,
  count(*) as events
from skill_events
group by skill, day
order by day desc, dau desc;

-- Failure modes — the iteration signal.
-- Grouped by error_class (low-cardinality) for clean aggregation;
-- error_message in a separate column for drill-down debugging.
create or replace view skill_failure_modes as
select
  skill,
  step,
  error_class,
  count(*) as occurrences,
  count(distinct installation_id) as affected_installs,
  max(ts) as last_seen,
  -- Sample one error_message per group for context
  (array_agg(error_message order by ts desc) filter (where error_message is not null))[1] as sample_message
from skill_events
where outcome = 'error'
group by skill, step, error_class
order by occurrences desc;

-- Cross-version regression view: did a release introduce errors?
create or replace view skill_errors_by_version as
select
  skill,
  skill_version,
  count(*) filter (where outcome = 'error') as errors,
  count(*) as total_runs,
  round(100.0 * count(*) filter (where outcome = 'error') / nullif(count(*), 0), 2) as error_pct
from skill_events
where skill_version is not null
group by skill, skill_version
order by skill, skill_version desc;

-- Platform breakdown — see if bugs are macOS vs Linux
create or replace view skill_platform_usage as
select
  skill,
  os,
  arch,
  count(*) as runs,
  count(distinct installation_id) as installs,
  count(*) filter (where outcome = 'error') as errors
from skill_events
where os is not null and event_type = 'skill_run'
group by skill, os, arch
order by skill, runs desc;

-- Lifecycle events — see consent prompts, upgrade nudges, opt-outs.
-- Anything that's not a skill_run goes here.
create or replace view skill_lifecycle_events as
select
  skill,
  event_type,
  step,
  count(*) as count,
  count(distinct installation_id) as distinct_machines,
  max(ts) as last_seen
from skill_events
where event_type is not null and event_type <> 'skill_run'
group by skill, event_type, step
order by skill, count desc;

-- Per-day usage
create or replace view skill_daily_usage as
select
  date_trunc('day', ts) as day,
  skill,
  count(*) as runs,
  count(*) filter (where outcome = 'error') as errors,
  count(distinct installation_id) as active_installs
from skill_events
group by day, skill
order by day desc, runs desc;

-- ─── Timezone-aware query helper ────────────────────────────
-- Best practice: store UTC (timestamptz already does this), convert
-- at the view boundary. This function takes any IANA timezone name
-- and returns the same rows with ts converted to local wall-clock
-- time. The original ts_utc column is kept so you can verify.
--
-- Usage:
--   select * from skill_events_in_tz('America/Los_Angeles');
--   select * from skill_events_in_tz('Asia/Shanghai');
--   select * from skill_events_in_tz();  -- defaults to UTC
--
-- Invalid tz names raise an exception, surfacing the problem early.

create or replace function skill_events_in_tz(tz text default 'UTC')
returns table (
  id              bigint,
  ts_local        timestamp,
  ts_utc          timestamptz,
  schema_version  smallint,
  skill           text,
  skill_version   text,
  event_type      text,
  outcome         text,
  duration_s      integer,
  step            text,
  error_class     text,
  error_message   text,
  session_id      text,
  installation_id uuid,
  os              text,
  arch            text,
  sessions        smallint,
  source          text
) language sql stable as $$
  select
    id,
    (ts at time zone tz)::timestamp as ts_local,
    ts as ts_utc,
    schema_version,
    skill,
    skill_version,
    coalesce(event_type, 'skill_run') as event_type,
    outcome,
    duration_s,
    step,
    -- Prefer error_class but fall back to error_detail (v1 data) for display
    coalesce(error_class, error_detail) as error_class,
    error_message,
    session_id,
    installation_id,
    os,
    arch,
    sessions,
    coalesce(source, 'live') as source
  from skill_events
  order by ts desc;
$$;
