# skill-telemetry

A drop-in telemetry kit for a single Claude Code skill, so the author
can see how their skill is actually being used and what breaks.

**Status**: Early, working, opinionated. Read [ARCHITECTURE.md](./ARCHITECTURE.md)
for why it's designed this way.

**License**: MIT. If Anthropic ships official skill analytics (see
[anthropics/claude-code#35319](https://github.com/anthropics/claude-code/issues/35319)),
this retires gracefully.

---

## Who this is for

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

## Dashboards (queries you'll actually run)

The schema ships with three views. In Supabase SQL Editor:

```sql
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
the only architecture that's actually accurate, and it sidesteps the
big open question of issue #35319.

## Acknowledgements

The telemetry-sync cursor pattern (write-locally-first, batch-push, never
double-send) is borrowed from [gstack](https://github.com/garrytan/gstack)'s
implementation. This template adapts it to single-skill use and removes
gstack's multi-tier model.

## License

MIT. See [LICENSE](./LICENSE).
