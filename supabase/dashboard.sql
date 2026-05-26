-- skill-telemetry dashboard queries
--
-- How to use: paste any block into Supabase SQL Editor and run.
-- Edit the WHERE clauses to filter by your needs.
--
-- All views in this file are committed to schema.sql and auto-created
-- on first schema run. The queries below USE those views — they're
-- the ones you'd actually paste into the SQL Editor day-to-day.
--
-- Time zone: views render in America/Los_Angeles by default. Override
-- by passing a different IANA timezone to skill_events_in_tz('Asia/Shanghai').

-- ════════════════════════════════════════════════════════════
-- 1. OVERVIEW — per-skill totals
-- ════════════════════════════════════════════════════════════
-- Filter: WHERE skill = 'tdoc' to drill into one skill.
select
  skill,
  total_events,
  users,
  sessions,
  successes,
  errors,
  abandoned,
  success_rate_pct as "success_%",
  avg_duration_s as "avg_dur_s",
  last_seen
from skill_usage_summary
where total_events > 1                -- hide one-off test rows
order by total_events desc;


-- ════════════════════════════════════════════════════════════
-- 2. DAILY ACTIVE USERS — by skill, last 30 days
-- ════════════════════════════════════════════════════════════
-- Filter: change interval or add WHERE skill = 'X'.
select
  day,
  skill,
  dau,
  sessions,
  events,
  round(events::numeric / nullif(sessions, 0), 1) as events_per_session
from skill_dau
where day > current_date - interval '30 days'
order by day desc, dau desc;


-- ════════════════════════════════════════════════════════════
-- 3. HOURLY ACTIVITY — busiest hours of the day
-- ════════════════════════════════════════════════════════════
-- For one skill. Useful to find peak usage windows.
select
  extract(hour from ts at time zone 'America/Los_Angeles')::int as hour_pt,
  skill,
  count(*) as events,
  count(distinct session_id) as sessions
from skill_events
where skill = 'tdoc'                                   -- change this
  and ts > now() - interval '14 days'
group by hour_pt, skill
order by hour_pt;


-- ════════════════════════════════════════════════════════════
-- 4. FAILURE MODES — what breaks most often
-- ════════════════════════════════════════════════════════════
-- Already a view; ordered by count.
select * from skill_failure_modes
where last_seen > now() - interval '30 days'
limit 20;


-- ════════════════════════════════════════════════════════════
-- 5. STEP HEAT MAP — which sub-commands of your skill get used
-- ════════════════════════════════════════════════════════════
-- For tdoc: shows whether users hit `new`, `edit`, `publish`,
-- `list`, etc., with success/error breakdown per step.
select
  step,
  count(*) as runs,
  count(*) filter (where outcome = 'success') as ok,
  count(*) filter (where outcome = 'error') as err,
  count(*) filter (where outcome = 'abandoned') as bail,
  round(100.0 * count(*) filter (where outcome = 'success') /
    nullif(count(*), 0), 1) as success_pct,
  round(avg(duration_s)::numeric, 1) as avg_dur_s
from skill_events
where skill = 'tdoc'                                   -- change this
  and event_type = 'skill_run'
  and step is not null
  and ts > now() - interval '30 days'
group by step
order by runs desc;


-- ════════════════════════════════════════════════════════════
-- 6. VERSION ROLLOUT — adoption of recent releases
-- ════════════════════════════════════════════════════════════
-- See which version your users are on. Useful after publishing
-- a new release to track adoption.
select
  skill,
  coalesce(skill_version, '(none)') as version,
  count(*) as events,
  count(distinct installation_id) as users,
  count(distinct session_id) as sessions,
  min(ts) as first_seen,
  max(ts) as last_seen
from skill_events
where skill = 'tdoc'                                   -- change this
group by skill, skill_version
order by last_seen desc nulls last;


-- ════════════════════════════════════════════════════════════
-- 7. PLATFORM BREAKDOWN — macOS vs Linux usage
-- ════════════════════════════════════════════════════════════
select
  skill,
  coalesce(os, '(unknown)') as os,
  coalesce(arch, '(unknown)') as arch,
  count(*) as events,
  count(distinct installation_id) as users,
  count(*) filter (where outcome = 'error') as errors,
  round(100.0 * count(*) filter (where outcome = 'error') /
    nullif(count(*), 0), 1) as error_pct
from skill_events
where ts > now() - interval '30 days'
group by skill, os, arch
having count(*) >= 2                                   -- hide noise
order by skill, events desc;


-- ════════════════════════════════════════════════════════════
-- 8. NEW vs RETURNING USERS — by week
-- ════════════════════════════════════════════════════════════
-- "New" = first time we see that installation_id in any skill.
-- "Returning" = installation_id seen in a prior week.
with first_seen as (
  select installation_id, min(date_trunc('week', ts)) as first_week
  from skill_events
  where installation_id is not null
  group by installation_id
),
weekly as (
  select
    date_trunc('week', ts) as week,
    skill,
    installation_id
  from skill_events
  where ts > now() - interval '8 weeks'
    and installation_id is not null
  group by week, skill, installation_id
)
select
  weekly.week::date as week,
  weekly.skill,
  count(*) filter (where weekly.week = first_seen.first_week) as new_users,
  count(*) filter (where weekly.week > first_seen.first_week) as returning_users
from weekly
join first_seen on first_seen.installation_id = weekly.installation_id
group by weekly.week, weekly.skill
order by week desc, weekly.skill;


-- ════════════════════════════════════════════════════════════
-- 9. RECENT EVENTS LIVE FEED — last 50 with filters
-- ════════════════════════════════════════════════════════════
-- Drop-in: copy this into SQL Editor, edit the WHEREs.
select
  to_char(ts at time zone 'America/Los_Angeles', 'MM-DD HH24:MI:SS') as t,
  skill,
  skill_version as v,
  event_type as evt,
  outcome,
  step,
  duration_s as dur_s,
  error_class,
  left(error_message, 60) as err_msg_60,
  os,
  installation_id
from skill_events
where ts > now() - interval '24 hours'                 -- change window
  -- and skill = 'tdoc'                                -- uncomment to filter
  -- and outcome in ('error', 'abandoned')             -- uncomment to filter
  -- and event_type = 'upgrade_prompted'               -- lifecycle events
order by ts desc
limit 50;


-- ════════════════════════════════════════════════════════════
-- 10. UPGRADE PROMPT FUNNEL — who saw new releases
-- ════════════════════════════════════════════════════════════
-- For each release, how many users were prompted, and how many
-- subsequently used the new version (= upgrade conversion rate).
with prompts as (
  select
    installation_id,
    split_part(step, '→', 2) as new_version,
    min(ts) as prompted_at
  from skill_events
  where event_type = 'upgrade_prompted'
    and step like 'v%→v%'
  group by installation_id, step
),
upgrades as (
  select distinct installation_id, skill_version
  from skill_events
  where event_type = 'skill_run'
    and skill_version is not null
)
select
  prompts.new_version,
  count(distinct prompts.installation_id) as users_prompted,
  count(distinct upgrades.installation_id) as users_upgraded,
  round(100.0 * count(distinct upgrades.installation_id) /
    nullif(count(distinct prompts.installation_id), 0), 1) as conversion_pct
from prompts
left join upgrades on upgrades.installation_id = prompts.installation_id
  and 'v' || upgrades.skill_version = prompts.new_version
group by prompts.new_version
order by prompts.new_version desc;


-- ════════════════════════════════════════════════════════════
-- 11. SOURCE ATTRIBUTION — SKILL.md self-report vs hook
-- ════════════════════════════════════════════════════════════
-- See how much of your data comes from each capture mechanism.
-- Useful when deciding whether SKILL.md framing is enough or you
-- need the Stop hook.
select
  skill,
  case
    when step = 'hook-captured' then 'hook'
    when step like 'reaped-%' then 'self-healing'
    else 'skill-md-self-report'
  end as capture_source,
  count(*) as events,
  count(distinct session_id) as sessions
from skill_events
where event_type = 'skill_run'
  and ts > now() - interval '30 days'
group by skill, capture_source
order by skill, events desc;


-- ════════════════════════════════════════════════════════════
-- 12. SESSION DEPTH — events per session (engagement signal)
-- ════════════════════════════════════════════════════════════
-- A session with many events = user iterated a lot inside one
-- conversation. A session with 1 event = one-shot use.
with session_counts as (
  select
    session_id,
    skill,
    count(*) as events_in_session
  from skill_events
  where event_type = 'skill_run'
    and ts > now() - interval '30 days'
    and session_id is not null
  group by session_id, skill
)
select
  skill,
  count(*) as total_sessions,
  count(*) filter (where events_in_session = 1) as single_event_sessions,
  count(*) filter (where events_in_session between 2 and 5) as short_sessions,
  count(*) filter (where events_in_session > 5) as deep_sessions,
  round(avg(events_in_session)::numeric, 1) as avg_events_per_session,
  max(events_in_session) as max_events_in_one_session
from session_counts
group by skill
order by total_sessions desc;
