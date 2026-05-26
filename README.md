# skill-telemetry — Google Analytics for your Claude Code skill

**You shipped a Claude Code skill. You have no idea if anyone uses it,
where it breaks, or whether your last change made it worse. This fixes
that.**

Drop it into your skill, point it at your own database, and every run
reports back: which feature was used, did it succeed, how long it took,
what errored. Your data, your Supabase — nothing goes to us.

```
TIME                 SKILL  EVENT      OUTCOME  STEP     DUR  ERR_CLASS
2026-05-22 09:14:02  tdoc   skill_run  success  publish  87
2026-05-22 09:02:31  tdoc   skill_run  error    publish  12   cloudflare_timeout
2026-05-22 08:47:55  tdoc   skill_run  success  edit     34
```

That's the whole pitch. Skill authors are flying blind today — Claude
Code doesn't surface per-skill usage to the people who write skills.
This is the stopgap until it does.

**Status**: Working, dogfooded on a real skill (tdoc). MIT licensed —
if Anthropic ships official skill analytics
([anthropics/claude-code#35319](https://github.com/anthropics/claude-code/issues/35319)),
this retires gracefully. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design.

---

## The painpoint, concretely

You are a Claude Code skill author. You wrote a skill, people installed it,
and you want to know:

- Which steps are users actually getting through?
- Where does it fail?
- How many people use it daily/weekly?
- Did my last change make it worse?

You have answers to none of these because Claude Code doesn't surface
per-skill usage to authors. So you add a few hundred lines from this
template to your skill, point it at your own Supabase project, and you do.

## What this is NOT

- **Not a SaaS.** There's no central server. Every author runs their own
  Supabase project. The template gives you the code; you bring the
  database. Your users' data goes to YOU, not to us.
- **Not a global Claude Code observer.** This template instruments ONE
  skill at a time. If you want OS-level skill stats across all installed
  skills, that's a different design (and probably wants OpenTelemetry,
  not this).
- **Not an OpenTelemetry exporter.** It writes JSONL locally then POSTs
  batches to a Supabase edge function. If you need OTLP/Datadog/Snowflake,
  fork and replace `bin/telemetry-sync`.

---

## What gets recorded

Every skill run produces ONE row:

| Field             | Example                            | Purpose                       |
|-------------------|------------------------------------|-------------------------------|
| `ts`              | `2026-05-20T16:32:11Z`             | When                          |
| `skill`           | `my-cool-skill`                    | Which skill (you set this)    |
| `outcome`         | `success` / `error` / `abandoned`  | How it ended                  |
| `duration_s`      | `87`                               | How long it took              |
| `error_detail`    | `"supabase 500"` or null           | Short tag for failure         |
| `step`            | `"fetch-data"` or null             | Which step (if failed)        |
| `session_id`      | `abc-123`                          | Claude session                |
| `installation_id` | `fd0c3fb0-4087-...`                | Random UUID per user machine  |

`installation_id` is a UUID generated once on the user's machine. It does
NOT identify the human — there's no email, no IP, no hostname. It's there
so you can answer "how many distinct people use this" without identifying
any of them.

## Privacy stance for users (please reproduce in your skill's README)

> This skill records when it runs, how it went, and a random ID for your
> machine, and sends the row to the skill author's Supabase. To disable,
> set `SKILL_TELEMETRY=off` in your shell. Nothing else is collected. The
> data does not go to Anthropic.

Telemetry is **on by default**. We pick this knowing default-off would
floor adoption. The trade-off is honesty: tell users plainly, give them
one env var to flip it off, and don't bury the disclosure.

---

## Install

There are two paths. **Use the meta-skill** if you can — it's one prompt
to Claude and you answer one question.

### Path A — Meta-skill (recommended, ~2 minutes)

1. Clone this repo to a known location:

   ```bash
   git clone https://github.com/serenakeyitan/skill-telemetry ~/code/skill-telemetry
   ```

2. Install `add-telemetry` as a Claude Code skill:

   ```bash
   mkdir -p ~/.claude/skills
   ln -s ~/code/skill-telemetry/skills/add-telemetry ~/.claude/skills/add-telemetry
   ```

3. `cd` into your skill repo, open Claude Code, and say:

   > Use /add-telemetry to install telemetry for this skill.

4. Answer the one question (Supabase URL + anon key, paste both at
   once). Claude does the rest: copies files, writes config, generates
   the schema for you to paste, gives you the three deploy commands,
   substitutes paths into your SKILL.md, runs the smoke test, and
   reports success.

5. The meta-skill was tested over 4 iterations using subagents simulating
   real installs. Current score: **9/10 ready-to-ship** (the 1 missing
   point is "Supabase project creation still requires opening the
   dashboard once" — Claude can't sign up for an account on your behalf).

See `skills/add-telemetry/SKILL.md` for the full procedure.

### Path B — Manual install (~10 minutes)

Skip this if you used Path A. This is for: (a) you don't trust the
meta-skill and want to see every step, (b) you want to integrate this
into automated CI/CD without Claude in the loop.

You'll need:

- A Supabase account (free tier is fine)
- The Supabase CLI installed (`brew install supabase/tap/supabase`)
- A skill repo to add this to

### Step 1 — Create a Supabase project

1. Go to https://supabase.com/dashboard, click **New project**.
2. Pick a name, region, password. Wait ~2 min for provisioning.
3. Once ready, go to **Settings → API**. You'll need two values from
   this page in Step 4:
   - **Project URL** (looks like `https://abc123.supabase.co`)
   - **anon public** key

### Step 2 — Run the schema

1. In your Supabase dashboard, go to **SQL Editor → New query**.
2. Paste the contents of [`supabase/schema.sql`](./supabase/schema.sql).
3. Click **Run**. You should see no errors. (It's idempotent — safe to
   re-run.)

Verify by going to **Table Editor**. You should see a `skill_events`
table.

### Step 3 — Copy this template into your skill repo

```bash
# pick a working directory outside your skill repo
git clone https://github.com/serenakeyitan/skill-telemetry.git /tmp/skill-telemetry

# from inside your skill repo
mkdir -p telemetry
cp -r /tmp/skill-telemetry/bin              telemetry/
cp -r /tmp/skill-telemetry/supabase         telemetry/
cp    /tmp/skill-telemetry/SKILL.md.snippet telemetry/
cp    /tmp/skill-telemetry/PRIVACY.md       telemetry/
chmod +x telemetry/bin/*
```

The layout is flat on purpose so you can copy just the bits you want.

### Step 4 — Wire your Supabase credentials

```bash
cd telemetry
cp supabase/config.sh.example supabase/config.sh
```

Edit `supabase/config.sh` and paste the **Project URL** and **anon public**
key from Step 1.

Yes, you commit this file. The anon key is meant to be public; it can't
read data (RLS denies everything), and the actual inserts happen through
the edge function using a service-role key that lives in Supabase secrets.

### Step 5 — Deploy the edge function

```bash
cd telemetry  # the directory you copied this into
supabase login                                   # one time
supabase link --project-ref YOUR-PROJECT-REF     # from your dashboard URL
supabase functions deploy skill-telemetry-ingest --no-verify-jwt
```

`--no-verify-jwt` is required because the script authenticates via the
anon key, not a per-user JWT.

Verify by curling:

```bash
curl -X POST "$SKILL_TELEMETRY_SUPABASE_URL/functions/v1/skill-telemetry-ingest" \
  -H "Content-Type: application/json" \
  -H "apikey: $SKILL_TELEMETRY_ANON_KEY" \
  -H "Authorization: Bearer $SKILL_TELEMETRY_ANON_KEY" \
  -d '[{"skill":"setup-test","outcome":"success","ts":"2026-05-20T00:00:00Z"}]'
```

Expected: `ok (1 inserted)`.

Then check **Table Editor → skill_events** — your test row should be there.

### Step 6 — Wire your SKILL.md

Open your skill's `SKILL.md`. Paste the contents of
[`SKILL.md.snippet`](./SKILL.md.snippet) at the END of the file. Replace
`YOUR-SKILL-NAME` everywhere with your actual skill name (e.g. `real-stars`,
`fetch-pr`, whatever).

### Step 7 — Local end-to-end test

```bash
# Simulate a successful skill run
SKILL_TELEMETRY_DIR=/tmp/skill-test \
  ./telemetry/bin/telemetry-log --skill setup-test --outcome success --duration 5

# Trigger immediate sync (bypass rate limit)
rm -f /tmp/skill-test/telemetry/.last-sync
SKILL=setup-test SKILL_TELEMETRY_DIR=/tmp/skill-test \
  ./telemetry/bin/telemetry-sync

# Check it landed in Supabase
# Go to dashboard → Table Editor → skill_events → you should see your row
```

If you see the row in Supabase, you're done. Real skill invocations will
record automatically once your users install the new SKILL.md.

---

## Updating telemetry across all your skills

When skill-telemetry ships a new release, `bin/skill-telemetry-update`
pulls the latest bin/ + snippet/ + PRIVACY files and overwrites every
installed skill's copy in `~/.claude/skills/*/telemetry/`. Idempotent.

```bash
# Preview what would change
bin/skill-telemetry-update --dry-run

# Apply (also git pulls source first)
bin/skill-telemetry-update

# Skip certain skills
bin/skill-telemetry-update --skip tdoc --skip real-stars

# Only update specific skills
bin/skill-telemetry-update --include tdoc

# Use a different source dir
bin/skill-telemetry-update --source /opt/skill-telemetry

# Skip the git pull (use whatever's already in source)
bin/skill-telemetry-update --no-pull
```

The script fires a `consent_granted` lifecycle event tagged
`skill=skill-telemetry` with `step=updated_<N>_skills` so the
maintainer sees who's running updates and how many skills got
upgraded. (You can see this in your own pool too — it's per-author.)

What it touches per skill:
- `telemetry/bin/*` (telemetry-log, telemetry-sync, telemetry-update-check, skill-events)
- `telemetry/SKILL.md.snippet`
- `telemetry/PRIVACY.md`

What it preserves:
- `telemetry/supabase/config.sh` (your per-skill author config)
- `<skill>/SKILL.md` (host skill — never touched)
- `<skill>/VERSION`

## Querying your data

### From your terminal (local timezone)

The repo ships with `bin/skill-events` — auto-detects your local
timezone, formats events as a table, supports filters:

```bash
bin/skill-events                          # last 20 events in your TZ
bin/skill-events --tz Asia/Shanghai       # override TZ
bin/skill-events --skill tdoc --limit 50  # filter to one skill
bin/skill-events --failures               # only error/abandoned
```

Output:

```
TZ: America/Los_Angeles

TIME                 SKILL  OUTCOME  STEP  DUR  ERR
----                 -----  -------  ----  ---  ---
2026-05-21 00:25:46  tdoc   success  new   2
2026-05-20 23:27:31  tdoc   success  edit  142
```

Requires `SUPABASE_ACCESS_TOKEN` (or `supabase login` once — macOS
keychain is read automatically). Config (URL + anon key) is auto-found
from any installed skill's `telemetry/supabase/config.sh`.

### From Supabase SQL Editor

The schema ships with three views + one timezone-aware function:

```sql
-- Local-time view (best practice: storage stays UTC, display converts)
select * from skill_events_in_tz('America/Los_Angeles') limit 20;
select * from skill_events_in_tz('Asia/Shanghai') limit 20;

-- Which skills are used the most?
select * from skill_usage_summary;

-- What breaks?
select * from skill_failure_modes limit 20;

-- Daily activity for the last 30 days
select * from skill_daily_usage where day > now() - interval '30 days';
```

For prettier dashboards, point any of these at Grafana / Metabase / a
spreadsheet via Supabase's read-only DB connection (Settings → Database
→ Connection string).

### A note on timezones

`skill_events.ts` is a `timestamptz` storing UTC. This is intentional —
your users span timezones and only UTC is unambiguous for sorting,
comparing, and aggregating. Convert to local time **only at the
display boundary** using `skill_events_in_tz(tz)` or the `bin/skill-events`
helper.

---

## What it costs you

- **Supabase free tier**: 500 MB database, 2 GB egress, 500K edge function
  invocations/month. A skill with 1,000 daily users sending one row each
  = 30K rows/mo ≈ 5 MB/year. You will not exceed the free tier on a
  hobby skill.
- **One-time setup**: 10 min.
- **Per-skill ongoing**: zero. Once shipped, it runs.

---

## Troubleshooting

**"No data showing up in Supabase"**
1. Check `~/.<your-skill>/telemetry/*.jsonl` on the user's machine. If
   it's empty, the skill isn't calling `telemetry-log` (probably a
   SKILL.md formatting issue).
2. Check `~/.<your-skill>/telemetry/.cursor-*`. If it's at 0, sync
   hasn't pushed anything. Run `telemetry-sync` manually with
   `SKILL_TELEMETRY_RATE_MINUTES=0` to bypass rate limit.
3. Check the edge function logs in Supabase: **Edge Functions →
   skill-telemetry-ingest → Logs**.

**"I want to wipe a user's data"**
GDPR-style delete by installation_id:
```sql
delete from skill_events where installation_id = '<uuid>';
```
The user can find their own ID at `~/.<your-skill>/telemetry/installation-id`.

**"How do I uninstall?"**
There's nothing to uninstall — the scripts only run when your SKILL.md
tells Claude to run them. Remove the telemetry section from SKILL.md and
delete the `telemetry/` directory. Users can `rm -rf ~/.<your-skill>/`.

---

## Why per-skill, not global?

See [ARCHITECTURE.md](./ARCHITECTURE.md). Short version: Claude Code's
Stop hook doesn't include the skill name, and inferring it from
transcripts is unreliable. Having the skill explicitly self-report is
the only architecture that's accurate per-skill, and it sidesteps the
big open question of issue #35319.

## How reliable is it? (read this before adopting)

Honest answer: **not 100%, but self-healing.**

The telemetry is recorded by your skill's own SKILL.md — Claude (the
model) executes it. Claude *can* skip it: especially for proactive
skills (auto-invoked, not run as step-by-step workflows), Claude
sometimes does the work and skips the telemetry block as "boilerplate".

This kit fights that with three layers, in increasing order of
reliability and footprint:

1. **Framing** — the SKILL.md telemetry blocks are written as
   mandatory, numbered Steps with an explicit "treat this as
   executable instructions" directive, which sharply cuts the skip rate.
2. **Self-healing `.pending` marker** — the preamble writes a marker;
   the final step deletes it. If Claude skips the final step, the
   marker is left behind, and the *next* run reaps it — recording the
   skipped run as `outcome=unknown`. So a skipped run becomes a
   degraded event, not a vanished one.
3. **Opt-in Stop hook** — for skills where layers 1+2 still leak too
   much (typically proactive auto-invoked skills), an opt-in Stop hook
   captures every session end deterministically at the Claude Code
   runtime layer. The hook is **not** installed by default.

### Opt-in Stop hook (for proactive skills)

If empirical data shows your skill skips telemetry frequently (many
`outcome=unknown` reaped events, or fewer events than you know
happened), opt into the Stop hook:

```bash
bin/telemetry-hook-install --skill <your-skill-name>          # install
bin/telemetry-hook-install --skill <your-skill-name> --dry-run # preview
bin/telemetry-hook-uninstall --skill <your-skill-name>         # remove
```

### ⚠️ Ethical use: only install hooks for skills you author

The hook architecture is per-skill on purpose. Install hooks **only for
skills you wrote and are responsible for**. Examples:

| Scenario | OK? |
|---|---|
| You wrote `tdoc`. You install a hook for `tdoc`. | ✅ Yes — your skill, your data |
| You wrote `tdoc` and `real-stars`. You install hooks for both. | ✅ Yes — your suite, your data, one Supabase pool |
| You did NOT write `gstack`. You install a hook for `gstack` to see how others use it. | ❌ **No.** That's surveillance of someone else's skill. The gstack author owns that data, not you. |
| You did NOT write `office-hours`. You want to track when *you yourself* use it. | ⚠️ Better tool exists — this kit isn't designed for personal time-tracking. Build a separate tool that writes to your own local SQLite. |

**Why this matters.** Skill-telemetry's value depends on each skill
author having a clean, owned dataset for their own skill. Installing
a hook for a skill you didn't write means your Supabase quietly
collects usage of someone else's tool — bypassing their consent
model and potentially breaking your users' expectations when they
installed *that* skill. Don't do it.

The hook is built with five responsibility practices, because it's
runtime-enforced and reads from the session transcript:

1. **Opt-in only.** Never auto-installed; requires explicit user action.
2. **Skill-name filtered.** The hook for skill `tdoc` only fires when
   tdoc was actually invoked in that session. Sessions that ran only
   `office-hours` produce zero `tdoc` events.
3. **Minimal collection.** The hook scans the transcript for `Skill`
   tool-call names and the last 5 lines for outcome heuristics. It
   does NOT read your prompts, Claude's replies, file contents, or
   any other transcript content. Read `bin/telemetry-hook` to verify.
4. **Clean uninstall.** `telemetry-hook-uninstall` removes the entry
   from `~/.claude/settings.json` by its marker, preserving every
   other hook untouched.
5. **Master kill-switch.** `export SKILL_TELEMETRY=off` suspends both
   SKILL.md telemetry AND the hook with one env var.

The trade-off: the hook edits `~/.claude/settings.json` (your global
Claude Code config). The install script backs it up before each change
and validates the resulting JSON. If install ever leaves the file
invalid, the backup is restored automatically.

## Acknowledgements

The cursor-based sync (write-locally-first, batch-push, never
double-send), the `.pending` self-healing marker, and the
"treat the skill file as executable instructions" framing are all
borrowed from [gstack](https://github.com/garrytan/gstack). This
template adapts them to single-skill use and removes gstack's
multi-tier model.

## License

MIT. See [LICENSE](./LICENSE).
