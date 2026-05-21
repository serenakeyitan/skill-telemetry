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
  error_detail    text,         -- short failure string, ≤160 chars
  step            text,         -- which step failed/completed
  session_id      text,
  installation_id uuid,         -- per-machine UUID
  received_at     timestamptz   default now()
);

-- ─── Indexes you'll actually use ────────────────────────────
create index if not exists skill_events_skill_ts
  on skill_events (skill, ts desc);

create index if not exists skill_events_outcome
  on skill_events (outcome) where outcome is not null;

create index if not exists skill_events_install
  on skill_events (installation_id, ts desc);

-- ─── Row-level security ─────────────────────────────────────
-- The anon key is PUBLIC (committed in skill code). RLS denies all
-- direct access to it. Inserts happen through the edge function using
-- the service role key, which lives in Supabase secrets and never
-- leaves the server.
alter table skill_events enable row level security;

-- No policies = no access. anon role gets nothing. (Service role used
-- by the edge function bypasses RLS.)

-- ─── Useful views for your dashboards ───────────────────────

-- Overall usage by skill
create or replace view skill_usage_summary as
select
  skill,
  count(*) as total_runs,
  count(*) filter (where outcome = 'success') as successes,
  count(*) filter (where outcome = 'error') as errors,
  count(*) filter (where outcome = 'abandoned') as abandoned,
  count(distinct installation_id) as unique_installs,
  round(avg(duration_s)::numeric, 1) as avg_duration_s,
  max(ts) as last_run_at
from skill_events
group by skill
order by total_runs desc;

-- Failure modes — the iteration signal
create or replace view skill_failure_modes as
select
  skill,
  step,
  error_detail,
  count(*) as occurrences,
  count(distinct installation_id) as affected_installs,
  max(ts) as last_seen
from skill_events
where outcome = 'error'
group by skill, step, error_detail
order by occurrences desc;

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
  skill           text,
  outcome         text,
  duration_s      integer,
  error_detail    text,
  step            text,
  session_id      text,
  installation_id uuid
) language sql stable as $$
  select
    id,
    (ts at time zone tz)::timestamp as ts_local,
    ts as ts_utc,
    skill,
    outcome,
    duration_s,
    error_detail,
    step,
    session_id,
    installation_id
  from skill_events
  order by ts desc;
$$;
