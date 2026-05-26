# Architecture

**Problem**: a Claude Code skill author has zero visibility into how
their shipped skill is used or where it fails. **Solution**: this kit —
the author drops it into their skill repo, points it at their own
Supabase, and gets a per-invocation event stream in their own database.

This doc explains *why* it's built the way it is. For *how to use it*,
see [README.md](./README.md).

## What this is, what it isn't

**Is:**
- Per-skill, per-author telemetry. One skill = one author = one Supabase pool.
- An honest pipe: by default a skill explicitly calls `bin/telemetry-log` from
  inside its own SKILL.md. No global hooks, no cross-skill transcript grep,
  no inference. An **opt-in per-skill Stop hook** (`bin/telemetry-hook`) is
  also available — it's filtered to a single skill name, only reads which
  Skill tool calls happened (no prompt/reply content), and is installed
  explicitly via `telemetry-hook-install --skill <name>`. See PRIVACY.md.
- Local-first: events are written to JSONL on the user's machine FIRST,
  then a background sync pushes to the author's Supabase. If Supabase is
  unreachable, data stays local and replays next time. Cursor file tracks
  position so events never double-send.
- MIT-licensed. Anthropic or anyone else can absorb this into an official
  feature and we retire happily.

**Is not:**
- A cross-skill global observatory. (That would be a different design — a
  global Stop hook + transcript parsing, which the OP of issue #35319 calls
  "fragile.")
- A platform for skill authors. (No central server. Each author runs their
  own Supabase project. We provide the template, not the service.)
- A replacement for OpenTelemetry. (If you need OTLP/Datadog/Snowflake
  ingestion, write your own exporter or wait for Claude Code native OTEL.
  See issues #44432, #42281, #49009.)

## Why "skill calls itself" instead of Stop hook

Claude Code's `Stop` hook payload does not include the skill name (issue
#35319, OP's own caveat). Inferring it by grep-ing the transcript JSONL is
fragile: it depends on log format, picks the last skill if multiple ran, and
breaks when the user invokes via `/skill-name` (which doesn't emit a tool
call at all — see issue #44432).

Instead: the skill itself, at the end of its SKILL.md, instructs Claude to
run `bin/telemetry-log --skill X --outcome Y --duration Z`. Claude knows
exactly which skill it is (it's reading its own SKILL.md) and what the
outcome was (it just finished the task). The event is authoritative, not
heuristic.

Trade-off: if Claude crashes mid-skill, no event is emitted. We accept this.
It's better to log fewer accurate events than many guessed ones.

## Data flow

```
   User invokes skill
        │
        ▼
   ┌─────────────────────────────┐
   │ Claude reads SKILL.md       │
   │ Does the actual work        │
   │ Reaches "TELEMETRY" section │
   │ at the end of SKILL.md      │
   └──────────────┬──────────────┘
                  │
                  ▼
       bin/telemetry-log
       (synchronous, fast)
                  │
       ┌──────────┴──────────┐
       ▼                     ▼
  ~/.<skill>/                bin/telemetry-sync &
  telemetry/                 (background, fire-and-forget)
  YYYY-MM-DD.jsonl                │
                                  │ POST batch
                                  ▼
                         Author's Supabase
                         edge function
                         (skill-telemetry-ingest)
                                  │
                                  ▼
                         skill_events table
```

## Privacy model

**One tier: default-on, env var to disable.**

The skill author advertises in their README that telemetry is on by default
and that setting `SKILL_TELEMETRY=off` disables network sync. (Local JSONL
is also gated by the same flag — `off` means nothing is written at all.)

Why default-on:
- Default-off → adoption floor near zero (we measured this in gstack: tier
  prompts during onboarding had high opt-in but most users would not have
  enabled it post-hoc).
- The author owes their users transparency, not a guessing game. The README
  must list every field collected, in plain language, in the first 3
  paragraphs. No buried disclosure.

Why one tier and not four (like gstack):
- Gstack has community/enterprise tiers because it's one project with two
  business contexts. A typical OSS skill has one context: the author wants
  to iterate. Adding tier complexity to every skill that adopts this
  template would tax authors and confuse users.
- If you actually need per-user pseudonymization, fork this and add a
  `anonymous` mode that strips installation_id before send. Five lines.

## Fields collected (the full list)

| Field          | Type   | Purpose                                       |
|----------------|--------|-----------------------------------------------|
| `ts`           | ISO8601 | When the event happened (UTC)                |
| `skill`        | string | Which skill (the author hardcodes this)       |
| `outcome`      | string | `success` / `error` / `abandoned` / `unknown` |
| `duration_s`   | int    | Seconds the skill took (optional)             |
| `error_detail` | string | Short failure tag (optional, ≤160 chars)      |
| `step`         | string | Which step failed/completed (optional)        |
| `session_id`   | string | Claude Code session ID                        |
| `installation_id` | uuid | Per-machine random UUID, generated on first use |

`installation_id` is generated once on the user's machine and stored at
`~/.<skill>/telemetry/installation-id`. It's a UUIDv4, not derived from
hardware. Letting the author count distinct installations without
identifying users.

## Repository layout

```
skill-telemetry/
├── README.md                            # creator-facing setup + adoption guide
├── LICENSE                              # MIT
├── ARCHITECTURE.md                      # this file
├── PRIVACY.md                           # text the creator should reproduce
├── VERSION                              # single source of truth, root only
├── SKILL.md.snippet                     # appended to host skill's SKILL.md
├── bin/
│   ├── telemetry-log                    # write a JSONL event + background sync
│   ├── telemetry-sync                   # cursor-based push to Supabase
│   ├── telemetry-update-check           # check upstream release (cached 24h)
│   ├── telemetry-upgrade-decide         # persist user's upgrade-mode choice
│   ├── telemetry-hook                   # opt-in Stop hook (skill-name filtered)
│   ├── telemetry-hook-install           # safe settings.json modifier
│   ├── telemetry-hook-uninstall         # inverse of install
│   ├── skill-events                     # local-tz dashboard CLI
│   └── skill-telemetry-update           # sync new bins into installed skills
├── dashboard/
│   ├── worker.js                        # Cloudflare Worker dashboard (GH auth)
│   ├── wrangler.toml.template           # config template; user creates wrangler.toml
│   └── README.md                        # dashboard-specific setup
├── supabase/
│   ├── schema.sql                       # tables + views + tz function
│   ├── dashboard.sql                    # 12 ready-to-paste analysis queries
│   ├── config.sh.example                # template (real config.sh is gitignored)
│   └── functions/
│       └── skill-telemetry-ingest/
│           └── index.ts                 # Deno edge function (defense-in-depth sanitize)
└── skills/
    └── add-telemetry/
        └── SKILL.md                     # meta-skill: install telemetry into a skill
```

## What changes between this template and the gstack reference

Gstack inspired the cursor-sync pattern, `.pending` self-healing marker,
and "treat skill file as executable instructions" framing. Use case differs:

| Aspect | Gstack | skill-telemetry |
|---|---|---|
| Scope | One project's skills | One skill at a time |
| Authentication | Public anon key + RLS + edge fn | Same |
| Tier model | 4 tier (off/anon/community/full) | 3 tier (on / anonymous / off) — UI exposes only on/off; anonymous is honored when set manually |
| Identification | `installation_id` + tier-stripping | `installation_id`, optionally stripped in anonymous mode |
| Skill detection | Skills self-report via CLI args | Same, plus opt-in Stop hook for proactive skills that skip the self-report |
| Hook usage | None | Opt-in `bin/telemetry-hook` (skill-name filtered, transcript-text minimization) |
| Multi-skill author pool | Yes (one suite, one pool) | Yes (meta-skill detects existing author config and reuses it) |

So if you've read the gstack telemetry code, this will feel familiar.
The hook and the Cloudflare dashboard are the two things gstack doesn't
have — they're what made proactive-skill telemetry actually work.
